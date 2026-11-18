import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { primerKey, primerOps, type Primer } from "./primers.ts";

function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({ store, transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })), setTimer: () => 0, clearTimer: () => {}, surface: () => {} });
  store.apply<Primer>(primerKey("r1"), 4, { status: "none", askedAt: null, builtAt: null, page: false }, "wire");
  return { store, sent, m };
}

test("asking shows the primer as asked at once, and the server's answer replaces it", async () => {
  const { store, sent, m } = room();
  const asking = m.mutate(primerOps.ask("b1", "r1", store, () => 1000));
  assert.deepEqual(store.get<Primer>(primerKey("r1")), { status: "asked", askedAt: 1000, builtAt: null, page: false });
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].req.method, sent[0].req.path], ["POST", "/api/boards/b1/resources/r1/primer"]);
  assert.ok(sent[0].req.headers["Idempotency-Key"], "an ask carries one key, reused on every retry");
  sent[0].reply({ status: 200, body: { status: "asked", askedAt: 1200, builtAt: null, page: false }, rev: 9, epoch: "" });
  await asking;
  assert.deepEqual(store.get<Primer>(primerKey("r1")), { status: "asked", askedAt: 1200, builtAt: null, page: false });
});

test("a refused ask rolls back to what was held", async () => {
  const { store, sent, m } = room();
  const asking = m.mutate(primerOps.ask("b1", "r1", store)).catch((e: Error) => e);
  sent[0].reply({ status: 404, body: { error: "no such resource" }, rev: 9, epoch: "" });
  assert.ok((await asking) instanceof Error);
  assert.equal(store.get<Primer>(primerKey("r1"))?.status, "none");
});
