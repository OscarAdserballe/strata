import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../data/store.ts";
import { Mutator, ATTEMPT_DEADLINE_MS, RETRY_DELAYS_MS, type Op, type SendAnswer, type SendRequest } from "../../data/mutate.ts";
import type { Card } from "../../../shared/types/index.ts";
import { baseOf, CardConflict, cardEditOp, cardKey, dropCard, dropCardOp, restoreCardOp, saveAuthored, saveCard } from "./saveCard.ts";
import { withDeadline } from "./tidy.ts";

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const answer = (status: number, body: unknown = {}): SendAnswer => ({ status, body, rev: 0, epoch: "" });
function harness() {
  const store = new Store();
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let ids = 0;
  const sent: { req: SendRequest; reply: ReturnType<typeof deferred<SendAnswer>> }[] = [];
  const m = new Mutator({
    store, wire: { down: () => false, subscribe: () => () => {} }, now: () => 0,
    setTimer: (fn, ms) => { const t = { id: ++ids, fn, ms }; timers.push(t); return t.id; },
    clearTimer: (id) => { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
    transport: (req) => { const reply = deferred<SendAnswer>(); sent.push({ req, reply }); return reply.promise; },
  });
  const fire = (ms: number) => { const at = timers.findIndex((t) => t.ms === ms); assert.ok(at >= 0); const [t] = timers.splice(at, 1); t.fn(); };
  return { m, store, sent, fire };
}
const card = (extra: Partial<Card> = {}): Card => ({ id: "course/flashcard/one", deck: "course/0-flashcard", type: "flashcard", ord: 0, front: "old q", back: "old a", rev: 7, ...extra } as Card);
const run = <T,>(m: Mutator, op: Op<T>) => m.mutate(op).then((v) => ({ ok: v }), (e) => ({ err: e }));

test("an edit is a PATCH in the card's lane, If-Match its rev; the merged card becomes card:<id>", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = run(m, cardEditOp(c, { back: "mine" }, store));
  assert.equal(sent[0].req.method, "PATCH");
  assert.equal(sent[0].req.path, "/api/decks/course/cards/course/flashcard/one");
  assert.equal(sent[0].req.headers["If-Match"], '"7"');
  assert.ok(sent[0].req.headers["Idempotency-Key"]);
  const merged = { ...c, back: "mine", edited: true, rev: 9 };
  sent[0].reply.resolve(answer(200, { ok: true, card: merged, rev: 9 }));
  assert.deepEqual(await out, { ok: { ok: true, card: merged, rev: 9 } });
  assert.deepEqual(store.get(cardKey(c.id)), merged);
  assert.equal(baseOf(c, store), 9, "the next edit of the stale list copy is based on what this room saved");
});

test("a 409 over faces this edit did not change: re-applied over the server's card, sent once more with its rev", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = run(m, cardEditOp(c, { back: "mine" }, store));
  const theirs = { ...c, front: "their q", rev: 8 };
  sent[0].reply.resolve(answer(409, { error: "changed elsewhere", conflict: { rev: 8, value: theirs } }));
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].req.headers["If-Match"], '"8"');
  assert.equal(sent[1].req.body, JSON.stringify({ back: "mine" }));
  sent[1].reply.resolve(answer(200, { ok: true, card: { ...theirs, back: "mine", rev: 10 }, rev: 10 }));
  const r = await out as { ok: { card: Card } };
  assert.equal(r.ok.card.front, "their q", "their question kept");
  assert.equal(r.ok.card.back, "mine", "my answer kept");
});

