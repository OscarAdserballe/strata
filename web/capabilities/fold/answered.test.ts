import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
};
const { answered } = await import("./answered.ts");

test("a card put back is unanswered again, here and after a reload", () => {
  answered.set("deck-a", "c1", true);
  answered.set("deck-a", "c2", false);
  answered.forget("deck-a", "c1");
  assert.equal(answered.of("deck-a", "c1"), null);
  assert.equal(answered.of("deck-a", "c2"), false);
  assert.deepEqual(JSON.parse(store.get("strata.answered.deck-a")!), { c2: false });
});
