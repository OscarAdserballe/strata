import { test } from "node:test";
import assert from "node:assert/strict";
import { FIND_CAP, findHits } from "./find.ts";

test("find lists every occurrence in the raw text, case-insensitively, overlaps included", () => {
  assert.deepEqual(findHits("Ab", { text: "ab xAB aab" }), [{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 10 }]);
  assert.deepEqual(findHits("aa", { text: "aaa" }), [{ start: 0, end: 2 }, { start: 1, end: 3 }]);
  assert.deepEqual(findHits("zz", { text: "" }), []);
});

test("on a PDF a hit names its page, counted from 1, and offsets are the page's own", () => {
  assert.deepEqual(findHits("beta", { pages: ["alpha", "Beta and beta", "", "beta"] }),
    [{ page: 2, start: 0, end: 4 }, { page: 2, start: 9, end: 13 }, { page: 4, start: 0, end: 4 }]);
  assert.deepEqual(findHits("beta", { pages: [] }), []);
});

test("the list stops at the cap, across pages too", () => {
  assert.equal(findHits("a", { text: "a".repeat(FIND_CAP + 50) }).length, FIND_CAP);
  const pages = Array.from({ length: 10 }, () => "x ".repeat(60));
  const hits = findHits("x", { pages });
  assert.equal(hits.length, FIND_CAP);
  assert.equal(hits[hits.length - 1].page, 7, "60 a page: the cap lands on page 7");
});
