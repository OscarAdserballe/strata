import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
};
const { switches } = await import("./switches.ts");

test("a layer starts on, flips off and is remembered", () => {
  assert.equal(switches.on("notes"), true);
  switches.flip("notes");
  assert.equal(switches.on("notes"), false);
  assert.deepEqual(JSON.parse(store.get("strata.layers")!).notes, false);
  switches.flip("notes");
  assert.equal(switches.on("notes"), true);
});

test("a count that didn't change tells no one, so a repaint can report it every time", () => {
  let told = 0;
  const off = switches.subscribe(() => { told++; });
  switches.count("cards", 4);
  switches.count("cards", 4);
  switches.count("cards", 5);
  off();
  assert.equal(told, 2);
  assert.equal(switches.getSnapshot().count.cards, 5);
});

test("a snapshot is a new object only when something changed", () => {
  const a = switches.getSnapshot();
  switches.count("ask", switches.getSnapshot().count.ask);
  assert.equal(switches.getSnapshot(), a);
});
