import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePad } from "./pad.ts";

test("a merge keeps your text as it is and adds the other tab's lines you don't have", () => {
  assert.equal(mergePad("- a\n- mine\n", "- a\n- theirs\n"), "- a\n- mine\n- theirs\n");
  assert.equal(mergePad("- a\n- mine", "- a\n"), "- a\n- mine", "nothing of theirs is missing: yours unchanged");
  assert.equal(mergePad("", "- theirs\n"), "- theirs\n");
  assert.equal(mergePad("- mine\n", ""), "- mine\n", "an empty pad elsewhere never empties yours");
  assert.equal(mergePad("- x\n", "- x\n- x\n"), "- x\n- x\n", "a line they wrote twice is kept twice");
});
