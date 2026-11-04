import { test } from "node:test";
import assert from "node:assert/strict";
import { cardThreadKey, parseThread, storeKeyOf, threadFor } from "./threads.ts";

test("a real-shaped card id round-trips through its thread key", () => {
  const id = "econ-101/flashcard/k7";
  const key = threadFor("card", { surface: "review", card: { id, deck: "econ-101/0-flashcard", course: "econ-101", role: "subject" } });
  assert.equal(key, "card:econ-101/econ-101/flashcard/k7");
  assert.deepEqual(parseThread(key), { kind: "card", deck: "econ-101", card: id });
  assert.equal(storeKeyOf(key), `thread:card:econ-101/${id}`);
  assert.deepEqual(parseThread(cardThreadKey("src-s7b2ad33e", "src-s7b2ad33e/mcq/a/b")), { kind: "card", deck: "src-s7b2ad33e", card: "src-s7b2ad33e/mcq/a/b" });
});

test("a card with no course to be read by has no card thread", () => {
  assert.equal(cardThreadKey("", "mint:42"), null);
  assert.equal(cardThreadKey(null, "x"), null);
  assert.equal(cardThreadKey("econ-101/0-flashcard", "x"), null, "a deck name is not a course");
  assert.equal(parseThread("card:/mint:42"), null);
});

test("board, source and library keys", () => {
  assert.deepEqual(parseThread("library"), { kind: "library" });
  assert.deepEqual(parseThread("board:b1"), { kind: "board", board: "b1", source: null });
  assert.deepEqual(parseThread("board:b1/source:r2"), { kind: "board", board: "b1", source: "r2" });
  assert.equal(storeKeyOf("library"), "thread:inbox/");
  assert.equal(storeKeyOf("board:b1/source:r2"), "thread:b1/r2");
  assert.equal(threadFor("source", { surface: "reader", board: "b1", source: "r2" }), "board:b1/source:r2");
  assert.equal(threadFor("board", { surface: "board", board: "b1", source: "r2" }), "board:b1");
  assert.equal(threadFor("board", { surface: "library" }), null);
});
