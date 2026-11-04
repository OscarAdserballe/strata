import { test } from "node:test";
import assert from "node:assert/strict";
import { findQuote, placeByQuote } from "./quote.ts";

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
