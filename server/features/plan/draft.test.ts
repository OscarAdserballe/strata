import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedDraft } from "./draft.ts";

test("a draft keeps only the board's own sources, each once, and whatever the model dropped is a loose end", () => {
  const d = checkedDraft({ units: [{ name: " Why cities exist ", items: ["a", "x", "b"] }, { name: "Again", items: ["a"] }, { name: "", items: ["c"] }], loose: ["b", "d"] },
    ["a", "b", "c", "d", "e"]);
  assert.deepEqual(d, { units: [{ name: "Why cities exist", items: ["a", "b"] }], loose: ["d", "c", "e"] });
  assert.deepEqual(checkedDraft("nonsense", ["a"]), { units: [], loose: ["a"] });
});
