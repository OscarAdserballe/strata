import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { primerKey, primerOps, primersTag, type PrimerEntity } from "./primers.ts";

function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
    surface: () => {},
  });
  store.apply<PrimerEntity>(primerKey("r1"), 0, { status: "none", requestedAt: null, builtAt: null, rev: 0 }, "wire");
  return { store, sent, m };
}

test("asking shows the primer as being written at once, and the answer confirms it", async () => {
  const { store, sent, m } = room();
  const asking = m.mutate(primerOps.request("b1", "r1", store));
  assert.equal(store.get<PrimerEntity>(primerKey("r1"))?.status, "requested");
  assert.equal(sent[0].req.path, "/api/boards/b1/resources/r1/primer");
  sent[0].reply({ status: 200, body: { primer: { status: "requested", requestedAt: 5, builtAt: null, rev: 7 } }, rev: 7, epoch: "" });
  await asking;
  assert.deepEqual(store.get<PrimerEntity>(primerKey("r1")), { status: "requested", requestedAt: 5, builtAt: null, rev: 7 });
});

test("a refused ask rolls back to what was there", async () => {
  const { store, sent, m } = room();
  const asking = m.mutate(primerOps.request("b1", "r1", store)).catch((e: Error) => e);
  sent[0].reply({ status: 400, body: { error: "Dispatch pages don't get primers." }, rev: 0, epoch: "" });
  assert.match(String(await asking), /Dispatch/);
  assert.equal(store.get<PrimerEntity>(primerKey("r1"))?.status, "none");
});

test("the board's press reads every open primer of that board again", () => {
  const op = primerOps.requestBoard("b1");
  assert.equal(op.path, "/api/boards/b1/primers");
  assert.deepEqual(op.invalidates, [primersTag("b1")]);
});
