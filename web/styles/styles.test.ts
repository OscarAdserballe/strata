// An unimported sheet fails silently and a doubly imported one lands where esbuild decides; catch both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const walk = (dir: string, keep: (n: string) => boolean): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p, keep) : keep(n) ? [p] : [];
});
const ROOTS = ["web"];
const sheets = ROOTS.flatMap((r) => walk(r, (n) => n.endsWith(".css"))).map((p) => normalize(p));
const modules = ROOTS.flatMap((r) => walk(r, (n) => /\.(tsx?|jsx?|mjs)$/.test(n) && !/\.test\./.test(n)));

const imports = modules.flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/^\s*import\s+["'](\.{1,2}\/[^"']+\.css)["'];/gm)]
    .map((m) => ({ from: file, sheet: normalize(join(dirname(file), m[1])) })));

test("every stylesheet under web/ is imported, and only once", () => {
  for (const sheet of sheets) {
    const by = imports.filter((i) => i.sheet === sheet).map((i) => i.from);
    assert.equal(by.length, 1, `${sheet} is imported ${by.length} times${by.length ? ` (${by.join(", ")})` : ""}`);
  }
  for (const { from, sheet } of imports) {
    if (/^(web)[\\/]/.test(sheet)) assert.ok(sheets.includes(sheet), `${from} imports ${sheet}, which does not exist`);
  }
});

test("main.tsx opens with the tokens and the base, and ends its pinned list with glass", () => {
  const pinned = imports.filter((i) => normalize(i.from) === normalize("web/main.tsx")).map((i) => i.sheet);
  const at = (p: string) => pinned.indexOf(normalize(p));
  assert.ok(at("web/styles/tokens.css") >= 0 && at("web/styles/tokens.css") < at("web/styles/base.css"), "tokens before base");
  const own = pinned.filter((p) => !p.startsWith(normalize("web/vendor")) && p !== normalize("web/shell/layers.css") && p !== normalize("web/surfaces/library/library.css"));
  assert.equal(own[0], normalize("web/styles/tokens.css"));
  assert.equal(own[own.length - 1], normalize("web/styles/glass.css"), "glass overrides every screen, so it is last");
});