test("a 409 over a face this edit changed fails with both versions; the store holds theirs, so saving again is 'keep mine'", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = run(m, cardEditOp(c, { back: "mine" }, store));
  const theirs = { ...c, back: "theirs", rev: 8 };
  sent[0].reply.resolve(answer(409, { error: "changed elsewhere", conflict: { rev: 8, value: theirs } }));
  const r = await out as { err: { status: number; conflict: { value: Card } } };
  assert.equal(r.err.status, 409);
  assert.equal(r.err.conflict.value.back, "theirs");
  assert.equal(sent.length, 1, "never silently merged");
  assert.equal((store.get(cardKey(c.id)) as Card).back, "theirs");
  void run(m, cardEditOp(c, { back: "mine" }, store));
  assert.equal(sent[1].req.headers["If-Match"], '"8"', "'keep mine' is a new save over the new rev");
});

test("a lost answer is retried under the same key; an edit then a drop of one card keep their order", async () => {
  const { m, store, sent, fire } = harness();
  const c = card();
  const edit = run(m, cardEditOp(c, { back: "mine" }, store));
  const drop = run(m, dropCardOp(c));
  assert.equal(sent.length, 1, "the drop waits behind the edit in the card's lane");
  sent[0].reply.reject(new Error("response lost"));
  await tick();
  fire(1000);
  await tick();
  assert.equal(sent[1].req.headers["Idempotency-Key"], sent[0].req.headers["Idempotency-Key"]);
  sent[1].reply.resolve(answer(200, { ok: true, card: { ...c, back: "mine", rev: 9 }, rev: 9 }));
  await edit;
  await tick();
  assert.equal(sent[2].req.method, "DELETE");
  assert.equal(sent[2].req.path, "/api/decks/course/cards/course/flashcard/one");
  sent[2].reply.resolve(answer(200, { ok: true, total: 3 }));
  assert.deepEqual(await drop, { ok: { ok: true, total: 3 } });
});

test("an attempt that never answers is cut at the deadline and sent again under the same key", async () => {
  const { m, store, sent, fire } = harness();
  const c = card();
  void run(m, cardEditOp(c, { back: "mine" }, store));
  assert.equal(sent.length, 1);
  fire(ATTEMPT_DEADLINE_MS);
  await tick();
  assert.equal(sent.length, 1, "not resent at once: the first gap first");
  fire(RETRY_DELAYS_MS[0]);
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].req.headers["Idempotency-Key"], sent[0].req.headers["Idempotency-Key"]);
  assert.equal(sent[1].req.body, sent[0].req.body);
});

async function exhaust(h: ReturnType<typeof harness>, from: number) {
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    h.sent[from + i].reply.resolve(answer(503, { error: "busy" }));
    await tick();
    if (i < RETRY_DELAYS_MS.length) { h.fire(RETRY_DELAYS_MS[i]); await tick(); }
  }
}

test("an edit that ran out of retries is given up: the next Confirm and a delete go out, not queue behind it", async () => {
  const h = harness();
  const { m, store, sent } = h;
  const c = card();
  const first = saveCard(c, { back: "mine" }, m, store).then(() => null, (e) => e);
  await exhaust(h, 0);
  const e = await first;
  assert.equal(e.retryable, true, "the editor says why and keeps the draft");
  assert.deepEqual(m.pending(), [], "nothing left holding the card's lane");
  const was = sent.length;
  const again = saveCard(c, { back: "mine" }, m, store);
  assert.equal(sent.length, was + 1, "the second save is sent");
  assert.equal(sent[was].req.method, "PATCH");
  sent[was].reply.resolve(answer(200, { ok: true, card: { ...c, back: "mine", rev: 9 }, rev: 9 }));
  assert.equal((await again).back, "mine");
  const gone = dropCard(c, m).then(() => null, (err) => err);
  await exhaust(h, was + 1);
  assert.equal((await gone).retryable, true);
  assert.deepEqual(m.pending(), [], "a drop that ran out leaves the deck's lane free too");
});

