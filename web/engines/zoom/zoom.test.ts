import { test } from "node:test";
import assert from "node:assert/strict";
import { PZ_STEPS, ROOM, UI_STEPS, readPz, readUi, zoomOf } from "./zoom.ts";

const box = (painted: number, laid: number) => ({ offsetWidth: laid, getBoundingClientRect: () => ({ width: painted }) });

test("zoomOf reads the painted scale off the element, whatever set it", () => {
  assert.equal(zoomOf(box(700, 500)), 1.4);
  assert.equal(zoomOf(box(1000, 500)), 2);
  assert.equal(zoomOf(null), 1);
  assert.equal(zoomOf(undefined), 1);
  assert.equal(zoomOf(box(300, 0)), 1);              // not laid out yet: no division by zero
  assert.equal(zoomOf(box(0, 500)), 1);              // hidden (display: none inside): no zero scale
});

test("the ladders read back only a step they hold, else the resting scale", () => {
  const was = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null } });
  try {
    assert.equal(readUi(), 1);
    assert.equal(readPz(), 1);
    store.set("strata.ui2", "1.25"); store.set("strata.pz", "1.75");
    assert.equal(readUi(), 1.25);
    assert.equal(readPz(), 1.75);
    store.set("strata.ui2", "1.3"); store.set("strata.pz", "3");
    assert.equal(readUi(), 1);
    assert.equal(readPz(), 1);
  } finally {
    if (was) Object.defineProperty(globalThis, "localStorage", was);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  assert.ok(UI_STEPS.includes(1) && PZ_STEPS.includes(1), "1 is a step on both ladders");
  assert.equal(ROOM, 1.4, "no window under node: the desktop room");
});
