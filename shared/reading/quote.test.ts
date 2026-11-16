import { test } from "node:test";
import assert from "node:assert/strict";
import { findQuote, placeByQuote, quoteNear } from "./quote.ts";

test("a quote is found across whitespace and case, nearest where it was", () => {
  const text = "Odds rise.\n\nPrior odds × LR. Later: prior  odds × LR again.";
  assert.deepEqual(findQuote(text, "prior odds × lr"), [12, 27]);
  assert.deepEqual(findQuote(text, "prior odds × LR", 40), [36, 52]);
  assert.equal(findQuote(text, "ab"), null);
  assert.equal(findQuote(text, "not in it"), null);
});

test("marks keep offsets that still read their quote, move when they don't, and drop when gone", () => {
  const twin = "# Base rates\n\nA rare illness makes most positives false.";
  const marks = [
    { id: "kept", start: 16, end: 28, quote: twin.slice(16, 28) },
    { id: "moved", start: 3, end: 18, quote: "most positives" },
    { id: "gone", start: 0, end: 9, quote: "not here at all" },
  ];
  const placed = placeByQuote(twin, marks);
  assert.deepEqual(placed.map((m) => m.id), ["kept", "moved"]);
  assert.equal(twin.slice(placed[1].start, placed[1].end), "most positives");
});

test("words are found where they were picked, not at a copy of them in the page's title", () => {
  const text = "Delegation loss · nav\nDelegation loss\n\nBody: each hop drops a little. Delegation loss grows per hop.";
  const at = text.lastIndexOf("Delegation loss");
  assert.deepEqual(quoteNear(text, "Delegation loss", at), [at, at + 15]);
  assert.deepEqual(quoteNear(text, "delegation  LOSS", at - 3), findQuote(text, "delegation  LOSS", at - 3), "moved a little: the nearest copy");
  assert.equal(quoteNear(text, "Delegation loss", at - 3)![0], at);
  assert.deepEqual(quoteNear(text, "Delegation loss"), [0, 15], "with no place, the first");
  assert.deepEqual(quoteNear(text, "Delegation loss", 9999), [at, at + 15], "a place past the end: the nearest");
});
