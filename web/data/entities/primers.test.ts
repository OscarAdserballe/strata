import { test } from "node:test";
import assert from "node:assert/strict";
import { sameData, Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { asPrimer, primerKey, primerOps, type PrimerEntity } from "./primers.ts";

function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
    surface: () => {},
  });
  store.apply<PrimerEntity>(primerKey("r1"), 3, { status: "none", requestedAt: null, builtAt: null }, "wire");
  return { store, sent, m };
}

test("asking for a primer shows it being written at once, and the answer becomes what the store holds", async () => {
  const { store, sent, m } = room();
  const asking = m.mutate(primerOps.request("b1", "r1", store));
  assert.equal(store.get<PrimerEntity>(primerKey("r1"))?.status, "requested");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.method, "POST");
  assert.equal(sent[0].req.path, "/api/boards/b1/resources/r1/primer");
  assert.ok(sent[0].req.headers["Idempotency-Key"], "a resend carries the same key");
  sent[0].reply({ status: 200, body: { status: "requested", requestedAt: 50, builtAt: null }, rev: 9, epoch: "" });
  await asking;
  assert.deepEqual(store.get<PrimerEntity>(primerKey("r1")), { status: "requested", requestedAt: 50, builtAt: null });
});

test("a refused ask rolls back to what was held", async () => {
  const { store, sent, m } = room();
  const asking = m.mutate(primerOps.request("b1", "r1", store));
  sent[0].reply({ status: 400, body: { error: "a Dispatch page is read as it is, without a primer" }, rev: 9, epoch: "" });
  await asking.catch(() => {});
  assert.equal(store.get<PrimerEntity>(primerKey("r1"))?.status, "none");
});

test("a look that finds nothing new keeps the view's identity, so nothing renders", () => {
  const { store } = room();
  const was = store.get<PrimerEntity>(primerKey("r1"));
  store.apply(primerKey("r1"), 4, asPrimer({ status: "none", requestedAt: null, builtAt: null }), "wire", { equal: sameData });
  assert.equal(store.get(primerKey("r1")), was);
  assert.equal(asPrimer({ status: "bogus" }).status, "none");
});
