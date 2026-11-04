import { test } from "node:test";
import assert from "node:assert/strict";
import { Wire } from "./wire.ts";

/* A clock the test owns: setTimeout is mocked, and each step lets the probe's promise settle. */
function room(t: import("node:test").TestContext, probe: () => Promise<boolean>, hidden = () => false) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const said: boolean[] = [];
  let probes = 0;
  const wire = new Wire({ probe: () => { probes++; return probe(); }, changed: (d) => said.push(d), hidden });
  const pass = async (ms: number) => {
    for (let i = 0; i < ms; i += 250) { t.mock.timers.tick(250); for (let j = 0; j < 5; j++) await Promise.resolve(); }
  };
  return { wire, said, pass, probes: () => probes };
}

test("a blip the server answers through never calls the room offline", async (t) => {
  const r = room(t, async () => true);
  r.wire.failed();
  await r.pass(500);
  assert.equal(r.wire.down, false);
  assert.deepEqual(r.said, []);
});

test("an outage is called only after the grace period, and not before", async (t) => {
  const r = room(t, async () => false);
  r.wire.failed();
  await r.pass(7000);
  assert.equal(r.wire.down, false, "still inside the grace period");
  await r.pass(2000);
  assert.equal(r.wire.down, true);
  assert.deepEqual(r.said, [true]);
});

test("a response inside the grace period settles the doubt; nothing was said", async (t) => {
  const r = room(t, async () => false);
  r.wire.failed(); r.wire.failed(); r.wire.failed();
  await r.pass(3000);
  r.wire.answered();
  await r.pass(10000);
  assert.equal(r.wire.down, false);
  assert.deepEqual(r.said, []);
});

test("while down it keeps asking, backing off, and notices the wire come back", async (t) => {
  let up = false;
  const r = room(t, async () => up);
  r.wire.failed();
  await r.pass(9000);
  assert.equal(r.wire.down, true);
  const at = r.probes();
  await r.pass(60000);
  assert.ok(r.probes() - at <= 5, `backs off: ${r.probes() - at} probes in a minute`);
  up = true;
  await r.pass(30000);
  assert.equal(r.wire.down, false);
  assert.deepEqual(r.said, [true, false]);
});

test("a hidden page stops asking once down; the next failure starts it again", async (t) => {
  let hidden = true;
  const r = room(t, async () => false, () => hidden);
  r.wire.failed();
  await r.pass(9000);
  assert.equal(r.wire.down, true);
  const at = r.probes();
  await r.pass(120000);
  assert.equal(r.probes(), at);
  hidden = false;
  r.wire.failed();
  await r.pass(250);
  assert.equal(r.probes(), at + 1);
});
