import { test } from "node:test";
import assert from "node:assert/strict";
import { chipKey } from "./chips.ts";

const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });

test("n, a and c pick the chip; Esc drops the chips", () => {
  assert.deepEqual(chipKey(key("n")), { act: "note", typed: "" });
  assert.deepEqual(chipKey(key("a")), { act: "ask" });
  assert.deepEqual(chipKey(key("c")), { act: "card" });
  assert.deepEqual(chipKey(key("Escape")), { act: "drop" });
});

test("any other letter opens the note with that letter in it, a capital too", () => {
  assert.deepEqual(chipKey(key("w")), { act: "note", typed: "w" });
  assert.deepEqual(chipKey(key("N")), { act: "note", typed: "N" });
  assert.deepEqual(chipKey(key("é")), { act: "note", typed: "é" });
});

test("shortcuts, digits, space and named keys pass through to the room", () => {
  for (const k of [key("z", { metaKey: true }), key("c", { ctrlKey: true }), key("n", { altKey: true }), key("1"), key(" "), key("ArrowDown"), key("Shift"), key("/")])
    assert.equal(chipKey(k), null, JSON.stringify(k));
});
