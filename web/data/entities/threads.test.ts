import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../../../shared/types/index.ts";
import { Store } from "../store.ts";
import { applyBoardState, threadKey } from "./boards.ts";
import { Mutator, RETRY_DELAYS_MS, type SendAnswer, type SendRequest } from "../mutate.ts";
import { cleared, mergeNewest, mergeOlder, threadOps, threads, type ThreadEntity } from "./threads.ts";

const msg = (idx: number, resourceId: string | null = "r1"): Message => ({ role: idx % 2 ? "model" : "user", text: `m${idx}`, idx, resourceId });
const idxs = (t: ThreadEntity) => t.messages.map((m) => m.idx);

test("a reply saved after a read was answered survives that read arriving late", () => {
  const held: ThreadEntity = { messages: [msg(4), msg(5)], windowFrom: 0, before: null };
  // the read on return: it holds the question (stored first) but not the reply
  const late = mergeNewest(held, { messages: [msg(4)], before: null });
  assert.deepEqual(idxs(late), [4, 5], "the reply, newer than the read, stays");
});

test("a page that is the whole thread drops what it lacks inside its range, and below it", () => {
  const held: ThreadEntity = { messages: [msg(0), msg(1), msg(2), msg(3)], windowFrom: 0, before: null };
  assert.deepEqual(idxs(mergeNewest(held, { messages: [msg(8), msg(9)], before: null })), [8, 9], "archived by a clear elsewhere");
  assert.deepEqual(idxs(mergeNewest(held, { messages: [], before: null })), [], "an empty whole thread is empty");
});

test("a full page keeps the older pages beneath it, and an older page slides under", () => {
  const held: ThreadEntity = { messages: [msg(10), msg(11)], windowFrom: 0, before: 10 };
  const newest = mergeNewest(held, { messages: [msg(10), msg(11), msg(12), msg(13)], before: 10 });
  assert.deepEqual(idxs(newest), [10, 11, 12, 13]);
  const older = mergeOlder(newest, { messages: [msg(6), msg(7)], before: null });
  assert.deepEqual(idxs(older), [6, 7, 10, 11, 12, 13]);
  assert.equal(older.before, null, "nothing older");
});

test("a read that left before this device's clear never brings the cleared turns back", () => {
  const was: ThreadEntity = { messages: [msg(2), msg(3)], windowFrom: 0, before: null };
  const empty = cleared(was);
  assert.deepEqual(empty.messages, []);
  assert.deepEqual(idxs(mergeNewest(empty, { messages: [msg(2), msg(3)], before: null })), [], "the late read is all archived");
  assert.deepEqual(idxs(mergeNewest(empty, { messages: [msg(6)], before: null })), [6], "a turn asked after the clear shows");
});

test("a board snapshot older than the reply does not take the reply away from the store", () => {
  const s = new Store();
  const state = (messages: Message[]) => ({
    board: { id: "b1", title: "t", type: "board" }, messages, resources: [], budget: { usedTokens: 0, targetTokens: 1, over: false },
    deck: null, pairs: [], notes: "", trees: {}, sections: [], marks: [], minted: [], mintedEverywhere: [], windowFrom: {}, touched: {},
    plan: { purpose: "", groups: [], milestones: [], places: {} },
  }) as never;
  // the turn's own answer: question and reply
  applyBoardState(state([msg(4), msg(5)]), { thread: "r1" }, s);
  // a read of the same thread from before the reply was saved, arriving after it
  applyBoardState(state([msg(4)]), { thread: "r1" }, s);
  assert.deepEqual(idxs(s.get<ThreadEntity>(threadKey("b1", "r1"))!), [4, 5]);
});

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("a clear names its thread's path and lane; a card thread's answer has nothing to apply", () => {
  const board = threadOps.clear({ board: "b1", rid: "r 1" }, "thread:b1:r1");
  assert.equal(board.path, "/api/boards/b1/messages?resource=r%201");
  assert.deepEqual(board.lanes, ["thread:b1:r1"]);
  assert.equal(board.confirm, undefined, "a board's answer is its state, applied by shape");
  const card = threadOps.clear({ deck: "d1", card: "c1" }, "thread:card:d1:c1");
  assert.equal(card.path, "/api/review/chat?course=d1&card=c1");
  assert.equal(typeof card.confirm, "function");
});

test("a clear out of retries on 503s gives its lane back: nothing pending, and the next clear is sent", async () => {
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const m = new Mutator({
    store: new Store(),
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  const busy: SendAnswer = { status: 503, body: { error: "busy" }, rev: 0, epoch: "" };
  const first = threads.clear({ board: "b1" }, "thread:b1", m).then(() => assert.fail("expected the clear to fail"), (e) => e);
  await tick();
  sent[0].reply(busy);
  await tick();
  for (const gap of RETRY_DELAYS_MS) {
    const at = timers.findIndex((t) => t.ms === gap);
    assert.ok(at >= 0, `a ${gap} ms retry is waiting`);
    timers.splice(at, 1)[0].fn();
    await tick();
    sent.at(-1)!.reply(busy);
    await tick();
  }
  assert.equal((await first).retryable, true);
  assert.deepEqual(m.pending(), [], "the lane is free, the page can settle, no leave-site guard");
  void threads.clear({ board: "b1" }, "thread:b1", m);
  await tick();
  assert.equal(sent.length, RETRY_DELAYS_MS.length + 2, "the next clear went out at once");
});
