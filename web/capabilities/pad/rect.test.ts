import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_H, MIN_W, clampRect, cornerRect, readRect, resize } from "./rect.ts";

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

test("a side or bottom edge moves only that edge", () => {
  const s = { x: 500, y: 300, w: 380, h: 360 };
  assert.deepEqual(resize(s, "e", 40, 99, 1440, 900), { x: 500, y: 300, w: 420, h: 360 });
  assert.deepEqual(resize(s, "w", -40, 99, 1440, 900), { x: 460, y: 300, w: 420, h: 360 });
  assert.deepEqual(resize(s, "s", 99, 30, 1440, 900), { x: 500, y: 300, w: 380, h: 390 });
});

test("a corner moves its two edges and keeps the opposite corner where it was", () => {
  const s = { x: 500, y: 300, w: 380, h: 360 };
  assert.deepEqual(resize(s, "nw", -20, -30, 1440, 900), { x: 480, y: 270, w: 400, h: 390 });
  assert.deepEqual(resize(s, "ne", 20, 30, 1440, 900), { x: 500, y: 330, w: 400, h: 330 });
  assert.deepEqual(resize(s, "sw", 20, 30, 1440, 900), { x: 520, y: 300, w: 360, h: 390 });
  assert.deepEqual(resize(s, "se", 20, 30, 1440, 900), { x: 500, y: 300, w: 400, h: 390 });
});

test("shrinking stops at the minimum size without moving the far edge", () => {
  const s = { x: 500, y: 300, w: 380, h: 360 };
  assert.deepEqual(resize(s, "nw", 1000, 1000, 1440, 900), { x: 880 - MIN_W, y: 660 - MIN_H, w: MIN_W, h: MIN_H });
  assert.deepEqual(resize(s, "se", -1000, -1000, 1440, 900), { x: 500, y: 300, w: MIN_W, h: MIN_H });
});

test("growing stops at the window's edge", () => {
  const s = { x: 500, y: 300, w: 380, h: 360 };
  assert.deepEqual(resize(s, "nw", -2000, -2000, 1440, 900), { x: 0, y: 0, w: 880, h: 660 });
  assert.deepEqual(resize(s, "se", 2000, 2000, 1440, 900), { x: 500, y: 300, w: 940, h: 600 });
});
