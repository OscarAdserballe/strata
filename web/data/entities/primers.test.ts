import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { primerKey, primerOps, type PrimerEntity } from "./primers.ts";

function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
    surface: () => {},
  });
  return { store, sent, m };
}

test("asking for a primer shows it as being written at once, and keeps a stale page up until the new one lands", async () => {
  const { store, sent, m } = room();
  store.apply<PrimerEntity>(primerKey("r1"), 3, { status: "stale", requestedAt: null, builtAt: 10, hasPage: true, rev: 3 }, "wire");
  const asked = m.mutate(primerOps.request("b1", "r1", store));
  assert.equal(store.get<PrimerEntity>(primerKey("r1"))?.status, "requested");
  assert.equal(store.get<PrimerEntity>(primerKey("r1"))?.hasPage, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.method, "POST");
  assert.equal(sent[0].req.path, "/api/boards/b1/resources/r1/primer");
  assert.ok(sent[0].req.headers["Idempotency-Key"], "one key, reused on every retry");
  sent[0].reply({ status: 200, body: { status: "requested", requestedAt: 20, builtAt: 10, hasPage: true, rev: 7 }, rev: 7, epoch: "" });
  await asked;
  assert.deepEqual(store.get<PrimerEntity>(primerKey("r1")), { status: "requested", requestedAt: 20, builtAt: 10, hasPage: true, rev: 7 });
});

test("a refused ask rolls back to what the source had", async () => {
  const { store, sent, m } = room();
  store.apply<PrimerEntity>(primerKey("r2"), 1, { status: "none", requestedAt: null, builtAt: null, hasPage: false, rev: 0 }, "wire");
  const asked = m.mutate(primerOps.request("b1", "r2", store)).catch((e: Error) => e);
  sent[0].reply({ status: 404, body: { error: "no such resource" }, rev: 1, epoch: "" });
  assert.ok(await asked instanceof Error);
  assert.equal(store.get<PrimerEntity>(primerKey("r2"))?.status, "none");
});
