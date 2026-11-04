import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePageText, pageIndex, findQuote, rectsToFractions, mergeRects } from "./marks.ts";

const items = (...strs: string[]) => strs.map((str) => ({ str }));

test("pageIndex reproduces the reader's own page text exactly", () => {
  // the upload path and the on-screen page must build the same string, or stored offsets shift
  const raw = ["The difficulty  with any", "account of market\tstructure", "is that the structure"];
  const idx = pageIndex(items(...raw));
  assert.equal(idx.text, normalizePageText(raw));
  assert.equal(idx.text, "The difficulty with any account of market structure is that the structure");
});

test("loc maps a character of an item to its place in the page text", () => {
  const idx = pageIndex(items("Alpha beta", "gamma delta"));
  assert.equal(idx.text, "Alpha beta gamma delta");
  assert.equal(idx.loc(0, 0), 0);
  assert.equal(idx.loc(0, 6), 6);
  assert.equal(idx.loc(1, 0), 11);
  assert.equal(idx.loc(1, 6), 17);
  assert.equal(idx.text.slice(idx.loc(1, 0), idx.loc(1, 5)), "gamma");
});

test("loc survives collapsed whitespace inside an item", () => {
  const idx = pageIndex(items("one   two", "three"));
  assert.equal(idx.text, "one two three");
  assert.equal(idx.text.slice(idx.loc(0, 6), idx.loc(0, 9)), "two");   // 't' of two is item char 6
});

test("loc lands on the end when a selection stops at an item's last character", () => {
  const idx = pageIndex(items("first", "second"));
  assert.equal(idx.loc(0, 5), 5);                       // one past 'first'
  assert.equal(idx.loc(1, 6), idx.text.length);
});

test("a leading or trailing space never shifts an offset", () => {
  const idx = pageIndex(items("  padded", "text  "));
  assert.equal(idx.text, "padded text");
  assert.equal(idx.text.slice(idx.loc(0, 2), idx.loc(0, 8)), "padded");
});

test("an empty page is not a crash", () => {
  const idx = pageIndex([]);
  assert.equal(idx.text, "");
  assert.equal(idx.loc(0, 0), 0);
  assert.equal(idx.loc(9, 9), 0);
});

test("findQuote takes the hint when the hint is right", () => {
  const t = "alpha beta gamma";
  assert.deepEqual(findQuote(t, "beta", 6), { start: 6, end: 10 });
});

test("findQuote re-finds a quote the document moved", () => {
  const t = "PREFIX ADDED LATER — alpha beta gamma";
  // stored offset 6 is now wrong; the words are the authority
  assert.deepEqual(findQuote(t, "beta", 6), { start: 27, end: 31 });
  assert.equal(t.slice(27, 31), "beta");
});

test("findQuote picks the occurrence nearest the hint when a quote repeats", () => {
  const t = "hold the line. " + "x".repeat(200) + " hold the line.";
  const far = findQuote(t, "hold the line", 210);
  assert.ok(far && far.start > 200, "should pick the second occurrence, not the first");
  const near = findQuote(t, "hold the line", 0);
  assert.deepEqual(near, { start: 0, end: 13 });
});

test("findQuote tolerates a change in spacing", () => {
  // the one thing that genuinely differs between two extractions of the same page
  const t = "the structure  is\nnot a fact";
  const hit = findQuote(t, "structure is not", 4);
  assert.ok(hit);
  assert.equal(t.slice(hit.start, hit.end).replace(/\s+/g, " "), "structure is not");
});

test("findQuote gives up rather than guessing", () => {
  assert.equal(findQuote("nothing like it here", "a passage that never appeared", 0), null);
  assert.equal(findQuote("some text", "", 0), null);
});

test("findQuote does not hang on a quote of pure whitespace", () => {
  assert.equal(findQuote("some text", "   ", 0), null);
});

test("rectsToFractions turns page pixels into fractions of the page", () => {
  const box = { left: 100, top: 50, width: 400, height: 800 };
  const got = rectsToFractions([{ left: 200, top: 130, width: 100, height: 16 }], box);
  assert.deepEqual(got, [[0.25, 0.1, 0.25, 0.02]]);
});

test("rectsToFractions is unchanged by the scale the page is displayed at", () => {
  // the same selection drawn at 1x and 1.75x: nothing stored may be in device pixels
  const one = rectsToFractions([{ left: 200, top: 130, width: 100, height: 16 }], { left: 100, top: 50, width: 400, height: 800 });
  const big = rectsToFractions([{ left: 275, top: 190, width: 175, height: 28 }], { left: 100, top: 50, width: 700, height: 1400 });
  assert.deepEqual(one, big);
});

test("rectsToFractions drops a rectangle that is not on this page", () => {
  const box = { left: 0, top: 0, width: 100, height: 100 };
  assert.deepEqual(rectsToFractions([{ left: -40, top: 10, width: 20, height: 5 }], box), []);
  assert.deepEqual(rectsToFractions([{ left: 10, top: 10, width: 200, height: 5 }], box), []);
  assert.deepEqual(rectsToFractions([{ left: 10, top: 10, width: 0, height: 5 }], box), []);
});

test("rectsToFractions refuses a page with no size", () => {
  assert.deepEqual(rectsToFractions([{ left: 1, top: 1, width: 1, height: 1 }], { left: 0, top: 0, width: 0, height: 0 }), []);
});

test("mergeRects joins the runs that share a line", () => {
  // one selected line arrives as several boxes, one per text run
  const merged = mergeRects([[0.1, 0.2, 0.2, 0.02], [0.3, 0.201, 0.25, 0.02], [0.1, 0.24, 0.4, 0.02]]);
  assert.equal(merged.length, 2, "two lines, not three runs");
  assert.deepEqual(merged[0].map((n: number) => +n.toFixed(3)), [0.1, 0.2, 0.45, 0.02]);
});