test("saveCard: a 409 over a face this edit changed rejects with CardConflict carrying their card", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = saveCard(c, { back: "mine" }, m, store).then(() => null, (e) => e);
  const theirs = { ...c, back: "theirs", rev: 8 };
  sent[0].reply.resolve(answer(409, { error: "changed elsewhere", conflict: { rev: 8, value: theirs } }));
  const e = await out;
  assert.ok(e instanceof CardConflict);
  assert.equal(e.status, 409);
  assert.equal(e.theirs?.back, "theirs", "the editor's both-versions view");
  assert.deepEqual(e.mine, { back: "mine" });
  assert.deepEqual(m.pending(), []);
});

const at = (status: number, body: unknown, rev: number, epoch: string): SendAnswer => ({ status, body, rev, epoch });

test("late409: a card's refusal heard after a newer copy keeps that copy and settles the edit over it", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = run(m, cardEditOp(c, { back: "mine" }, store));
  store.apply(cardKey(c.id), 10, { ...c, front: "their newer q", rev: 10 }, "wire", { epoch: "boot-1" });
  sent[0].reply.resolve(at(409, { error: "changed elsewhere", conflict: { rev: 8, value: { ...c, front: "their q", rev: 8 } } }, 8, "boot-1"));
  await tick();
  assert.deepEqual([(store.get(cardKey(c.id)) as Card).front, store.entry(cardKey(c.id))?.rev], ["their newer q", 10], "the newer copy stays");
  assert.equal(sent.length, 2, "the answer this edit writes is as it was: sent again");
  assert.equal(sent[1].req.headers["If-Match"], '"10"', "over the copy the room holds");
  sent[1].reply.resolve(at(200, { ok: true, card: { ...c, front: "their newer q", back: "mine", rev: 11 }, rev: 11 }, 11, "boot-1"));
  assert.equal(((await out) as { ok: { card: Card } }).ok.card.front, "their newer q");
});

test("late409: saveCard over a face changed in a newer copy shows that copy as theirs", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = saveCard(c, { back: "mine" }, m, store).then(() => null, (e) => e);
  store.apply(cardKey(c.id), 10, { ...c, back: "theirs, newer", rev: 10 }, "wire", { epoch: "boot-1" });
  sent[0].reply.resolve(at(409, { error: "changed elsewhere", conflict: { rev: 8, value: { ...c, back: "theirs", rev: 8 } } }, 8, "boot-1"));
  const e = await out;
  assert.ok(e instanceof CardConflict);
  assert.equal(e.theirs?.back, "theirs, newer", "what the room holds, not the refused copy");
  assert.equal(sent.length, 1);
  void run(m, cardEditOp(c, { back: "mine" }, store));
  assert.equal(sent[1].req.headers["If-Match"], '"10"', "'keep mine' goes over it");
});

test("late409: saveAuthored over a face changed in a newer read of the row shows that row as theirs", async () => {
  const { m, store, sent } = harness();
  const row = { id: "m-1", front: "why?", back: "because", state: "closed", rev: 7 };
  store.apply("authored:b1", 8, [row], "wire", { epoch: "boot-1" });
  const out = saveAuthored("b1", "m-1", { back: "mine" }, m, store).then(() => null, (e) => e);
  await tick();
  store.apply("authored:b1", 12, [{ ...row, back: "theirs, newer", rev: 11 }], "wire", { epoch: "boot-1" });
  sent[0].reply.resolve(at(409, { error: "changed", conflict: { rev: 9, value: { ...row, back: "theirs", rev: 9 } } }, 9, "boot-1"));
  const e = await out;
  assert.ok(e instanceof CardConflict);
  assert.equal(e.theirs?.back, "theirs, newer");
  assert.equal(sent.length, 1);
});

