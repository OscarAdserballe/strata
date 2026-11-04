// node tools/perf/ab.mjs --a URL --b URL [--scenarios a,b] [--rounds N]: A/B two servers, interleaved by round
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const A = opt("a", "http://127.0.0.1:8806"), B = opt("b", "http://127.0.0.1:8807");
const scenarios = opt("scenarios", "home,board");
const rounds = Number(opt("rounds", 5)), throttle = opt("throttle", "4"), engine = opt("engine", "chromium");
const failPct = Number(opt("fail-pct", 0)), failMs = Number(opt("fail-ms", 0));
const latency = opt("latency", null);
const outRoot = join(HERE, "out", `ab-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(outRoot, { recursive: true });

// alternate which side goes first, so neither always runs on the warmer machine
for (let r = 0; r < rounds; r++) {
  for (const [name, base] of (r % 2 ? [["B", B], ["A", A]] : [["A", A], ["B", B]])) {
    const res = spawnSync(process.execPath, [join(HERE, "run.mjs"), "--base", base, "--engine", engine, "--scenarios", scenarios,
      "--runs", "1", "--throttle", throttle, ...(latency ? ["--latency", latency] : []), "--out", join(outRoot, `${name}-${r}`)], { stdio: ["ignore", "ignore", "inherit"] });
    if (res.status !== 0) console.error(`round ${r} ${name} exited ${res.status}`);
  }
}

const rows = { A: {}, B: {} };
for (const name of ["A", "B"]) for (let r = 0; r < rounds; r++) {
  const f = join(outRoot, `${name}-${r}`, "results.jsonl");
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const x = JSON.parse(line);
    if (x.error) continue;
    (rows[name][`${x.scenario}/${x.variant}@${x.throttle}x`] ??= []).push(x);
  }
}
const med = (a) => { const s = a.filter((v) => typeof v === "number").sort((p, q) => p - q); return s.length ? s[s.length >> 1] : null; };
const pick = {
  ms: (x) => x.t?.ms, commits: (x) => x.t?.commits30s ?? x.w?.commits, taskMs: (x) => x.w?.cpu?.TaskDuration,
  layouts: (x) => x.w?.cpu?.LayoutCount, long: (x) => x.w?.longtasks?.ms, reqs: (x) => x.t?.requests30s ?? x.w?.requests,
};
const keys = [...new Set([...Object.keys(rows.A), ...Object.keys(rows.B)])].sort();
const fmt = (v) => (v == null ? "–" : String(Math.round(v * 10) / 10));
const table = ["scenario".padEnd(34) + Object.keys(pick).map((k) => `${k} A→B`.padStart(20)).join("")];
for (const k of keys) {
  table.push(k.padEnd(34) + Object.values(pick).map((f) =>
    `${fmt(med((rows.A[k] || []).map(f)))} → ${fmt(med((rows.B[k] || []).map(f)))}`.padStart(20)).join(""));
}
console.log(table.join("\n"));
console.log(`\nraw: ${outRoot}`);

const worse = [];
for (const k of keys) {
  if (k.startsWith("idle/")) continue;          // idle's "ms" is a count, judged by the budgets
  const a = med((rows.A[k] || []).map(pick.ms)), b = med((rows.B[k] || []).map(pick.ms));
  if (failPct && a != null && b != null && b > a * (1 + failPct / 100) && b - a > failMs) worse.push(`${k}: ${fmt(a)} → ${fmt(b)} ms`);
}
if (worse.length) console.log(`\nslower than the baseline by more than ${failPct}% and ${failMs} ms:\n  ${worse.join("\n  ")}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const fence = "```";
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `## Timing against main (${rounds} interleaved rounds, ${throttle}× CPU)`, "", fence, ...table, fence, "",
    worse.length ? `**Slower:** ${worse.join("; ")}` : "No scenario slower beyond the threshold.", "",
  ].join("\n"));
}
process.exit(worse.length ? 1 : 0);
