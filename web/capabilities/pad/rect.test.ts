import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_H, MIN_W, clampRect, cornerRect, readRect } from "./rect.ts";

test("the notepad opens in the bottom right, above the save chip", () => {
  const r = cornerRect(1440, 900);
  assert.deepEqual(r, { x: 1440 - 380 - 14, y: 900 - 360 - 64, w: 380, h: 360 });
});

test("a small window shrinks the corner rect instead of pushing it off screen", () => {
  const r = cornerRect(400, 300);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 400 && r.y + r.h <= 300);
});

test("a saved rect is pulled back inside a window that got smaller", () => {
  assert.deepEqual(clampRect({ x: 1200, y: 700, w: 380, h: 360 }, 1000, 800), { x: 620, y: 440, w: 380, h: 360 });
  assert.deepEqual(clampRect({ x: -50, y: -20, w: 10, h: 10 }, 1000, 800), { x: 0, y: 0, w: MIN_W, h: MIN_H });
  assert.deepEqual(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, 1000, 800), { x: 0, y: 0, w: 1000, h: 800 });
});

test("only a whole, numeric saved rect is read back", () => {
  assert.deepEqual(readRect('{"x":1,"y":2,"w":300,"h":200}'), { x: 1, y: 2, w: 300, h: 200 });
  assert.equal(readRect('{"x":1,"y":2,"w":300}'), null);
  assert.equal(readRect("not json"), null);
  assert.equal(readRect(null), null);
});
