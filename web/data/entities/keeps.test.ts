import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { keepOps, keeps, keepsKey, type KeptSet } from "./keeps.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
  });
  store.apply<KeptSet>(keepsKey("d1"), 3, { ids: ["a"] }, "wire");
  return { store, sent, m };
}
const ids = (store: Store) => store.get<KeptSet>(keepsKey("d1"))?.ids;

test("keep, let go, keep: three ops in the deck's lane, one card each, never the whole set", async () => {
  const { store, sent, m } = room();
  const one = keeps.toggle("d1", "b", true, m);
  const two = keeps.toggle("d1", "b", false, m);
  const three = keeps.toggle("d1", "b", true, m);
  assert.deepEqual(ids(store), ["a", "b"], "every toggle painted at once, folded in order");
  assert.equal(sent.length, 1, "the lane sends one at a time");
  assert.deepEqual(JSON.parse(sent[0].req.body!), { add: ["b"] });
  assert.match(sent[0].req.headers["Idempotency-Key"], /^[0-9a-f]{32}$/);
  // the first answer says b is kept; the take-back still showing must not be undone by it
  sent[0].reply({ status: 200, body: { ids: ["a", "b"], rev: 4 }, rev: 4, epoch: "" });
  await one; await tick();
  assert.deepEqual(store.entry<KeptSet>(keepsKey("d1"))?.base?.ids, ["a", "b"]);
  assert.deepEqual(ids(store), ["a", "b"], "the later toggles still lie over the answer");
  assert.deepEqual(JSON.parse(sent[1].req.body!), { remove: ["b"] });
  sent[1].reply({ status: 200, body: { ids: ["a"], rev: 5 }, rev: 5, epoch: "" });
  await two; await tick();
  assert.deepEqual(ids(store), ["a", "b"], "…and the last one too");
  sent[2].reply({ status: 200, body: { ids: ["a", "b"], rev: 6 }, rev: 6, epoch: "" });
  await three;
  assert.deepEqual(ids(store), ["a", "b"]);
  assert.equal(store.entry<KeptSet>(keepsKey("d1"))?.layers.length, 0);
});

test("a refused keep takes its layer back and leaves the lane free", async () => {
  const { store, sent, m } = room();
  const refused = keeps.toggle("d1", "z", true, m);
  assert.deepEqual(ids(store), ["a", "z"]);
  sent[0].reply({ status: 400, body: { error: "no such card" }, rev: 0, epoch: "" });
  await assert.rejects(refused, /no such card/);
  assert.deepEqual(ids(store), ["a"]);
  void keeps.toggle("d1", "a", false, m);
  await tick();
  assert.equal(sent.length, 2, "the next keep went out");
});

test("keeping a question waits in the deck's lane and in the question's own", () => {
  const op = keepOps.keepQuestion("d1", "b1", "m-1");
  assert.deepEqual(op.lanes, ["keeps:d1", "authored:m-1"]);
  assert.equal(op.path, "/api/decks/d1/keeps/minted");
  assert.deepEqual(op.body, { board: "b1", mint: "m-1" });
});
