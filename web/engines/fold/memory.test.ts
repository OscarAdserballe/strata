import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetMemory } from "./memory.ts";

test("a sheet's place, size and closing are kept on this device and survive a reload", () => {
  const store = new Map<string, string>();
  const was = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
  try {
    sheetMemory.reset();
    sheetMemory.set("hl_1", { x: 700, y: 120 });
    sheetMemory.set("hl_1", { w: 320, h: 180 });
    sheetMemory.set("hl_2", { closed: true });
    sheetMemory.reset();
    assert.deepEqual(sheetMemory.get("hl_1"), { x: 700, y: 120, w: 320, h: 180 });
    assert.equal(sheetMemory.get("hl_2")?.closed, true);
    sheetMemory.set("hl_2", { closed: undefined });
    assert.equal(sheetMemory.get("hl_2"), undefined, "an entry with nothing left in it goes");
  } finally {
    if (was) Object.defineProperty(globalThis, "localStorage", was);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    sheetMemory.reset();
  }
});

test("without storage a visit still remembers", () => {
  sheetMemory.reset();
  sheetMemory.set("hl_3", { closed: true });
  assert.equal(sheetMemory.get("hl_3")?.closed, true);
  sheetMemory.reset();
});