test("late409: the copy the room holds changed the face this edit changes, the refused copy did not: said, not sent over it", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = saveCard(c, { back: "mine" }, m, store).then(() => null, (e) => e);
  store.apply(cardKey(c.id), 10, { ...c, back: "theirs, newer", rev: 10 }, "wire", { epoch: "boot-1" });
  sent[0].reply.resolve(at(409, { error: "changed elsewhere", conflict: { rev: 8, value: { ...c, front: "their q", rev: 8 } } }, 8, "boot-1"));
  await tick();
  assert.equal(sent.length, 1, "the back was changed in the copy the room holds: the edit is not sent over it");
  const e = await out;
  assert.ok(e instanceof CardConflict);
  assert.equal(e.theirs?.back, "theirs, newer");
});

test("saveAuthored on one row after another row's refusal raised the list shows the other device's back", async () => {
  const { m, store, sent } = harness();
  const row = (id: string, rev: number, back = "because") => ({ id, front: `${id}?`, back, state: "closed", rev });
  store.apply("authored:b1", 10, [row("m-A", 5), row("m-B", 6)], "wire", { epoch: "boot-1" });
  const a = saveAuthored("b1", "m-A", { back: "mine A" }, m, store).then(() => null, (e) => e);
  await tick();
  sent[0].reply.resolve(at(409, { error: "changed", conflict: { rev: 13, value: row("m-A", 13, "theirs A") } }, 13, "boot-1"));
  assert.equal((await a)?.theirs?.back, "theirs A");

  const b = saveAuthored("b1", "m-B", { back: "mine B" }, m, store).then(() => null, (e) => e);
  await tick();
  sent[1].reply.resolve(at(409, { error: "changed", conflict: { rev: 12, value: row("m-B", 12, "theirs B") } }, 12, "boot-1"));
  await tick();
  if (sent[2]) sent[2].reply.resolve(at(409, { error: "changed", conflict: { rev: 12, value: row("m-B", 12, "theirs B") } }, 12, "boot-1"));
  const e = await b;
  assert.ok(e instanceof CardConflict);
  assert.equal(e.theirs?.back, "theirs B", "theirs is the server's back, not this tab's old one");
  assert.equal(sent.length, 2, "said at the first refusal");
  void saveAuthored("b1", "m-B", { back: "mine B" }, m, store).catch(() => {});
  await tick();
  assert.equal(sent[2].req.headers["If-Match"], '"12"', "'keep mine' goes over B's rev");
});

for (const [bOld, aRev, bRev] of [[98, 40, 45], [98, 40, 30], [50, 60, 45]] as const) {
  test(`saveAuthored on a second row after a restore shows the restored server's back (B read at ${bOld}, A refused at ${aRev}, B at ${bRev})`, async () => {
    const { m, store, sent } = harness();
    const row = (id: string, rev: number, back = "because") => ({ id, front: `${id}?`, back, state: "closed", rev });
    store.apply("authored:b1", 100, [row("m-A", 95), row("m-B", bOld)], "wire", { epoch: "boot-1" });
    const a = saveAuthored("b1", "m-A", { back: "mine A" }, m, store).then(() => null, (e) => e);
    await tick();
    sent[0].reply.resolve(at(409, { error: "changed", conflict: { rev: aRev, value: row("m-A", aRev, "restored A") } }, 70, "boot-2"));
    assert.equal((await a)?.theirs?.back, "restored A");

    const b = saveAuthored("b1", "m-B", { back: "mine B" }, m, store).then(() => null, (e) => e);
    await tick();
    assert.equal(sent[1].req.headers["If-Match"], `"${bOld}"`);
    sent[1].reply.resolve(at(409, { error: "changed", conflict: { rev: bRev, value: row("m-B", bRev, "restored B") } }, 70, "boot-2"));
    await tick();
    if (sent[2]) sent[2].reply.resolve(at(409, { error: "changed", conflict: { rev: bRev, value: row("m-B", bRev, "restored B") } }, 70, "boot-2"));
    const e = await b;
    assert.ok(e instanceof CardConflict);
    assert.equal(e.theirs?.back, "restored B", "theirs is the restored server's back, not this tab's pre-restore one");
    assert.deepEqual(store.get<{ id: string; back: string; rev: number }[]>("authored:b1")?.map((r) => [r.back, r.rev]), [["restored A", aRev], ["restored B", bRev]], "the list holds B as the restored server does");
    assert.equal(sent.length, 2, "said at the first refusal");
    void saveAuthored("b1", "m-B", { back: "mine B" }, m, store).catch(() => {});
    await tick();
    assert.equal(sent[2].req.headers["If-Match"], `"${bRev}"`, "'keep mine' goes over B's restored rev");
  });
}

