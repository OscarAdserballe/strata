// node tools/perf/report.mjs DIR... [--profiles-top N] [--drop DIR:PREFIX]: summarise runs as markdown
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { stats } from "./lib/harness.mjs";
import { loadMaps } from "./lib/sourcemap.mjs";
import { REPO } from "./pw.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const dirs = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const TOP = Number(opt("profiles-top", 15));
const recs = [];
for (const d of dirs) {
  const f = join(d, "results.jsonl"); if (!existsSync(f)) continue;
  for (const l of readFileSync(f, "utf8").trim().split("\n")) { if (!l) continue; const r = JSON.parse(l); r._dir = d; recs.push(r); }
}
const drop = opt("drop", null);
if (drop) {
  const [dn, pre] = drop.split(":");
  for (let i = recs.length - 1; i >= 0; i--) if (basename(recs[i]._dir) === dn && String(recs[i].scenario).startsWith(pre)) recs.splice(i, 1);
}
const ok = recs.filter((r) => !r.error);
const timed = ok.filter((r) => r.run !== "profiled");
const LEGEND = {
  "home/cold": "navigation start → library rows in the DOM",
  "home/sw:first-visit": "SW allowed, first visit: nav start → library rows",
  "home/sw:sw-controlled": "SW allowed, reload controlled by the worker (it fills its caches)",
  "home/sw:sw-warm": "SW allowed, third visit: page from the saved copy, boot reads from the snapshot",
  "board/first": "click board name on home → board page (rail + front) shown",
  "board/again": "back to home, click again (board seen before in this page)",
  "pdf-large/cold": "nav start (deep link) → the page in view has its canvas + text layer, and keeps it",
  "pdf-large/reopen": "in-app nav A→B→A: popstate → page in view inked again",
  "pdf-marked/cold": "nav start (deep link) → the page in view has its canvas + text layer, and keeps it",
  "pdf-marked/reopen": "in-app nav A→B→A: popstate → page in view inked again",
  "pdf-marked/sw:first": "SW allowed: nav → page in view inked",
  "pdf-marked/sw:reload": "SW allowed: reload → page in view inked",
  "scroll-large/steps": "mean per programmatic jump → target page canvas + text layer",
  "scroll-marked/steps": "mean per programmatic jump → target page canvas + text layer",
  "scroll-large/wheel": "3 s wheel: jank ms (Σ(frame−16.7) over frames >50 ms)",
  "scroll-marked/wheel": "3 s wheel: jank ms (Σ(frame−16.7) over frames >50 ms)",
  "prose/cold": "nav start → prose blocks in the DOM",
  "prose/wheel": "3 s wheel: jank ms",
  "chat/focus-opens-thread": "click chat line → first thread turn in the DOM",
  "chat/keystroke": "per key: keydown → next frame (pooled over all keys)",
  "flip-prose/key-n": "`n` (next card) on the large prose source: keydown → next frame (pooled)",
  "flip-pdf/key-n": "`n` (next card) on the 240-mark PDF: keydown → next frame (pooled)",
  "cards-only/toggle": "`o` (cards only) a second time, its decks kept: keydown → the pooled deck's line drawn",
  "highlight/p13": "click Highlight in the selection menu → the new mark's box in the DOM",
  "idle/home": "commits in 10 s idle",
  "idle/pdf": "commits in 10 s idle",
  "idle/pdf-chat": "commits in 10 s idle, chat thread open",
};
const keyOf = (r) => `${r.scenario}/${r.variant}`;
const groups = new Map();
for (const r of timed) {
  const k = `${r.engine}|${r.react || "prod"}|${keyOf(r)}|${r.throttle}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const G = (engine, react, sv, th) => groups.get(`${engine}|${react}|${sv}|${th}`) || [];
const med = (rs, f) => stats(rs.map(f)).median;
const mp = (rs, f) => { const s = stats(rs.map(f)); return s.n ? `${s.median} / ${s.p90}` : "–"; };
const pooled = (rs) => { const all = rs.flatMap((r) => (r.extra && r.extra.keyLat) || []); const s = stats(all); return s.n ? `${s.median} / ${s.p90}` : null; };
const primary = (rs) => pooled(rs) || mp(rs, (r) => r.t.ms);
const order = [...new Set(timed.map(keyOf))];
const kb = (b) => (b == null ? "–" : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

const out = [];
const P = (s = "") => out.push(s);
P(`# Strata client perf — ${new Date().toISOString().slice(0, 16)}Z`);
P(`runs: ${dirs.map((d) => basename(d)).join(", ")}  ·  records: ${recs.length} (${recs.length - ok.length} errors)`);
P();
P("## Summary (median / p90, ms)");
P("| scenario/variant | what | Chromium 1x | Chromium 4x | long tasks 4x (n / ms) | commits (1x) | React task ms 1x/4x | req / bytes (1x) | script / layout ms (4x) | WebKit |");
P("|---|---|---|---|---|---|---|---|---|---|");
for (const sv of order) {
  const c1 = G("chromium", "prod", sv, 1), c4 = G("chromium", "prod", sv, 4), wk = G("webkit", "prod", sv, 1);
  if (!c1.length && !c4.length && !wk.length) continue;
  P(`| ${sv} | ${LEGEND[sv] || ""} | ${c1.length ? primary(c1) : "–"} | ${c4.length ? primary(c4) : "–"} | ${c4.length ? `${med(c4, (r) => r.w.longtasks.n)} / ${med(c4, (r) => r.w.longtasks.ms)}` : "–"} | ${c1.length ? med(c1, (r) => r.w.commits) : "–"} | ${c1.length ? med(c1, (r) => r.w.reactTaskMs) : "–"} / ${c4.length ? med(c4, (r) => r.w.reactTaskMs) : "–"} | ${c1.length ? `${med(c1, (r) => r.w.requests)} / ${kb(med(c1, (r) => r.w.bytes))}` : "–"} | ${c4.length && c4[0].w.cpu ? `${med(c4, (r) => r.w.cpu.ScriptDuration)} / ${med(c4, (r) => r.w.cpu.LayoutDuration)}` : "–"} | ${wk.length ? primary(wk) : "–"} |`);
}
P();
P("n per cell = runs; throttle via CDP Emulation.setCPUThrottlingRate (main thread only — the pdf.js worker is NOT throttled).");
P();
P("## Sub-timings (median / p90 ms)");
for (const sv of order) {
  const rows = [["chromium", 1], ["chromium", 4], ["webkit", 1]].map(([e, th]) => [e, th, G(e, "prod", sv, th)]).filter((x) => x[2].length);
  if (!rows.length) continue;
  const keys = [...new Set(rows.flatMap((x) => x[2].flatMap((r) => Object.keys(r.t))))].filter((k) => k !== "ms");
  if (!keys.length) continue;
  P(`### ${sv}  (${LEGEND[sv] || ""})`);
  P(`| engine | ${keys.join(" | ")} |`); P(`|---|${keys.map(() => "---").join("|")}|`);
  for (const [e, th, rs] of rows) P(`| ${e} ${th}x (n=${rs.length}) | ${keys.map((k) => mp(rs, (r) => r.t[k])).join(" | ")} |`);
  const ex = rows[0][2][0].extra;
  if (ex) P(`extra (first ${rows[0][0]} ${rows[0][1]}x run): \`${JSON.stringify({ ...ex, keyLat: undefined, commitTimes: undefined, events: undefined }).slice(0, 700)}\``);
  const c4 = G("chromium", "prod", sv, 4)[0];
  if (c4 && c4.extra) P(`extra (first chromium 4x run): \`${JSON.stringify({ ...c4.extra, keyLat: undefined, commitTimes: undefined, events: undefined }).slice(0, 700)}\``);
  P();
}

const prof = ok.filter((r) => r.react === "profiling");
if (prof.length) {
  P("## React commits by component (react-dom/profiling build — attribution only)");
  for (const sv of [...new Set(prof.map(keyOf))]) {
    const rs = prof.filter((r) => keyOf(r) === sv);
    const agg = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.w.components || {})) { agg[k] = agg[k] || { renders: 0, selfMs: 0 }; agg[k].renders += v.renders / rs.length; agg[k].selfMs += v.selfMs / rs.length; }
    const top = Object.entries(agg).sort((a, b) => b[1].selfMs - a[1].selfMs).slice(0, 8);
    const cm = rs.map((r) => r.w.commitMs);
    P(`- **${sv}** (${rs[0].throttle}x, n=${rs.length}): commits ${stats(rs.map((r) => r.w.commits)).median}, Σ actualDuration ${stats(cm.map((c) => c.sum)).median} ms, max commit ${stats(cm.map((c) => c.max)).median} ms — ${top.map(([k, v]) => `${k} ×${Math.round(v.renders)} ${v.selfMs.toFixed(1)}ms`).join(", ")}`);
  }
  P();
}

