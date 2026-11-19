import { test } from "node:test";
import assert from "node:assert/strict";
import { type Place, dockOf, layOf, leaderOf, onWords, tabOf } from "./layers.ts";

const place = (over: Partial<Place> = {}): Place => ({
  passage: { top: 100, bottom: 180, left: 40, right: 600 }, column: { left: 40, right: 600 }, width: 680, unit: 1, perClient: 1, ...over,
});

test("a wide plane leaves the margin to the sheets; a narrow one or a live page puts them on the rail", () => {
  assert.equal(layOf(place({ width: 1000 })), "beside");
  assert.equal(layOf(place()), "rail", "80px right of the column is no margin");
  assert.equal(layOf(place({ width: 1000 }), true), "rail");
});

test("beside the column, a sheet lies level with its words' first line, inside the plane", () => {
  const at = dockOf(place({ width: 1000 }), "beside");
  assert.equal(at.x, 628);
  assert.equal(at.y, 96);
  assert.ok(at.x + at.w <= 1000, JSON.stringify(at));
  assert.equal(at.w, 300);
});

test("on the rail, a sheet lies on the right edge just under its words, over the page", () => {
  const at = dockOf(place({ hang: { x: 300, y: 160 } }), "rail");
  assert.equal(at.y, 168);
  assert.equal(at.x + at.w, 672);
  assert.ok(at.x >= 0);
});

test("on the rail, a box's sheet lies level with the box, over its right side", () => {
  assert.equal(dockOf(place(), "rail").y, 100);
});

test("a slide's sheet on the rail lies where the page says", () => {
  assert.equal(dockOf(place({ dock: 140 }), "rail").y, 140);
});

test("a live page's sheet is drawn at its scale", () => {
  assert.equal(dockOf(place({ column: { left: 0, right: 2000 }, width: 2000, unit: 2 }), "rail").w, 600);
});

test("a tab lies level with its words: beside the column, or by its right end on the plane's edge", () => {
  const p = place({ width: 1000 });
  assert.deepEqual(tabOf(p, "beside"), { x: 628, y: 98, w: 150 });
  assert.equal(tabOf(p, "rail").x + tabOf(p, "rail").w, 992);
});

test("a leader runs from the column's edge at the words' line to the sheet's strip, and bends when the sheet is pushed down", () => {
  const p = place({ width: 1000 });
  const level = leaderOf(p, { x: 628, y: 94, w: 300 });
  assert.equal(level.d, "M606 110 H628");
  const pushed = leaderOf(p, { x: 628, y: 300, w: 300 });
  assert.deepEqual(pushed.from, [606, 110]);
  assert.deepEqual(pushed.to, [628, 316]);
  assert.match(pushed.d, /^M606 110 C/);
});

test("a click is on a card's words only within their lines", () => {
  const rects = [{ left: 100, right: 400, top: 10, bottom: 30 }, { left: 40, right: 200, top: 40, bottom: 60 }];
  assert.ok(onWords(rects, 150, 50));
  assert.ok(onWords(rects, 399, 20));
  assert.ok(!onWords(rects, 300, 50), "past the end of the last line");
  assert.ok(!onWords(rects, 60, 20), "before the start of the first line");
});
