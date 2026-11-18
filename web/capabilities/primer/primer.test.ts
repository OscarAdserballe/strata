import { test } from "node:test";
import assert from "node:assert/strict";
import { nextWait, pageAsked, primerPanel, primerView, WAIT_FIRST, WAIT_MAX } from "./primer.ts";

test("the panel shows the page it has, says when one is asked for, and says stale", () => {
  assert.deepEqual(primerView(undefined), { page: false, asked: false, stale: false, tag: "none" });
  assert.deepEqual(primerView({ status: "requested", requestedAt: 1, builtAt: null }), { page: false, asked: true, stale: false, tag: "asked…" });
  assert.deepEqual(primerView({ status: "ready", requestedAt: 1, builtAt: 2 }), { page: true, asked: false, stale: false, tag: "" });
  assert.deepEqual(primerView({ status: "stale", requestedAt: 1, builtAt: 2 }), { page: true, asked: false, stale: true, tag: "stale" });
  assert.deepEqual(primerView({ status: "requested", requestedAt: 3, builtAt: 2 }), { page: true, asked: true, stale: false, tag: "asked…" }, "a rebuild keeps the old page up");
});

test("the wait for an asked-for primer backs off and stops growing at its ceiling", () => {
  let w = WAIT_FIRST;
  const seen = [w];
  for (let i = 0; i < 20; i++) seen.push(w = nextWait(w));
  assert.ok(seen.every((x, i) => i === 0 || x >= seen[i - 1]));
  assert.equal(seen.at(-1), WAIT_MAX);
});

test("a page link is followed only from the primer's own frame, and only to a page number", () => {
  const frame = {};
  assert.equal(pageAsked({ source: frame, data: { strataPrimer: { page: 4 } } }, frame), 4);
  assert.equal(pageAsked({ source: {}, data: { strataPrimer: { page: 4 } } }, frame), null, "another frame's message");
  assert.equal(pageAsked({ source: frame, data: { strataPrimer: { page: 0 } } }, frame), null);
  assert.equal(pageAsked({ source: frame, data: { strataPrimer: { page: "4" } } }, frame), null);
  assert.equal(pageAsked({ source: frame, data: null }, frame), null);
  assert.equal(pageAsked({ source: null, data: { strataPrimer: { page: 2 } } }, null), null, "no frame up: nothing is followed");
});

test("the panel's state tells its listeners only when it changes", () => {
  let told = 0;
  const off = primerPanel.subscribe(() => { told++; });
  primerPanel.set({ open: true });
  primerPanel.set({ open: true });
  primerPanel.set({ wide: true });
  off();
  primerPanel.set({ open: false, wide: false });
  assert.equal(told, 2);
  assert.deepEqual(primerPanel.get(), { open: false, wide: false });
});