P("## CPU profile hotspots (resolved through source maps)");
for (const d of dirs) {
  const pd = join(d, "profiles"); if (!existsSync(pd)) continue;
  for (const f of readdirSync(pd).filter((x) => x.endsWith(".json")).sort()) {
    if (drop && basename(d) === drop.split(":")[0] && f.startsWith(drop.split(":")[1])) continue;
    const a = JSON.parse(readFileSync(join(pd, f), "utf8"));
    P(`### ${f.replace(/\.json$/, "")} — busy ${a.busyMs} ms`);
    P(`buckets: ${a.buckets.slice(0, 8).map((b) => `${b.bucket} ${b.pct}%`).join(" · ")}`);
    P(); P("| self ms | % | function (original file:line) |"); P("|---|---|---|");
    for (const r of a.self.slice(0, TOP)) P(`| ${r.ms} | ${r.pct} | \`${r.key}\` ${r.snippet ? "— `" + r.snippet.replace(/\|/g, "\\|").slice(0, 70) + "`" : ""} |`);
    P(); P("| inclusive ms | % | app function |"); P("|---|---|---|");
    for (const r of (a.totalApp || []).slice(0, TOP)) P(`| ${r.ms} | ${r.pct} | \`${r.key}\` |`);
    P(); P("| charged ms | % | innermost app frame |"); P("|---|---|---|");
    for (const r of (a.owners || []).slice(0, 10)) P(`| ${r.ms} | ${r.pct} | \`${r.key}\` |`);
    P();
  }
}

