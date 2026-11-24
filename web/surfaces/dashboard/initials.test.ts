import { test } from "node:test";
import assert from "node:assert/strict";
import { initials } from "./initials.ts";

test("initials: two letters from the words that say something", () => {
  assert.equal(initials("Let's see if we can't make the dispatch html things a little better"), "SI");
  assert.equal(initials("Find a dataset that fits the Intro to ML category"), "FD");
  assert.equal(initials("Ikea Order"), "IO");
  assert.equal(initials("Strata"), "ST");
  assert.equal(initials("Remove Michał's temporary access"), "RM");
});
