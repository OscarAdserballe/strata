import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { Grades, RETRY_AFTER_MS, drillGradeRequest, gradeOp, reviewGradeRequest, type GradeRequest } from "./grades.ts";

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const answer = (status: number, body: unknown = {}): SendAnswer => ({ status, body, rev: 0, epoch: "" });

function harness() {
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let ids = 0;
  const setTimer = (fn: () => void, ms: number) => { const t = { id: ++ids, fn, ms }; timers.push(t); return t.id; };
  const clearTimer = (id: unknown) => { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); };
  const sent: { req: SendRequest; reply: ReturnType<typeof deferred<SendAnswer>> }[] = [];
  const wire = { isDown: false, down: () => wire.isDown, subscribe: () => () => {} };
  const m = new Mutator({
    store: new Store(), wire, setTimer, clearTimer, now: () => 0,
    transport: (req) => { const reply = deferred<SendAnswer>(); sent.push({ req, reply }); return reply.promise; },
  });
  const g = new Grades(m, { set: setTimer, clear: clearTimer });
  const fire = (ms: number) => {
    const at = timers.findIndex((t) => t.ms === ms);
    assert.ok(at >= 0, `a ${ms} ms timer is waiting (have: ${timers.map((t) => t.ms).join(", ") || "none"})`);
    const [t] = timers.splice(at, 1);
    t.fn();
  };
  return { m, g, sent, wire, fire, timers };
}
const req = (id: string, card = "c1", got = true): GradeRequest => ({ requestId: id, course: "deck", card, got, ms: 10 });

test("a grade is one op on the grades lane, keyed by its own receipt, body and key the same id", () => {
  const op = gradeOp(req("receipt-0001"));
  assert.deepEqual(op.lanes, ["grades"]);
  assert.equal(op.key, "receipt-0001");
  assert.equal((op.body as GradeRequest).requestId, "receipt-0001");
  assert.equal(op.path, "/api/review/grade");
  assert.ok(op.flush && op.keepalive);
});

test("the drill's and the review's requests: the drill names its board, the review none; a mint row is not a card", () => {
  const drill = drillGradeRequest({ id: "deck/c1", deck: "deck/x" }, true, { board: "b1", pass: 1, passes: 2, solo: false, pos: 3, ms: 12.4 }, "id-00000001");
  assert.deepEqual(drill, { requestId: "id-00000001", course: "deck", card: "deck/c1", got: true, surface: "drill", board: "b1", solo: false, pass: 1, passes: 2, pos: 3, ms: 12 });
  assert.equal(drillGradeRequest({ id: "mint:1", deck: "deck" }, true, { board: "b1" }), null);
  const review = reviewGradeRequest({ id: "c1", course: "deck" }, false, 900, "id-00000002");
  assert.deepEqual(review, { requestId: "id-00000002", course: "deck", card: "c1", got: false, ms: 900 });
  assert.match(drillGradeRequest({ id: "c", deck: "d" }, true, { board: "b" })!.requestId, /^[0-9a-f]{32}$/, "a minted receipt fits the server's pattern");
});

test("grades land in encounter order; the card is 'on its way' until its grade lands", async () => {
  const { g, sent } = harness();
  g.grade(req("first-0001", "c1", false));
  g.grade(req("second-001", "c2"));
  assert.equal(g.getSnapshot().pending, 2);
  assert.equal(g.hasCard("c1"), true);
  assert.equal(sent.length, 1, "one at a time");
  sent[0].reply.resolve(answer(200, { saved: true, at: 1 }));
  await tick();
  assert.equal(g.hasCard("c1"), false);
  assert.equal(JSON.parse(sent[1].req.body!).requestId, "second-001");
  sent[1].reply.resolve(answer(200, { saved: true, at: 2 }));
  await tick();
  assert.deepEqual(g.getSnapshot(), { pending: 0, error: null });
});

