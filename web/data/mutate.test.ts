import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { Mutator, RETRY_DELAYS_MS, ATTEMPT_DEADLINE_MS, type Failure, type Op, type SaveError, type SendAnswer, type SendRequest } from "./mutate.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const answer = (status: number, body: unknown = {}, rev = 0, epoch = ""): SendAnswer => ({ status, body, rev, epoch });
const failure = (p: Promise<unknown>) => p.then(() => assert.fail("expected the save to be rejected"), (e: SaveError) => e);
const lost = () => Object.assign(new Error("Failed to fetch"), { name: "TypeError" });

/* a Mutator whose wire, clock, timers and server are in the test's hands */
function harness() {
  const clock = { now: 1_000_000 };
  const store = new Store({ now: () => clock.now });
  const timers: { id: number; fn: () => void; ms: number; due: number }[] = [];
  let ids = 0;
  const listeners = new Set<() => void>();
  const wire = {
    isDown: false,
    down: () => wire.isDown,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    set(down: boolean) { wire.isDown = down; for (const cb of [...listeners]) cb(); },
  };
  const sent: { req: SendRequest; reply: ReturnType<typeof deferred<SendAnswer>> }[] = [];
  const surfaced: Failure[] = [];
  let cleared = 0;
  const m = new Mutator({
    store, wire,
    transport: (req) => { const reply = deferred<SendAnswer>(); sent.push({ req, reply }); return reply.promise; },
    setTimer: (fn, ms) => { const t = { id: ++ids, fn, ms, due: clock.now + ms }; timers.push(t); return t.id; },
    clearTimer: (id) => { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
    now: () => clock.now,
    clearReads: () => { cleared++; },
    surface: (f) => surfaced.push(f),
  });
  /** fire the pending timer of this length (the retry gap, or the deadline) */
  const fire = (ms: number) => {
    const at = timers.findIndex((t) => t.ms === ms);
    assert.ok(at >= 0, `a ${ms} ms timer is waiting (have: ${timers.map((t) => t.ms).join(", ") || "none"})`);
    const [t] = timers.splice(at, 1);
    clock.now = Math.max(clock.now, t.due);
    t.fn();
  };
  const retryGaps = () => timers.filter((t) => t.ms !== ATTEMPT_DEADLINE_MS).map((t) => t.ms);
  return { m, store, wire, sent, surfaced, timers, clock, fire, retryGaps, cleared: () => cleared };
}

const op = (lanes: string[], extra: Partial<Op> = {}): Op => ({ label: "save it", lanes, method: "POST", path: "/api/thing", body: { lanes }, ...extra });

test("lanes run FIFO; an op heads every lane it names before it starts; other lanes run alongside", async () => {
  const { m, sent } = harness();
  const a = m.mutate(op(["mark:1"], { body: "a" }));
  const b = m.mutate(op(["mark:1"], { body: "b" }));
  const c = m.mutate(op(["mark:2"], { body: "c" }));
  const both = m.mutate(op(["mark:1", "mark:2"], { body: "both" }));
  assert.deepEqual(sent.map((s) => JSON.parse(s.req.body!)), ["a", "c"], "one per lane at a time; another lane at once");
  sent[0].reply.resolve(answer(200, { n: "a" }));
  assert.deepEqual(await a, { n: "a" });
  await tick();
  assert.deepEqual(sent.map((s) => JSON.parse(s.req.body!)), ["a", "c", "b"], "b next in its lane");
  sent[2].reply.resolve(answer(200));
  await tick();
  assert.equal(sent.length, 3, "`both` waits: it is not yet the head of mark:2");
  sent[1].reply.resolve(answer(200));
  await tick();
  assert.deepEqual(JSON.parse(sent[3].req.body!), "both");
  sent[3].reply.resolve(answer(200));
  await Promise.all([b, c, both]);
  assert.deepEqual(m.pending(), []);
});

test("a lost answer is retried after 1, 2, 4, 8, 16 and 16 s with the same key and bytes, then held as failed", async () => {
  const { m, sent, fire, retryGaps } = harness();
  const rejected = failure(m.mutate(op(["notes:b"], { body: { text: "the log" } })));
  const gaps: number[] = [];
  sent[0].reply.reject(lost());
  await tick();
  for (const ms of RETRY_DELAYS_MS) {
    gaps.push(...retryGaps());
    assert.equal(m.pending()[0].state, "retrying");
    fire(ms);
    await tick();
    assert.equal(m.pending()[0].state, "sending");
    sent.at(-1)!.reply.reject(lost());
    await tick();
  }
  assert.deepEqual(gaps, [1000, 2000, 4000, 8000, 16000, 16000]);
  assert.equal(sent.length, 7, "the first send and six retries");
  const keys = new Set(sent.map((s) => s.req.headers["Idempotency-Key"]));
  assert.equal(keys.size, 1, "one key for every attempt");
  assert.match([...keys][0], /^[0-9a-f]{32}$/, "16 random bytes, hex");
  assert.ok(sent.every((s) => s.req.body === '{"text":"the log"}'), "the body serialized once, resent byte-identical");
  const e = await rejected;
  assert.equal(e.retryable, true, "the promise says it may be retried");
  assert.equal(m.pending()[0].state, "failed");
  assert.equal(retryGaps().length, 0, "no more attempts on its own");
});

test("408, 425, 429 and 5xx are retried like a lost answer; the deadline counts as one and aborts the attempt", async () => {
  for (const status of [408, 425, 429, 500, 503]) {
    const { m, sent, fire } = harness();
    const saving = m.mutate(op(["x"]));
    sent[0].reply.resolve(answer(status, { error: "busy" }));
    await tick();
    assert.equal(m.pending()[0].state, "retrying", `${status} retries`);
    fire(1000);
    await tick();
    sent[1].reply.resolve(answer(200, { ok: status }));
    assert.deepEqual(await saving, { ok: status });
  }
  const { m, sent, fire } = harness();
  const saving = m.mutate(op(["x"]));
  fire(ATTEMPT_DEADLINE_MS);                     // twenty seconds and no answer
  await tick();
  assert.equal(sent[0].req.signal?.aborted, true, "the hung request is aborted");
  assert.equal(m.pending()[0].state, "retrying");
  sent[0].reply.resolve(answer(200, { late: true })); // a late answer after the deadline is ignored
  await tick();
  assert.equal(m.pending().length, 1);
  fire(1000);
  await tick();
  assert.equal(sent[1].req.headers["Idempotency-Key"], sent[0].req.headers["Idempotency-Key"]);
  sent[1].reply.resolve(answer(200, { second: true }));
  assert.deepEqual(await saving, { second: true });
});

test("the deadline is retried even when the transport rejects the moment it is aborted, as fetch does", async () => {
  const { m, fire } = harness();
  const aborted = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  m.configure({ transport: (req) => new Promise<SendAnswer>((_, reject) => req.signal?.addEventListener("abort", () => reject(aborted()))) });
  void m.mutate(op(["x"])).catch(() => {});
  fire(ATTEMPT_DEADLINE_MS);
  await tick();
  assert.deepEqual(m.pending().map((p) => [p.state, p.attempts]), [["retrying", 1]], "a lost answer, not a page going away");
});

test("a failed head holds only its own lanes, until it is retried or discarded", async () => {
  const { m, sent, fire } = harness();
  const head = failure(m.mutate(op(["card:1"], { body: "head" })));
  const behind = m.mutate(op(["card:1"], { body: "behind" }));
  const elsewhere = m.mutate(op(["card:2"], { body: "elsewhere" }));
  sent[0].reply.reject(lost());
  sent[1].reply.resolve(answer(200));
  await elsewhere;
  for (const ms of RETRY_DELAYS_MS) { await tick(); fire(ms); await tick(); sent.at(-1)!.reply.reject(lost()); }
  await tick();
  assert.equal((await head).retryable, true);
  const failed = m.pending().find((p) => p.state === "failed")!;
  assert.ok(failed);
  const more = m.mutate(op(["card:3"], { body: "more" }));
  await tick();
  assert.equal(JSON.parse(sent.at(-1)!.req.body!), "more", "another lane is not held");
  sent.at(-1)!.reply.resolve(answer(200));
  await more;
  assert.ok(!sent.some((s) => s.req.body === '"behind"'), "the op behind the failed head waits");
  m.retry(failed.id);
  m.retry(failed.id);                            // repeated clicks never start two
  await tick();
  assert.equal(sent.filter((s) => s.req.body === '"head"').length, 8, "one resend");
  assert.equal(sent.at(-1)!.req.headers["Idempotency-Key"], sent[0].req.headers["Idempotency-Key"], "retry(id) keeps the key");
  sent.at(-1)!.reply.reject(lost());
  await tick();
  // …or give up on it: its lane moves on
  m.discard(failed.id);
  await tick();
  assert.equal(JSON.parse(sent.at(-1)!.req.body!), "behind");
  sent.at(-1)!.reply.resolve(answer(200));
  await behind;
});

test("while the wire is down the retry clock is paused, not spent; accepted ops finish when it returns", async () => {
  const { m, sent, fire, wire, clock, retryGaps } = harness();
  const first = m.mutate(op(["x"], { body: 1 }));
  const second = m.mutate(op(["x"], { body: 2 }));
  sent[0].reply.reject(lost());
  await tick();
  fire(1000); await tick(); sent[1].reply.reject(lost()); await tick();
  fire(2000); await tick(); sent[2].reply.reject(lost()); await tick();
  assert.deepEqual(retryGaps(), [4000]);
  clock.now += 1500;                              // 1.5 s of the 4 s spent…
  wire.set(true);                                 // …then the wire goes down
  assert.deepEqual(retryGaps(), [], "the clock stops");
  clock.now += 60_000;
  wire.set(false);
  assert.deepEqual(retryGaps(), [2500], "and runs on from where it stopped");
  fire(2500);
  await tick();
  wire.set(true);
  sent[3].reply.resolve(answer(200));
  await first;
  await tick();
  assert.equal(sent.length, 4, "the op behind waits for the wire, not refused");
  wire.set(false);
  await tick();
  assert.equal(sent.length, 5);
  sent[4].reply.resolve(answer(200));
  await second;
});

test("offline refuses a new write at once, painting nothing", async () => {
  const { m, sent, store, wire } = harness();
  store.apply("notes:b", 1, { text: "server" }, "wire");
  wire.set(true);
  const e = await failure(m.mutate(op(["notes:b"], { optimistic: [{ key: "notes:b", apply: () => ({ text: "mine" }) }] })));
  assert.equal(e.status, 0, "refuseWrite's status: StrataReason says offline is read-only");
  assert.deepEqual(store.get("notes:b"), { text: "server" });
  assert.equal(sent.length, 0);
  assert.deepEqual(m.pending(), []);
});

test("2xx confirms: the answer becomes the base and the layer goes in one notification (a replay too)", async () => {
  const { m, sent, store } = harness();
  store.apply("marks:b", 4, [{ id: "mk-old" }], "wire");
  let heard = 0;
  store.subscribe("marks:b", () => { heard++; });
  const making = m.mutate(op(["mark:mk-new"], {
    path: "/api/boards/b/marks", key: "mk-new",
    optimistic: [{ key: "marks:b", apply: (l: { id: string }[]) => [...l, { id: "mk-new", painted: true }] }],
  }));
  assert.deepEqual(store.get("marks:b"), [{ id: "mk-old" }, { id: "mk-new", painted: true }], "painted first");
  assert.equal(sent[0].req.headers["Idempotency-Key"], "mk-new", "a domain id is the key");
  heard = 0;
  sent[0].reply.resolve({ ...answer(200, { id: "mk-new", mark: { id: "mk-new", saved: true }, rev: 9 }, 12), replay: true });
  await making;
  assert.equal(heard, 1, "one notification");
  assert.deepEqual(store.get("marks:b"), [{ id: "mk-old" }, { id: "mk-new", saved: true }], "the confirmed row, by shape");
  assert.equal(store.entry("marks:b")?.rev, 9);
  assert.equal(store.entry("marks:b")?.layers.length, 0);
});

test("invalidation happens at the start; the reads kept warm are dropped; the queries are asked again past the stamp", async () => {
  const { m, sent, store, cleared } = harness();
  const reads: number[] = [];
  store.watch("register", () => {}, async () => { reads.push(reads.length); return { value: reads.length, rev: 10 * reads.length, stamp: 10 * reads.length, epoch: "", origin: "wire" }; }, ["register"]);
  await tick();
  assert.equal(reads.length, 1);
  const before = cleared();
  const renaming = m.mutate(op(["source:r"], { invalidates: ["register"] }));
  assert.equal(store.entry("register")?.stale, true, "stale at START, before any answer");
  assert.equal(cleared(), before + 1, "prefetched and in-flight reads dropped at enqueue");
  assert.equal(reads.length, 1, "not asked while the write is out");
  sent[0].reply.resolve(answer(200, { ok: true }, 50));
  await renaming;
  await tick();
  assert.equal(reads.length, 2, "asked again once the write settled");
});

test("409 with the current value: the store takes it, the op rebuilds itself once at the head of its lane (what was composed behind it fails), a second 409 is surfaced", async () => {
  const { m, sent, store, surfaced } = harness();
  store.apply("plan:b", 3, { order: ["a", "b"], rev: 3 }, "wire");   // a read whose board rev is the plan's last write
  const gesture = (plan: { order: string[]; rev: number }): Op => ({
    label: "move that source", lanes: ["plan:b"], method: "PUT", path: "/api/boards/b/plan/order",
    body: { items: [...plan.order].reverse() },
    base: () => (store.entry<{ rev: number }>("plan:b")?.base?.rev ?? null),
    optimistic: [{ key: "plan:b", apply: (p: { order: string[] }) => ({ ...p, order: [...p.order].reverse() }) }],
    takeConflict: { key: "plan:b", fold: (held, c) => ({ ...held, ...(c.value as object), rev: c.rev }) },
    onConflict: () => gesture(store.entry<{ order: string[]; rev: number }>("plan:b")!.base!),
  });
  const moving = failure(m.mutate(gesture(store.get("plan:b")!)));
  const composed = failure(m.mutate(gesture(store.get("plan:b")!)));   // a second drag, over the same stale plan
  const behind = m.mutate(op(["plan:b"], { body: "behind" }));
  assert.equal(sent[0].req.headers["If-Match"], '"3"', "the base rev, read at send time");
  sent[0].reply.resolve(answer(409, { error: "changed elsewhere", conflict: { rev: 5, value: { order: ["c", "a", "b"] } } }));
  await tick();
  assert.deepEqual(store.entry("plan:b")?.base, { order: ["c", "a", "b"], rev: 5 }, "no round trip: the 409 carried the value");
  const stale = await composed;
  assert.deepEqual([stale.status, stale.conflict?.rev], [409, 5], "a whole-document op queued behind fails with the conflict, never sent over rev 5");
  assert.equal(surfaced.shift()?.label, "move that source");
  assert.equal(sent.length, 2, "the rebuilt op went before the one behind it");
  assert.equal(sent[1].req.headers["If-Match"], '"5"');
  assert.deepEqual(JSON.parse(sent[1].req.body!), { items: ["b", "a", "c"] }, "rebuilt from the gesture over the new value");
  assert.notEqual(sent[1].req.headers["Idempotency-Key"], sent[0].req.headers["Idempotency-Key"], "a new request, a new key");
  sent[1].reply.resolve(answer(409, { error: "changed elsewhere", conflict: { rev: 6, value: { order: ["d"] } } }));
  const e = await moving;
  assert.equal(e.status, 409);
  assert.deepEqual(e.conflict, { rev: 6, value: { order: ["d"] } });
  assert.equal(surfaced.length, 1, "a second 409 is said, never retried");
  assert.equal(surfaced[0].label, "move that source");
  assert.deepEqual(store.get("plan:b"), { order: ["d"], rev: 6 }, "its layer rolled back over the newest value");
  await tick();
  assert.equal(JSON.parse(sent[2].req.body!), "behind", "the lane moves on");
  sent[2].reply.resolve(answer(200));
  await behind;
});

test("any other 4xx rolls the layers back, settles as failed and says why", async () => {
  for (const [status, body] of [[422, { error: "this Idempotency-Key was already used for a different request" }], [409, { error: "no conflict value" }], [404, {}]] as const) {
    const { m, sent, store, surfaced } = harness();
    store.apply("card:c1", 2, { front: "server" }, "wire");
    const editing = failure(m.mutate(op(["card:c1"], { label: "save the card", optimistic: [{ key: "card:c1", apply: () => ({ front: "mine" }) }] })));
    assert.deepEqual(store.get("card:c1"), { front: "mine" });
    sent[0].reply.resolve(answer(status, body));
    const e = await editing;
    assert.equal(e.status, status);
    assert.equal(e.retryable, undefined, "not retryable: refused, not lost");
    assert.deepEqual(store.get("card:c1"), { front: "server" }, `${status}: rolled back`);
    assert.equal(surfaced.length, 1);
    assert.equal(surfaced[0].label, "save the card");
    assert.equal(surfaced[0].error.message, "error" in body ? body.error : `HTTP ${status}`);
    assert.deepEqual(m.pending(), []);
  }
});

test("a queued, unsent op is replaced by a newer one with the same coalesce key; both callers hear the last answer", async () => {
  const { m, sent, store } = harness();
  store.apply("notes:b", 1, { text: "" }, "wire");
  const save = (text: string) => m.mutate(op(["notes:b"], {
    body: { text }, coalesce: "notes:b", optimistic: [{ key: "notes:b", apply: (v: object) => ({ ...v, text }) }],
  }));
  const one = save("a");
  const two = save("ab");
  const three = save("abc");
  assert.equal(sent.length, 1, "the first is on the wire");
  assert.equal(m.pending().length, 2, "the second was replaced by the third");
  assert.deepEqual(store.get("notes:b"), { text: "abc" });
  assert.equal(store.entry("notes:b")?.layers.length, 2, "the replaced op's layer went with it");
  sent[0].reply.resolve(answer(200, { n: 1 }));
  assert.deepEqual(await one, { n: 1 });
  await tick();
  assert.deepEqual(sent.map((s) => JSON.parse(s.req.body!).text), ["a", "abc"]);
  sent[1].reply.resolve(answer(200, { n: 3 }));
  assert.deepEqual(await two, { n: 3 }, "the replaced caller gets the answer to the text that replaced it");
  assert.deepEqual(await three, { n: 3 });
});

test("settled() resolves when nothing is pending, a failed op included; the registry is a stable snapshot", async () => {
  const { m, sent, fire } = harness();
  await m.settled();                              // nothing pending: at once
  const states: string[][] = [];
  m.subscribePending(() => states.push(m.pending().map((p) => p.state)));
  const snapshot = m.pending();
  assert.equal(m.pending(), snapshot, "unchanged registry, same array");
  let done = false;
  const saving = m.mutate(op(["x"], { label: "grade" })).catch(() => {});
  const waiting = m.settled().then(() => { done = true; });
  sent[0].reply.reject(lost());
  for (const ms of RETRY_DELAYS_MS) { await tick(); fire(ms); await tick(); sent.at(-1)!.reply.reject(lost()); }
  await saving;
  await tick();
  assert.equal(done, false, "a failed op is still pending");
  assert.deepEqual(m.pending().map((p) => [p.label, p.state, p.attempts]), [["grade", "failed", 7]]);
  m.discard(m.pending()[0].id);
  await waiting;
  assert.equal(done, true);
  assert.deepEqual(states[0], ["queued"]);
  assert.deepEqual(states.at(-1), []);
});

test("on pagehide each lane's unacknowledged flush op goes again with keepalive, smallest first; a newer coalesced save stands for its lane", async () => {
  const { m, sent } = harness();
  const win = new EventTarget() as EventTarget & { __strataSettled?: () => Promise<void> };
  m.install(win as unknown as Window);
  assert.equal(typeof win.__strataSettled, "function", "the suites' settled signal");
  const big = "x".repeat(40 * 1024);
  void m.mutate(op(["notes:b"], { body: { text: "head" }, flush: true, coalesce: "notes:b" }));
  void m.mutate(op(["notes:b"], { body: { text: "latest" }, flush: true, coalesce: "notes:b" }));
  void m.mutate(op(["grades"], { body: { requestId: "g1" }, key: "g1", flush: true }));
  void m.mutate(op(["grades"], { body: { requestId: "g2" }, key: "g2", flush: true }));   // not a head, not coalesced
  void m.mutate(op(["card:1"], { body: { text: "not flushed" } }));
  void m.mutate(op(["card:2"], { body: { text: big }, flush: true }));                   // over 32 KB
  const before = sent.length;
  let prompted = false;
  win.addEventListener("beforeunload", (e) => { prompted = e.defaultPrevented; });
  win.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  assert.equal(prompted, true, "anything pending: the unsaved prompt");
  win.dispatchEvent(new Event("pagehide"));
  const flushed = sent.slice(before);
  assert.ok(flushed.every((s) => s.req.keepalive === true));
  assert.deepEqual(flushed.map((s) => s.req.body), ['{"text":"latest"}', '{"requestId":"g1"}'], "the head's older text adds nothing");
  const g1 = flushed.find((s) => s.req.body === '{"requestId":"g1"}')!;
  assert.equal(g1.req.headers["Idempotency-Key"], "g1", "the same key: the receipt makes it harmless");
});

test("a whole-document save waiting behind its in-flight head is flushed alone, without If-Match, and keeps its key after", async () => {
  const { m, sent } = harness();
  let rev = 7;
  const save = (text: string) => op(["notes:b"], { body: { text }, base: () => rev, flush: true, coalesce: "notes:b" });
  void m.mutate(save("a"));                       // in flight with If-Match "7"
  void m.mutate(save("ab"));                      // waiting: its base is not known until "a" answers
  assert.equal(sent[0].req.headers["If-Match"], '"7"');
  m.flush();
  assert.equal(sent.length, 2, "one request for the lane");
  assert.equal(sent[1].req.body, '{"text":"ab"}');
  assert.equal(sent[1].req.headers["If-Match"], undefined, "last writer wins: \"a\" can no longer refuse it, and \"a\" is refused if it lands after");
  const key = sent[1].req.headers["Idempotency-Key"];
  // back from the bfcache: what left can no longer be coalesced away under a new key
  void m.mutate(save("abc"));
  assert.deepEqual(m.pending().map((p) => p.state), ["sending", "queued", "queued"], "\"abc\" queues behind the flushed save");
  rev = 9;
  sent[0].reply.resolve(answer(200, {}, 9));
  await tick();
  assert.equal(sent[2].req.body, '{"text":"ab"}');
  assert.equal(sent[2].req.headers["Idempotency-Key"], key, "the flushed save keeps its key");

  // a lone head is the same request again, If-Match included
  const solo = harness();
  void solo.m.mutate(op(["notes:c"], { body: { text: "x" }, base: () => 3, flush: true, coalesce: "notes:c" }));
  solo.m.flush();
  assert.equal(solo.sent[1].req.headers["If-Match"], '"3"');
});

test("an op marked keepalive sends every attempt with keepalive while it fits; past 60 KB it goes as an ordinary request", async () => {
  const { m, sent } = harness();
  void m.mutate(op(["notes:b"], { body: { text: "hidden" }, keepalive: true, flush: true }));
  void m.mutate(op(["notes:c"], { body: { text: "x".repeat(61_000) }, keepalive: true }));
  assert.equal(sent[0].req.keepalive, true);
  assert.equal(sent[1].req.keepalive, undefined, "the browser would refuse it outright");
  m.flush();
  assert.equal(sent.length, 2, "a request already out with keepalive outlives the page: not sent twice");
});

test("a second flush sends nothing already carried and spends only what is left of the shared 64 KB", async () => {
  const { m, sent } = harness();
  const kb = (n: number) => ({ text: "x".repeat(n * 1024) });
  void m.mutate(op(["notes:b"], { body: kb(30), flush: true }));
  m.flush();
  assert.equal(sent.length, 2);
  m.flush();
  assert.equal(sent.length, 2, "carried: not again");
  void m.mutate(op(["plan:b"], { body: kb(30), flush: true }));
  m.flush();
  assert.equal(sent.length, 4, "60 KB out with keepalive");
  void m.mutate(op(["mark:1"], { body: kb(10), flush: true }));
  m.flush();
  assert.equal(sent.length, 5, "the mark's own send, but no keepalive copy: it would overrun the 64 KB in flight");
  sent[1].reply.resolve(answer(200));
  await tick();
  m.flush();
  assert.equal(sent.at(-1)!.req.body, JSON.stringify(kb(10)));
  assert.equal(sent.at(-1)!.req.keepalive, true, "room again once a keepalive request has settled");
});

test("pagehide asks the writers that hold text of their own first, then flushes once: the newest text goes, not the head it replaces", async () => {
  const { m, sent } = harness();
  const win = new EventTarget();
  m.install(win as unknown as Window);
  const save = (text: string, extra: Partial<Op> = {}) => op(["notes:b"], { body: { text }, base: () => 7, flush: true, coalesce: "notes:b", ...extra });
  void m.mutate(save("a"));                                   // on the wire, no keepalive
  const order: string[] = [];
  m.onLeave(() => { order.push("leave"); void m.mutate(save("ab", { keepalive: true })); });
  win.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(order, ["leave"]);
  assert.equal(sent.length, 2, "one request on leaving, for the lane's newest text");
  assert.equal(sent[1].req.body, '{"text":"ab"}');
  assert.equal(sent[1].req.keepalive, true);
  assert.equal(sent[1].req.headers["If-Match"], undefined, "behind an unacknowledged save: last writer wins");
});

// The grades lane queues a grade behind a failed head, so nothing reaches the ladder out of order.
const grade = (requestId: string, got = true) => ({ requestId, course: "course", card: "card", got, ms: 1200 });
const gradeOp = (g: ReturnType<typeof grade>): Op => ({
  label: "save that grade", lanes: ["grades"], method: "POST", path: "/api/review/grade", body: g, key: g.requestId, flush: true,
});

test("grades lane: the next encounter is accepted at once, but miss then recall are persisted in order", async () => {
  const { m, sent } = harness();
  const missed = grade("missed", false), recalled = grade("recalled");
  const one = m.mutate(gradeOp(missed));
  const two = m.mutate(gradeOp(recalled));
  m.retry(m.pending()[0].id);                     // repeated clicks never start concurrent writes
  assert.deepEqual(sent.map((s) => JSON.parse(s.req.body!)), [missed]);
  assert.equal(m.pending().length, 2);
  assert.equal(m.pending().some((p) => p.lanes.includes("grades")), true);
  sent[0].reply.resolve(answer(200, { saved: true, at: 1 }));
  await one;
  await tick();
  assert.deepEqual(sent.map((s) => JSON.parse(s.req.body!)), [missed, recalled]);
  assert.equal(m.pending().length, 1);
  sent[1].reply.resolve(answer(200, { saved: true, at: 2 }));
  await two;
  assert.deepEqual(m.pending(), []);
});

test("grades lane: a lost response keeps every unsaved verdict and resends the same receipt before continuing", async () => {
  const { m, sent, fire } = harness();
  const missed = grade("ambiguous-response", false), recalled = grade("next-encounter");
  const one = m.mutate(gradeOp(missed));
  const two = m.mutate(gradeOp(recalled));
  sent[0].reply.reject(new Error("response lost after commit"));
  await tick();
  assert.equal((m.pending()[0].error as Error).message, "response lost after commit");
  assert.equal(m.pending().length, 2);
  const three = m.mutate(gradeOp(grade("queued-behind")));
  await tick();
  assert.equal(sent.length, 1, "nothing behind the head is sent while it is unsaved");
  fire(1000);
  await tick();
  assert.equal(sent[1].req.body, sent[0].req.body, "the exact verdict, timing and request ID again");
  assert.equal(sent[1].req.headers["Idempotency-Key"], "ambiguous-response");
  sent[1].reply.resolve(answer(200, { saved: true, at: 1 }));
  await one;
  await tick();
  assert.deepEqual(JSON.parse(sent[2].req.body!), recalled);
  sent[2].reply.resolve(answer(200, { saved: true, at: 2 }));
  await two;
  await tick();
  sent[3].reply.resolve(answer(200, { saved: true, at: 3 }));
  await three;
  assert.deepEqual(m.pending(), []);
});

test("release: an op out of retries gives its lanes back, so the next press is sent at once", async () => {
  const { m, sent, fire } = harness();
  const first = failure(m.release(op(["feedback", "deck:d"])));
  sent[0].reply.reject(lost());
  await tick();
  for (const ms of RETRY_DELAYS_MS) { fire(ms); await tick(); sent.at(-1)!.reply.reject(lost()); await tick(); }
  assert.equal((await first).retryable, true);
  assert.deepEqual(m.pending(), [], "nothing left holding feedback or deck:d");
  void m.release(op(["deck:d"]));
  await tick();
  assert.equal(sent.length, 8, "the next op went out");
});

test("a writer owing text outside the save path keeps the unsaved prompt armed while it owes", () => {
  const { m } = harness();
  const win = new EventTarget() as EventTarget & { __strataSettled?: () => Promise<void> };
  m.install(win as unknown as Window);
  let owes = false;
  const told = new Set<() => void>();
  const tell = () => { for (const fn of told) fn(); };
  const unhold = m.holds(() => owes, (fn) => { told.add(fn); return () => { told.delete(fn); }; });
  const prompts = () => {
    let prompted = false;
    const look = (e: Event) => { prompted = e.defaultPrevented; };
    win.addEventListener("beforeunload", look);
    win.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    win.removeEventListener("beforeunload", look);
    return prompted;
  };
  assert.equal(prompts(), false, "nothing pending, nothing owed");
  owes = true; tell();
  assert.equal(prompts(), true, "owed text, though no op is pending: the prompt");
  owes = false; tell();
  assert.equal(prompts(), false, "paid: no prompt");
  owes = true; tell(); unhold();
  assert.equal(prompts(), false, "a holder gone holds nothing");
});
