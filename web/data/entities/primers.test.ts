import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { applyBoardState, boardKey, type BoardEntity } from "./boards.ts";
import { primerOps, primers } from "./primers.ts";

const src = (id: string, primer?: object) => ({ id, filename: `${id}.md`, kind: "text", ...(primer ? { primer } : {}) });
const state = (rev: number, resources: object[]) => ({ board: { id: "b1", title: "t" }, resources, pairs: [], sections: [], trees: {}, messages: [], rev });

function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({ store, transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })), setTimer: () => 0, clearTimer: () => {} });
  applyBoardState(state(5, [src("r1"), src("r2", { status: "stale", requestedAt: null, builtAt: 7 })]) as never, { epoch: "" }, store);
  return { store, sent, m };
}
const primerOf = (s: Store, rid: string) => s.get<BoardEntity>(boardKey("b1"))?.resources.find((r) => r.id === rid)?.primer;

test("a press shows the source as asked for at once, and the board in the answer replaces the guess", async () => {
  const { store, sent, m } = room();
  const asking = m.mutate(primerOps.request("b1", "r1", 1000));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.method, "POST");
  assert.equal(sent[0].req.path, "/api/boards/b1/resources/r1/primer");
  assert.ok(sent[0].req.headers["Idempotency-Key"], "a lost answer is resent under one key");
  assert.deepEqual(primerOf(store, "r1"), { status: "requested", requestedAt: 1000, builtAt: null });
  sent[0].reply({ status: 200, body: { asked: true, woke: true, state: state(9, [src("r1", { status: "requested", requestedAt: 1200, builtAt: null }), src("r2")]) }, rev: 9, epoch: "" });
  await asking;
  assert.equal(store.entry(boardKey("b1"))?.layers.length, 0);
  assert.deepEqual(primerOf(store, "r1"), { status: "requested", requestedAt: 1200, builtAt: null });
});

test("rebuilding a stale primer keeps the old page showing while the new one is asked for, and a refusal puts it back", async () => {
  const { store, sent, m } = room();
  const asking = m.mutate(primerOps.request("b1", "r2", 2000)).catch((e) => e);
  assert.deepEqual(primerOf(store, "r2"), { status: "requested", requestedAt: 2000, builtAt: 7 });
  sent[0].reply({ status: 404, body: { error: "no such resource" }, rev: 0, epoch: "" });
  assert.equal((await asking).status, 404);
  assert.deepEqual(primerOf(store, "r2"), { status: "stale", requestedAt: null, builtAt: 7 }, "refused: as it was");
});

test("two presses on two sources wait in the board's lane, one behind the other", async () => {
  const { sent, m } = room();
  void m.mutate(primerOps.request("b1", "r1"));
  void m.mutate(primerOps.board("b1"));
  assert.equal(sent.length, 1, "the board's press waits for the source's");
  sent[0].reply({ status: 200, body: { asked: true, woke: false, state: state(9, [src("r1")]) }, rev: 9, epoch: "" });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].req.path, "/api/boards/b1/primers");
});

test("the wait reads the board again only past the rev it holds, so an agent's primer that landed before the first look is still seen", async () => {
  const { store } = room();
  let reads = 0;
  const read = async () => { reads++; return state(12, [src("r1", { status: "ready", requestedAt: 1, builtAt: 11 })]) as never; };
  assert.equal(await primers.catchUp("b1", 5, store, read), false, "the rev held: nothing to read");
  assert.equal(await primers.catchUp("b1", undefined, store, read), false);
  assert.equal(reads, 0);
  assert.equal(await primers.catchUp("b1", 12, store, read), true);
  assert.equal(reads, 1);
  assert.deepEqual(primerOf(store, "r1"), { status: "ready", requestedAt: 1, builtAt: 11 });
  assert.equal(await primers.catchUp("b1", 12, store, read), false, "caught up");
});
