import { test } from "node:test";
import assert from "node:assert/strict";
import { type Place, dockOf, onWords, threadOf } from "./layers.ts";

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

test("a card's sheet hangs just under its words, starting where their last line does", () => {
  const p = place({ passage: { top: 100, bottom: 160, left: 40, right: 600 }, hang: { x: 300, y: 160 } });
  const at = dockOf(p);
  assert.equal(at.y, 170);
  assert.equal(at.x, 160, "shifted left to stay in the column");
  const th = threadOf(p, at);
  assert.equal(th.bracket, "");
  assert.equal(th.thread, "");
  assert.match(th.caret, /^M305 171 L312 163 L319 171 Z$/);
});

test("a card's sheet near the column's right edge stays by the column, its caret still on the words", () => {
  const p = place({ passage: { top: 100, bottom: 160, left: 40, right: 600 }, hang: { x: 560, y: 160 } });
  const at = dockOf(p);
  assert.ok(at.x + at.w <= 620, JSON.stringify(at));
  assert.ok(threadOf(p, at).caret, "a caret, not a thread");
});

test("a card's sheet moved away from its words is tied to them by a thread, not a bracket", () => {
  const p = place({ hang: { x: 300, y: 160 } });
  const th = threadOf(p, { x: 700, y: 500, w: 300 });
  assert.equal(th.caret, "");
  assert.equal(th.bracket, "");
  assert.deepEqual(th.from, [300, 160]);
});

test("a click is on a card's words only within their lines", () => {
  const rects = [{ left: 100, right: 400, top: 10, bottom: 30 }, { left: 40, right: 200, top: 40, bottom: 60 }];
  assert.ok(onWords(rects, 150, 50));
  assert.ok(onWords(rects, 399, 20));
  assert.ok(!onWords(rects, 300, 50), "past the end of the last line");
  assert.ok(!onWords(rects, 60, 20), "before the start of the first line");
});
