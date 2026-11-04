import { test } from "node:test";
import assert from "node:assert/strict";
import { type Place, dockOf, threadOf } from "./layers.ts";

const place = (over: Partial<Place> = {}): Place => ({
  passage: { top: 100, bottom: 180, left: 40, right: 600 }, column: { left: 40, right: 600 }, width: 680, unit: 1, perClient: 1, ...over,
});

test("a sheet lies just under its passage, inside the column", () => {
  const at = dockOf(place());
  assert.equal(at.y, 188);
  assert.ok(at.x >= 40 && at.x + at.w <= 600, JSON.stringify(at));
});

test("a sheet never hangs off a narrow plane", () => {
  const at = dockOf(place({ column: { left: 10, right: 250 }, width: 260 }));
  assert.ok(at.x >= 0 && at.x + at.w <= 260, JSON.stringify(at));
});

test("a slide's sheet lies where the page says, over the slide", () => {
  assert.equal(dockOf(place({ dock: 140 })).y, 140);
});

test("a live page's sheet is drawn at its scale", () => {
  assert.equal(dockOf(place({ column: { left: 0, right: 2000 }, width: 2000, unit: 2 })).w, 920);
});

test("the bracket is on the side nearer the sheet, and the thread ends at the sheet's corner", () => {
  const p = place();
  const left = threadOf(p, { x: 80, y: 188, w: 460 });
  assert.match(left.bracket, /^M31 /);
  assert.deepEqual(left.to, [94, 188]);
  const right = threadOf(p, { x: 700, y: 300, w: 300 });
  assert.match(right.bracket, /^M609 /);
  assert.deepEqual(right.to, [986, 300]);
});

test("a sheet over its own passage is tied from beside it, not from the passage's end", () => {
  const th = threadOf(place({ passage: { top: 0, bottom: 1000, left: 40, right: 600 } }), { x: 80, y: 500, w: 460 });
  assert.equal(th.from[1], 500);
});
