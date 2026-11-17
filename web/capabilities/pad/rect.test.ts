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

const R = { x: 500, y: 300, w: 380, h: 360 };

test("each corner and edge moves only its own sides", () => {
  assert.deepEqual(resize(R, "se", 20, 10), { x: 500, y: 300, w: 400, h: 370 });
  assert.deepEqual(resize(R, "nw", -20, -10), { x: 480, y: 290, w: 400, h: 370 });
  assert.deepEqual(resize(R, "ne", 20, 30), { x: 500, y: 330, w: 400, h: 330 });
  assert.deepEqual(resize(R, "sw", 40, 10), { x: 540, y: 300, w: 340, h: 370 });
  assert.deepEqual(resize(R, "e", 20, 99), { x: 500, y: 300, w: 400, h: 360 });
  assert.deepEqual(resize(R, "w", -20, 99), { x: 480, y: 300, w: 400, h: 360 });
  assert.deepEqual(resize(R, "s", 99, 15), { x: 500, y: 300, w: 380, h: 375 });
});

test("dragging past the minimum stops the side; the opposite side never moves", () => {
  assert.deepEqual(resize(R, "nw", 1000, 1000), { x: 500 + 380 - MIN_W, y: 300 + 360 - MIN_H, w: MIN_W, h: MIN_H });
  assert.deepEqual(resize(R, "se", -1000, -1000), { x: 500, y: 300, w: MIN_W, h: MIN_H });
});

test("no side passes the window's edge", () => {
  assert.deepEqual(resize(R, "nw", -9000, -9000, 1440, 900), { x: 0, y: 0, w: 880, h: 660 });
  assert.deepEqual(resize(R, "se", 9000, 9000, 1440, 900), { x: 500, y: 300, w: 940, h: 600 });
});
