import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteAsk } from "./deleteAsk.ts";

test("a source's delete asks plainly, and names the notes and kept cards that go with it", () => {
  assert.equal(deleteAsk({ del: { res: "r" } }), "Delete it?");
  assert.equal(deleteAsk({ del: { res: "r" }, marksN: 0, kp: { kept: 0 } }), "Delete it?");
  assert.equal(deleteAsk({ del: { res: "r" }, marksN: 1 }), "Delete it, with your 1 note?");
  assert.equal(deleteAsk({ del: { res: "r" }, marksN: 3, kp: { kept: 12 } }), "Delete it, with your 3 notes and 12 kept cards?");
  assert.equal(deleteAsk({ del: { pair: "p" } }), "Delete the pair and its cards?");
});
