import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// node tools/smoke-all.mjs [base] [--shard i/n]: run every browser smoke suite, or every n-th from the i-th.
const argv = process.argv.slice(2);
const base = (argv.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:8804").replace(/\/+$/,"");
const shardArg = argv.includes("--shard") ? argv[argv.indexOf("--shard") + 1] : null;
const shard = shardArg ? shardArg.split("/").map(Number) : null;
if (shard && !(shard[1] >= 1 && shard[0] >= 1 && shard[0] <= shard[1])) { console.error(`--shard wants i/n with 1 ≤ i ≤ n, not ${shardArg}`); process.exit(2); }
const all = ["smoke","nav-smoke","review-smoke","offline-smoke","import-smoke","home-smoke","tidy-smoke","cleanup-smoke","board-load-smoke","reading-position-smoke","capture-smoke","library-smoke","attribution-smoke","attach-smoke","live-smoke"];
const suites = all.filter((_, k) => !shard || k % shard[1] === shard[0] - 1);
for (const suite of suites) {
  console.log(`\nRunning ${suite}`);
  const result = spawnSync(process.execPath,[fileURLToPath(new URL(`./${suite}.mjs`,import.meta.url)),base],{stdio:"inherit"});
  if (result.error || result.status!==0) {
    console.error(`${suite} failed`,result.error?.message || result.signal || "");
    process.exit(result.status || 1);
  }
}
console.log(`\nAll ${suites.length} smoke suites passed${shard ? ` (shard ${shard[0]}/${shard[1]} of ${all.length})` : ""}.`);
