import { test } from "node:test";
import assert from "node:assert/strict";
const { reanchor } = await import("./ingest.ts");

test("a highlight follows its words into a revision, to the occurrence nearest where it was", () => {
  const was = "Dense retrieval misses rare names. Rare names matter.";
  const next = "Intro. Dense retrieval misses rare names, which BM25 catches. Rare names matter.";
  const [s, e] = reanchor(was, next, 23, 33);
  assert.equal(next.slice(s, e), "rare names");
  assert.equal(s, next.indexOf("rare names"));
});

test("a highlight whose words are gone keeps an empty range", () => {
  assert.deepEqual(reanchor("Only this sentence.", "Something else entirely.", 5, 9), [0, 0]);
});
