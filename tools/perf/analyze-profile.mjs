// node tools/perf/analyze-profile.mjs FILE.cpuprofile [--dist DIR] [--top N] [--json]: resolve via source maps
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMaps, analyzeProfile } from "./lib/sourcemap.mjs";
import { REPO } from "./pw.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const file = argv.find((a) => a.endsWith(".cpuprofile"));
if (!file) { console.error("usage: node analyze-profile.mjs FILE.cpuprofile [--dist DIR] [--top N] [--json]"); process.exit(2); }
const maps = loadMaps(opt("dist", join(REPO, "dist")), REPO);
const a = analyzeProfile(JSON.parse(readFileSync(file, "utf8")), maps, { top: Number(opt("top", 15)) });
if (argv.includes("--json")) { console.log(JSON.stringify(a, null, 2)); process.exit(0); }
export function printAnalysis(x, log = console.log) {
  log(`busy ${x.busyMs} ms (idle ${x.idleMs} ms)`);
  log("owner buckets:"); for (const b of x.buckets) log(`  ${String(b.ms).padStart(8)} ms ${String(b.pct).padStart(5)}%  ${b.bucket}`);
  const list = (title, rows) => { log(title); for (const r of rows) log(`  ${String(r.ms).padStart(8)} ms ${String(r.pct).padStart(5)}%  ${r.key}${r.snippet ? "   ⟨" + r.snippet + "⟩" : ""}`); };
  list("self time:", x.self);
  list("inclusive, app functions:", x.totalApp || []);
  list("charged to innermost app frame:", x.owners || []);
}
printAnalysis(a);
