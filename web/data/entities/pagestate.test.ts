import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { pageStateKey, pageStateOps, type PageStateEntity } from "./pagestate.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
    surface: () => {},
  });
  store.apply<PageStateEntity>(pageStateKey("r1"), 4, { value: '{"a":1}', rev: 4 }, "wire");
  return { store, sent, m };
}

test("a page's saves go out over the rev held, and a newer save replaces one still waiting", async () => {
  const { store, sent, m } = room();
  const one = m.mutate(pageStateOps.save("b1", "r1", '{"a":2}', store));
  const two = m.mutate(pageStateOps.save("b1", "r1", '{"a":3}', store));
  const three = m.mutate(pageStateOps.save("b1", "r1", '{"a":4}', store));
  assert.equal(store.get<PageStateEntity>(pageStateKey("r1"))?.value, '{"a":4}');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.path, "/api/boards/b1/resources/r1/state");
  assert.equal(sent[0].req.headers["If-Match"], '"4"');
  sent[0].reply({ status: 200, body: { rev: 9 }, rev: 9, epoch: "" });
  await one;
  await tick();
  assert.equal(sent.length, 2, "the middle save was replaced, never sent");
  assert.equal(JSON.parse(sent[1].req.body!).value, '{"a":4}');
  assert.equal(sent[1].req.headers["If-Match"], '"9"');
  sent[1].reply({ status: 200, body: { rev: 11 }, rev: 11, epoch: "" });
  await Promise.all([two, three]);
  assert.deepEqual(store.get<PageStateEntity>(pageStateKey("r1")), { value: '{"a":4}', rev: 11 });
});

test("over a save from another tab, the newest save is sent again over theirs: last save wins", async () => {
  const { store, sent, m } = room();
  const saving = m.mutate(pageStateOps.save("b1", "r1", '{"mine":1}', store));
  sent[0].reply({ status: 409, body: { error: "changed elsewhere", conflict: { rev: 7, value: { value: '{"theirs":1}' } } }, rev: 7, epoch: "" });
  await tick();
  assert.equal(sent.length, 2, "rebuilt once over the current rev");
  assert.equal(sent[1].req.headers["If-Match"], '"7"');
  assert.equal(JSON.parse(sent[1].req.body!).value, '{"mine":1}');
  sent[1].reply({ status: 200, body: { rev: 8 }, rev: 8, epoch: "" });
  await saving;
  assert.deepEqual(store.get<PageStateEntity>(pageStateKey("r1")), { value: '{"mine":1}', rev: 8 });
});
