import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LAYERS } from "./layers.ts";

const css = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? css(p) : n.endsWith(".css") ? [p] : [];
});

test("layers.css is layers.ts, in order", () => {
  const published = [...readFileSync("web/shell/layers.css", "utf8").matchAll(/--layer-([\w-]+):(\d+);/g)].map((m) => [m[1], +m[2]]);
  assert.deepEqual(published, LAYERS.map(([n, z]) => [n, z]));
  const values = LAYERS.map(([, z]) => z);
  assert.deepEqual(values, [...values].sort((a, b) => a - b), "bottom to top");
});

test("every window-wide layer stacks from the list, never a number of its own", () => {
  const used = new Set<string>();
  for (const file of css("web")) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/var\(--layer-([\w-]+)\)/g)) used.add(m[1]);
    for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = rule[2];
      const z = /z-index:\s*(\d+)/.exec(body);
      if (z && /position:\s*fixed/.test(body)) assert.fail(`${file}: ${rule[1].trim()} is fixed at z-index ${z[1]} — use var(--layer-…)`);
    }
  }
  for (const [name] of LAYERS) assert.ok(used.has(name), `--layer-${name} is used by some stylesheet`);
});
