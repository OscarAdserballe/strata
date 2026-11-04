import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleDist, writeSources } from "./dist-fresh.mjs";

function repo(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "strata-fresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const d of ["dist", "tools", "web"]) mkdirSync(join(dir, d));
  for (const f of ["tools/build.mjs", "package-lock.json", "web/main.tsx", "web/bridge.ts"]) writeFileSync(join(dir, f), f);
  return dir;
}
const built = (dir: string) => {
  writeSources("main", { inputs: { "web/main.tsx": {}, "node_modules/react/index.js": {} } }, dir);
  writeSources("bridge", { inputs: { "web/bridge.ts": {} } }, dir);
};

test("a dist/ built from the source on disk is fresh", (t) => {
  const dir = repo(t);
  built(dir);
  assert.equal(staleDist(dir), null);
});

test("no build, or an edit to any input after it, makes dist/ stale", (t) => {
  const dir = repo(t);
  assert.match(staleDist(dir) ?? "", /no build/);
  built(dir);
  writeFileSync(join(dir, "web/bridge.ts"), "edited");
  assert.match(staleDist(dir) ?? "", /web\/bridge\.ts/);
  built(dir);
  writeFileSync(join(dir, "package-lock.json"), "a new dependency");
  assert.match(staleDist(dir) ?? "", /package-lock\.json/);
});

test("a deleted input makes dist/ stale", (t) => {
  const dir = repo(t);
  built(dir);
  rmSync(join(dir, "web/main.tsx"));
  assert.match(staleDist(dir) ?? "", /web\/main\.tsx/);
});
