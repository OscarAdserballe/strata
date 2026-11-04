import { test } from "node:test";
import assert from "node:assert/strict";
import { compileImportPlan } from "../../../shared/imports/import-plan.ts";
import { matchSections, splitOf } from "./resection.ts";

const pages = ["a".repeat(100), "b".repeat(100), "c".repeat(300)];
const row = (id: number, label: string, page: number, offset = 0, depth = 0, parent: number | null = null) => ({ id, label, page, offset, depth, parent });

test("a split round-trips through the outline it was chosen over, excluded rows included", () => {
  const outline = [row(0, "Part I", 1), row(1, "One", 1, 0, 1, 0), row(2, "Notes", 1, 60, 1, 0), row(3, "Two", 2, 0, 1, 0), row(4, "Three", 3, 0, 0)];
  const plan = { outline, starts: [3, 4], excluded: [2] };
  const covers = compileImportPlan(plan, pages).map((u) => u.ranges);
  assert.deepEqual(splitOf(outline, covers, pages), { starts: [3, 4], excluded: [2] }, "the part title, with no text of its own, goes with its first chapter");
});

test("ids go to the same text first, then to the most shared text, each once; a removed section's cards go where its text went", () => {
  const was = [[{ page: 1, start: 0, end: 100 }], [{ page: 2, start: 0, end: 100 }], [{ page: 3, start: 0, end: 300 }]];
  const merged = [[{ page: 1, start: 0, end: 100 }], [{ page: 2, start: 0, end: 100 }, { page: 3, start: 0, end: 300 }]];
  assert.deepEqual(matchSections(was, merged), { from: [0, 2], same: [true, false], home: [0, 1, 1] });
  const split = [[{ page: 1, start: 0, end: 40 }], [{ page: 1, start: 40, end: 100 }, { page: 2, start: 0, end: 100 }], [{ page: 3, start: 0, end: 300 }]];
  assert.deepEqual(matchSections(was, split), { from: [0, 1, 2], same: [false, false, true], home: [0, 1, 2] }, "a moved boundary keeps both ids");
});

test("a section whose text is no longer studied sends its kept cards to the nearest unit", () => {
  const was = [[{ page: 1, start: 0, end: 100 }], [{ page: 3, start: 0, end: 300 }]];
  const now = [[{ page: 3, start: 0, end: 300 }]];
  assert.deepEqual(matchSections(was, now), { from: [1], same: [true], home: [0, 0] });
});