const maps = loadMaps(join(REPO, "dist"), REPO);
const loafAgg = {};
for (const r of timed.filter((x) => x.engine === "chromium" && x.react !== "profiling")) {
  for (const l of r.w.loafs || []) for (const s of l.scripts || []) {
    const at = s.url && s.pos >= 0 ? maps.resolveChar(s.url, s.pos) : null;
    const k = `${keyOf(r)} ${r.throttle}x ← ${s.inv}${at ? ` @ ${at.source}:${at.line}` : s.url ? ` @ ${basename(new URL(s.url).pathname)}` : ""}`;
    loafAgg[k] = loafAgg[k] || { n: 0, ms: 0, runs: new Set() }; loafAgg[k].n++; loafAgg[k].ms += s.d; loafAgg[k].runs.add(r._dir + r.run);
  }
}
P("## Long animation frames by script entry point (Chromium, all timed runs)");
P("| scenario · invoker @ source | scripts | Σ ms | runs |"); P("|---|---|---|---|");
for (const [k, v] of Object.entries(loafAgg).sort((a, b) => b[1].ms - a[1].ms).slice(0, 30)) P(`| ${k.replace(/\|/g, "\\|")} | ${v.n} | ${Math.round(v.ms)} | ${v.runs.size} |`);
P();

const idle = ok.filter((r) => r.scenario === "idle");
if (idle.length) {
  P("## Idle");
  for (const r of idle) {
    P(`- **${r.variant}** (${r.engine} ${r.throttle}x): ${r.t.commits10s} commits in 10 s, ${r.t.commits30s} in 30 s; ${r.t.requests30s} requests in 30 s; React task ms ${r.w.reactTaskMs}`);
    for (const [p, at] of Object.entries(r.extra.requests || {})) {
      const iv = at.slice(1).map((t, i) => t - at[i]);
      P(`  - \`${p}\` ×${at.length} at ${at.slice(0, 10).join(", ")} ms${iv.length ? ` (intervals ~${stats(iv).median} ms)` : ""}`);
    }
    const ct = r.extra.commitTimes || [];
    if (ct.length) P(`  - commit times (ms into window): ${ct.slice(0, 40).join(", ")}${ct.length > 40 ? " …" : ""}`);
  }
  P();
}

const errs = {};
for (const r of recs) {
  if (r.error) errs[`RUN FAILED ${r.scenario} ${r.engine} ${r.throttle}x: ${r.error.split("\n")[0]}`] = (errs[`RUN FAILED ${r.scenario} ${r.engine} ${r.throttle}x: ${r.error.split("\n")[0]}`] || 0) + 1;
  for (const e of r.pageErrors || []) errs[`pageerror ${r.scenario}: ${e}`] = (errs[`pageerror ${r.scenario}: ${e}`] || 0) + 1;
  for (const [m, n] of Object.entries(r.console || {})) {
    if (/Service Worker registration blocke/.test(m)) continue;
    const k = `${r.engine} ${r.scenario}: ${m.replace(/[0-9]+/g, "#")}`; // repeats differing only by numbers are one line
    errs[k] = (errs[k] || 0) + n;
  }
}
P("## Console errors / warnings / failures (grouped, digits → #)");
for (const [k, n] of Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 40)) P(`- ×${n} ${k.slice(0, 260)}`);
console.log(out.join("\n"));