test("a lost answer is said while it waits, retried under the same receipt; Retry does not wait out the gap", async () => {
  const { g, sent, fire } = harness();
  g.grade(req("lost-00001"));
  sent[0].reply.reject(new Error("response lost"));
  await tick();
  assert.ok(g.getSnapshot().error, "said");
  fire(1000);
  await tick();
  assert.equal(sent[1].req.headers["Idempotency-Key"], "lost-00001");
  assert.equal(g.getSnapshot().error, null, "not said while the retry is out: it may yet land");
  sent[1].reply.resolve(answer(503, { error: "busy" }));
  await tick();
  assert.ok(g.getSnapshot().error);
  g.retry();
  await tick();
  assert.equal(sent.length, 3, "Retry does not wait out the gap");
  assert.equal(sent[2].req.body, sent[0].req.body);
  sent[2].reply.resolve(answer(200, { saved: true, at: 1 }));
  await tick();
  assert.deepEqual(g.getSnapshot(), { pending: 0, error: null });
});

test("a grade the server refuses for good is dropped and said once; the lane goes on", async () => {
  const { g, sent } = harness();
  const said: unknown[] = [];
  g.grade(req("gone-00001", "c1"), (e) => said.push(e));
  g.grade(req("gone-00002", "c2"), (e) => said.push(e));
  g.grade(req("kept-00003", "c3"), (e) => said.push(e));
  sent[0].reply.resolve(answer(404, { error: "No such card." }));
  await tick();
  sent[1].reply.resolve(answer(404, { error: "No such card." }));
  await tick();
  assert.equal(said.length, 1, "said once for the run");
  assert.equal((said[0] as { status: number }).status, 404);
  assert.equal(JSON.parse(sent[2].req.body!).requestId, "kept-00003");
  sent[2].reply.resolve(answer(200, { saved: true, at: 3 }));
  await tick();
  assert.equal(g.getSnapshot().pending, 0);
});

test("a grade out of retries is sent again on its own, under its receipt, until it lands", async () => {
  const { g, sent, fire } = harness();
  g.grade(req("stubborn-01"));
  for (const gap of [0, 1000, 2000, 4000, 8000, 16000, 16000]) {
    if (gap) fire(gap);
    await tick();
    sent[sent.length - 1].reply.resolve(answer(503));
    await tick();
  }
  assert.equal(sent.length, 7);
  assert.ok(g.getSnapshot().error);
  fire(RETRY_AFTER_MS);
  await tick();
  assert.equal(sent.length, 8);
  assert.equal(sent[7].req.headers["Idempotency-Key"], "stubborn-01");
  sent[7].reply.resolve(answer(200, { saved: true, at: 1 }));
  await tick();
  assert.deepEqual(g.getSnapshot(), { pending: 0, error: null });
});

test("offline is read-only: the grade is refused at once and said", async () => {
  const { g, sent, wire } = harness();
  wire.isDown = true;
  const said: { status?: number }[] = [];
  g.grade(req("offline-01"), (e) => said.push(e));
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(said[0]?.status, 0);
  assert.equal(g.getSnapshot().pending, 0);
});

test("signed out (401) is not a refusal: the grade is kept and sent again under its receipt", async () => {
  const { g, sent, fire } = harness();
  const said: unknown[] = [];
  g.grade(req("lapsed-0001"), (e) => said.push(e));
  sent[0].reply.resolve(answer(401, { error: "sign in again" }));
  await tick();
  assert.equal(g.getSnapshot().pending, 1, "kept, not dropped");
  assert.equal(said.length, 0, "nothing said lost");
  fire(1000);
  await tick();
  assert.equal(sent[1].req.headers["Idempotency-Key"], "lapsed-0001");
  sent[1].reply.resolve(answer(200, { saved: true, at: 1 }));
  await tick();
  assert.deepEqual(g.getSnapshot(), { pending: 0, error: null });
});

test("a drop said in the drill does not silence the review's own line", async () => {
  const { g, sent } = harness();
  const drill: unknown[] = [], review: unknown[] = [];
  g.grade({ ...req("drill-00001", "c1"), surface: "drill", board: "b" }, (e) => drill.push(e));
  sent[0].reply.resolve(answer(404, { error: "No such card." }));
  await tick();
  g.grade(req("review-0001", "c2"), (e) => review.push(e));
  sent[1].reply.resolve(answer(404, { error: "No such card." }));
  await tick();
  assert.equal(drill.length, 1);
  assert.equal(review.length, 1, "each surface says its own first drop");
});
