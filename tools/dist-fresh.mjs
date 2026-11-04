// node tools/dist-fresh.mjs: exit 1 unless dist/ was built from the source on disk now.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDS = ["main", "bridge"];
// node_modules is pinned by the lockfile, so hashing that is enough and keeps the check fast
const ALWAYS = ["tools/build.mjs", "package-lock.json"];
const hashOf = (file) => existsSync(file) ? createHash("sha1").update(readFileSync(file)).digest("hex").slice(0, 12) : "missing";
const stampFile = (repo, name) => join(repo, "dist", `sources.${name}.json`);

/** Record what one build read, so staleDist can tell when any of it has changed. */
export function writeSources(name, metafile, repo = REPO) {
  const inputs = [...new Set([...ALWAYS, ...Object.keys(metafile.inputs).filter((p) => !p.startsWith("node_modules/"))])].sort();
  writeFileSync(stampFile(repo, name), JSON.stringify(Object.fromEntries(inputs.map((p) => [p, hashOf(join(repo, p))]))));
}

/** Why dist/ does not match the source on disk, or null when it does. */
export function staleDist(repo = REPO) {
  for (const name of BUILDS) {
    const file = stampFile(repo, name);
    if (!existsSync(file)) return "dist/ has no build (or one from before tools/build.mjs recorded its sources)";
    for (const [p, hash] of Object.entries(JSON.parse(readFileSync(file, "utf8")))) {
      if (hashOf(join(repo, p)) !== hash) return `dist/ was built before the last change to ${p}`;
    }
  }
  return null;
}

/** Throw with what to run when dist/ is stale, so no server starts on an old client. */
export function assertFreshDist(repo = REPO) {
  const why = staleDist(repo);
  if (why) throw new Error(`${why} — run node tools/build.mjs (or npm run build) first`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const why = staleDist();
  if (why) { console.error(`✗ ${why} — run node tools/build.mjs`); process.exit(1); }
}