test("after a restore onto a backup, a card's refusal is taken at its lower rev and the edit settled over it", async () => {
  const { m, store, sent } = harness();
  const c = card();
  store.apply(cardKey(c.id), 9, { ...c, rev: 9 }, "wire", { epoch: "boot-1" });
  const out = run(m, cardEditOp(c, { back: "mine" }, store));
  assert.equal(sent[0].req.headers["If-Match"], '"9"');
  sent[0].reply.resolve(at(409, { error: "changed elsewhere", conflict: { rev: 4, value: { ...c, front: "restored q", rev: 4 } } }, 6, "boot-2"));
  await tick();
  const held = store.entry<Card>(cardKey(c.id));
  assert.deepEqual([held?.base?.front, held?.rev, held?.epoch], ["restored q", 4, "boot-2"], "what the server holds now");
  assert.equal(sent[1].req.headers["If-Match"], '"4"');
  sent[1].reply.resolve(at(200, { ok: true, card: { ...c, front: "restored q", back: "mine", rev: 7 }, rev: 7 }, 7, "boot-2"));
  await out;
});

test("saveCard refused a second time shows the second refusal's card as theirs, and holds it", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = saveCard(c, { back: "mine" }, m, store).then(() => null, (e) => e);
  await tick();
  sent[0].reply.resolve(at(409, { error: "changed elsewhere", conflict: { rev: 8, value: { ...c, front: "their q", rev: 8 } } }, 8, "boot-1"));
  await tick();
  assert.equal(sent.length, 2, "the front alone changed: sent again");
  assert.equal(sent[1].req.headers["If-Match"], '"8"');
  sent[1].reply.resolve(at(409, { error: "changed elsewhere", conflict: { rev: 9, value: { ...c, front: "their q", back: "their a", rev: 9 } } }, 9, "boot-1"));
  const e = await out;
  assert.ok(e instanceof CardConflict);
  assert.deepEqual([e.theirs?.back, e.theirs?.rev], ["their a", 9], "theirs is the card the server refused with last");
  const held = store.entry<Card>(cardKey(c.id));
  assert.deepEqual([held?.base?.back, held?.rev, held?.epoch], ["their a", 9, "boot-1"], "the room holds it");
  void run(m, cardEditOp(c, { back: "mine" }, store));
  assert.equal(sent[2].req.headers["If-Match"], '"9"', "'keep mine' goes over it");
});

test("saveCard refused a second time, after a newer copy was heard, keeps that copy as theirs", async () => {
  const { m, store, sent } = harness();
  const c = card();
  const out = saveCard(c, { back: "mine" }, m, store).then(() => null, (e) => e);
  await tick();
  sent[0].reply.resolve(at(409, { error: "changed elsewhere", conflict: { rev: 8, value: { ...c, front: "their q", rev: 8 } } }, 8, "boot-1"));
  await tick();
  store.apply(cardKey(c.id), 11, { ...c, front: "their q", back: "their newer a", rev: 11 }, "wire", { epoch: "boot-1" });
  sent[1].reply.resolve(at(409, { error: "changed elsewhere", conflict: { rev: 9, value: { ...c, front: "their q", back: "their a", rev: 9 } } }, 9, "boot-1"));
  const e = await out;
  assert.ok(e instanceof CardConflict);
  assert.deepEqual([e.theirs?.back, store.entry(cardKey(c.id))?.rev], ["their newer a", 11], "the slow refusal does not step the card back");
});

