import { test } from "node:test";
import assert from "node:assert/strict";
import { pageApi } from "./page-state.ts";
import type { FromPage } from "./protocol.ts";

// timers the test fires by hand
function clock() {
  const due: (() => void)[] = [];
  return { wait: (fn: () => void) => { due.push(fn); return () => { due.splice(due.indexOf(fn), 1); }; }, fire: () => due.splice(0).forEach((f) => f()) };
}

test("load asks the reader and parses what it holds; save sends the JSON text and waits for the answer", async () => {
  const out: FromPage[] = [];
  const { api, hear } = pageApi((m) => out.push(m), clock().wait);
  const loading = api.load();
  assert.deepEqual(out[0], { t: "load", n: 1 });
  hear({ t: "state", n: 1, value: '{"w1":"go"}' });
  assert.deepEqual(await loading, { w1: "go" });

  const saving = api.save({ w1: "drop" });
  assert.deepEqual(out[1], { t: "save", n: 2, value: '{"w1":"drop"}' });
  hear({ t: "saved", n: 2, ok: true });
  await saving;

  const refused = api.save([1]);
  hear({ t: "saved", n: 3, ok: false, why: "offline" });
  await assert.rejects(refused, /offline/);
});

test("with no reader answering, load gives null and save fails; opened on its own, nothing is asked", async () => {
  const c = clock();
  const out: FromPage[] = [];
  const { api } = pageApi((m) => out.push(m), c.wait);
  const loading = api.load(), saving = api.save({});
  c.fire();
  assert.equal(await loading, null);
  await assert.rejects(saving, /didn't answer/);

  const alone = pageApi(null).api;
  assert.equal(await alone.load(), null);
  await assert.rejects(alone.save({}), /only when opened in Strata/);
});

test("a failed read rejects instead of passing for empty, and a value too big or not JSON never leaves", async () => {
  const out: FromPage[] = [];
  const { api, hear } = pageApi((m) => out.push(m), clock().wait);
  const loading = api.load();
  hear({ t: "state", n: 1, value: null, why: "offline" });
  await assert.rejects(loading, /offline/);
  await assert.rejects(api.save("x".repeat(64 * 1024)), /64 KB/);
  await assert.rejects(api.save(undefined), /JSON value/);
  assert.equal(out.length, 1, "only the load was sent");
});
