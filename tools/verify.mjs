// node tools/verify.mjs [--quick] [--only types|lint|unit|browser|race|perf]: run the checks a change needs.
import { spawnSync } from "node:child_process";
import { REPO, QUIET_ENV, freePort, serveRoom } from "./race/serve.mjs";

const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const quick = argv.includes("--quick");
const PORT = Number(process.env.VERIFY_PORT) || await freePort();
const PERF_PORT = await freePort();
const NODE = process.execPath;
const quiet = QUIET_ENV;

const stages = [
  ["types", () => run("npx", ["tsc", "--noEmit"])],
  ["lint", () => run("npm", ["run", "lint", "--silent"])],
  ["unit", () => run("npm", ["test", "--silent"])],
  ["browser", browser],
  ["race", race],
  ["perf", () => run(NODE, ["tools/perf/budgets.mjs", "--serve", `http://127.0.0.1:${PERF_PORT}`])],
];
const wanted = stages.filter(([name]) => only ? name === only : !quick || ["types", "lint", "unit"].includes(name));
if (!wanted.length) { console.error(`unknown stage: ${only}`); process.exit(2); }

function run(cmd, args, env = quiet) {
  // npm/npx are .cmd shims that need a shell on Windows; node must not get one, or a path with a space splits
  const shell = process.platform === "win32" && (cmd === "npm" || cmd === "npx");
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: "inherit", env, shell });
  return r.status === 0;
}

let built = null;
const build = () => (built ??= run(NODE, ["tools/build.mjs"]));

async function browser() {
  if (!build()) return false;
  let room;
  try { room = await serveRoom({ port: PORT, label: "verify" }); }
  catch (e) { console.error(e.message); return false; }
  try {
    if (!run(NODE, ["tools/smoke-all.mjs", room.base])) return false;
    return run(NODE, ["tools/pdf-scroll-check.mjs", room.base, "chromium"]);
  } finally { await room.stop(); }
}

// the race gate serves its own fresh room: its scenarios write enough to disturb the smokes'
function race() {
  if (!build()) return false;
  return run(NODE, ["tools/race/run.mjs"]);
}

const results = [];
for (const [name, fn] of wanted) {
  const started = performance.now();
  console.log(`\n━━ ${name} ━━`);
  const ok = await fn();
  results.push([name, ok, Math.round((performance.now() - started) / 1000)]);
  if (!ok) break;
}
console.log("\n━━ verify ━━");
for (const [name, ok, s] of results) console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(8)} ${s}s`);
const failed = results.some(([, ok]) => !ok) || results.length < wanted.length;
console.log(failed ? "\nverify FAILED" : "\nverify passed");
process.exit(failed ? 1 : 0);