test("a restore goes to the card's restore route, in the same lanes as its drop", () => {
  const op = restoreCardOp(card());
  assert.equal(op.method, "POST");
  assert.equal(op.path, "/api/decks/course/cards/course/flashcard/one/restore");
  assert.deepEqual(op.lanes, dropCardOp(card()).lanes);
});

test("a card without a rev edits without If-Match (a server older than the revisions)", () => {
  const { store } = harness();
  assert.equal(cardEditOp(card({ rev: undefined }), { front: "x" }, store).base!(), null);
});

const raced = <T,>(p: Promise<T>, ms: number): Promise<T | "test-timeout"> =>
  Promise.race([p, new Promise<"test-timeout">((res) => setTimeout(() => res("test-timeout"), ms))]);

test("withDeadline (the tidy's): a call that never answers is rejected with a reason; a rejection passes through", async () => {
  const outcome = await raced(withDeadline(new Promise(() => {}), 20, "Tidying").then(() => "resolved", (e: Error) => e.message), 2000);
  assert.match(String(outcome), /didn't come back/);
  await assert.rejects(withDeadline(Promise.reject(new Error("HTTP 404")), 1000, "the save"), /HTTP 404/);
});

import { compiler } from "markdown-to-jsx";
import { MD_OPTIONS } from "../../engines/prose/render.ts";
import { tex } from "../../engines/prose/text.ts";

export const PASTED_CARD_BACK = `Framework runtimes dispatch requests directly to internal action handlers, bypassing standard REST route trees and their mounted middleware.

E.g. Next.js offers this to avoid boiler-plate letting us write things like this instead of making the API-calls:
\`\`\`

// Everything in one file, end-to-end type safety, zero fetch boilerplate
import { approveRun } from './actions'

<button onClick={() => approveRun('123')}>Approve</button>
\`\`\`

Internally, it also directly routes to the JS function rather than calling the API`;

test("a card face holding fenced JSX renders through the app's own markdown flags, promptly, raw HTML kept as text", async () => {
  const t0 = performance.now();
  const out = await raced(Promise.resolve().then(() => compiler(tex(PASTED_CARD_BACK), { ...MD_OPTIONS })), 3000);
  assert.notEqual(out, "test-timeout", "the parser stalled on the pasted card");
  assert.ok(performance.now() - t0 < 1000, "a card face must render in well under a second");
  const walk = (n: unknown): string => Array.isArray(n) ? n.map(walk).join("") : n && typeof n === "object" && "props" in (n as object) ? walk((n as { props: { children?: unknown } }).props.children) : String(n ?? "");
  assert.match(walk(out), /<button onClick=\{\(\) => approveRun\('123'\)\}>Approve<\/button>/);
});

test("a card you wrote, changed elsewhere, fails as a deck card does: CardConflict with their faces, the draft kept", async () => {
  const { m, store, sent } = harness();
  store.apply("authored:b1", 3, [{ id: "m-1", front: "why?", back: "because", state: "closed", rev: 7 }], "wire");
  const saving = saveAuthored("b1", "m-1", { back: "mine" }, m, store).then(() => assert.fail("expected a conflict"), (e) => e);
  await tick();
  assert.equal(sent[0].req.headers["If-Match"], '"7"');
  sent[0].reply.resolve(answer(409, { error: "changed", conflict: { rev: 9, value: { id: "m-1", front: "why?", back: "theirs", state: "closed" } } }));
  const e = await saving;
  assert.ok(e instanceof CardConflict, "the editors read e.theirs, not e.conflict");
  assert.deepEqual(e.theirs, { front: "why?", back: "theirs" });
  assert.deepEqual(e.mine, { back: "mine" });
  void saveAuthored("b1", "m-1", { back: "mine" }, m, store);
  await tick();
  assert.equal(sent[1].req.headers["If-Match"], '"9"');
});
