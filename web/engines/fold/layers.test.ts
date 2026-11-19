import { test } from "node:test";
import assert from "node:assert/strict";
import type { FoldCard, FoldNote } from "./view.ts";
import { type Place, dockOf, marginOf, onWords, sheetMemory, tabOf, threadOf } from "./layers.ts";

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

test("the bracket is on the side nearer the sheet, and the thread ends at the sheet's near edge", () => {
  const p = place();
  const left = threadOf(p, { x: 80, y: 188, w: 460 });
  assert.match(left.bracket, /^M31 /);
  assert.deepEqual(left.to, [94, 188]);
  const right = threadOf(p, { x: 700, y: 300, w: 300 });
  assert.match(right.bracket, /^M609 /);
  assert.deepEqual(right.to, [700, 313]);
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
  const th = threadOf(p, { x: 200, y: 500, w: 300 });
  assert.equal(th.caret, "");
  assert.equal(th.bracket, "");
  assert.deepEqual(th.from, [300, 160]);
});

test("a card's sheet in the margin is tied from the column's edge, not across the words", () => {
  const th = threadOf(place({ hang: { x: 300, y: 160 } }), { x: 700, y: 100, w: 300 });
  assert.match(th.bracket, /^M609 /);
  assert.equal(th.from[0], 613);
});

test("a click is on a card's words only within their lines", () => {
  const rects = [{ left: 100, right: 400, top: 10, bottom: 30 }, { left: 40, right: 200, top: 40, bottom: 60 }];
  assert.ok(onWords(rects, 150, 50));
  assert.ok(onWords(rects, 399, 20));
  assert.ok(!onWords(rects, 300, 50), "past the end of the last line");
  assert.ok(!onWords(rects, 60, 20), "before the start of the first line");
});

test("with room beside the column, a sheet lies in the margin level with its words", () => {
  const p = place({ width: 1100 });
  const at = dockOf(p);
  assert.equal(at.y, 100);
  assert.ok(at.x > 600 && at.x + at.w <= 1100, JSON.stringify(at));
  const th = threadOf(p, at);
  assert.ok(th.bracket && th.thread, "a margin sheet is tied to its words");
  assert.equal(th.to[0], at.x);
});

test("a margin too narrow for a sheet leaves it under its words", () => {
  assert.equal(marginOf(place({ width: 780 })), null);
  assert.ok(marginOf(place({ width: 830 })));
});

test("a shrunk sheet's tab says what it holds", () => {
  const note: FoldNote = { kind: "note", id: "n", quote: "q", text: "Why does stronger matter here at all, really?", editing: false, replies: [] };
  const card = (id: string): FoldCard => ({ kind: "card", id, where: "", q: "What makes it identified?", face: false, held: false, state: "done", got: true, mcq: false });
  assert.equal(tabOf([note]), "Why does stronger matter here at…");
  assert.equal(tabOf([card("a")]), "What makes it identified?");
  assert.equal(tabOf([card("a"), card("b")]), "2 cards");
});

test("closing, shrinking and resizing a sheet on its own words is remembered; a passage's only for its source", () => {
  const disk = new Map<string, string>();
  const store = { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => { disk.set(k, v); } };
  const a = sheetMemory(store);
  a.close("w:hl_1", true); a.mini("w:card_2", true); a.size("w:hl_3", { w: 280.4, h: 120 }); a.close("b12", true);
  const b = sheetMemory(store);
  assert.equal(b.closed("w:hl_1"), true);
  assert.equal(b.isMini("w:card_2"), true);
  assert.deepEqual(b.sizeOf("w:hl_3"), { w: 280, h: 120 });
  assert.equal(b.closed("b12"), false);
  assert.equal(a.closed("b12"), true);
  a.forget();
  assert.equal(a.closed("b12"), false);
  b.close("w:hl_1", false);
  assert.equal(sheetMemory(store).closed("w:hl_1"), false);
});

test("without storage, sheets are remembered for the visit", () => {
  const m = sheetMemory(null);
  m.mini("w:x", true);
  assert.equal(m.isMini("w:x"), true);
});
