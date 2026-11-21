import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "./mutate.ts";
import { Outbox, type Shelf } from "./outbox.ts";
import { markActOp, type MarkAct } from "./entities/marks.ts";
import { keepActOp, type KeepAct } from "./entities/keeps.ts";
import { notesKind, notesSender, type NotesAct } from "./entities/notes.ts";
import { marksKey, notesKey, type NotesEntity } from "./entities/boards.ts";
import type { Mark } from "../../shared/types/index.ts";

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const answer = (status: number, body: unknown = {}, rev = 0): SendAnswer => ({ status, body, rev, epoch: "e" });
const mapShelf = (map = new Map<string, string>()): Shelf & { map: Map<string, string> } =>
  ({ map, put: (id, v) => { map.set(id, v); }, drop: (id) => { map.delete(id); }, all: () => [...map.values()] });

/** One tab: its own wire, store, save path and outbox, over shelves a later tab can share. */
function tab(shelf = mapShelf(), clashShelf = mapShelf(), down = true) {
  const listeners = new Set<() => void>();
  const wire = { isDown: down, down: () => wire.isDown, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  const sent: { req: SendRequest; reply: ReturnType<typeof deferred<SendAnswer>> }[] = [];
  const store = new Store();
  const m = new Mutator({ store, wire, setTimer: () => 0, clearTimer: () => {}, now: () => 0,
    transport: (req) => { const reply = deferred<SendAnswer>(); sent.push({ req, reply }); return reply.promise; } });
  let clock = 100;
  const o = new Outbox(m, shelf, clashShelf, () => clock++);
  o.kind<MarkAct>("mark", { build: markActOp });
  o.kind<KeepAct>("keep", { build: keepActOp, release: true });
  o.kind<NotesAct>("notes", notesKind(store));
  const up = () => { wire.isDown = false; for (const fn of [...listeners]) fn(); };
  const reply = async (i: number, a: SendAnswer) => { sent[i].reply.resolve(a); await tick(); };
  return { o, m, store, sent, shelf, clashShelf, up, reply, wire };
}
const draft = (id: string) => ({ id, resourceId: "r1", page: null, start: 0, end: 5, quote: "words", rects: [] });
const markOn = (store: Store) => store.get<Mark[]>(marksKey("b1")) ?? [];

test("offline a mark and its note are taken, painted at once and shelved; nothing is sent until the wire is back", async () => {
  const t = tab();
  void t.o.send("mark", { do: "create", board: "b1", draft: draft("mk-00000001"), at: 1 } satisfies MarkAct);
  void t.o.send("mark", { do: "note", board: "b1", id: "mk-00000001", note: "why" } satisfies MarkAct);
  await tick();
  assert.equal(t.sent.length, 0);
  assert.deepEqual(markOn(t.store).map((m) => [m.id, m.note]), [["mk-00000001", "why"]], "painted first, the note folded over the create");
  assert.equal(t.shelf.map.size, 2);
  assert.equal(t.o.getSnapshot().waiting, 2);
  t.up();
  await tick();
  assert.equal(t.sent.length, 1, "one lane: the note waits for its mark");
  assert.equal(t.sent[0].req.method, "POST");
  await t.reply(0, answer(201, { id: "mk-00000001", mark: { ...draft("mk-00000001"), note: null, createdAt: 1 } }));
  assert.equal(t.sent[1].req.method, "PATCH");
  await t.reply(1, answer(200, { mark: { ...draft("mk-00000001"), note: "why", createdAt: 1 } }));
  assert.equal(t.shelf.map.size, 0, "confirmed acts leave the shelf");
  assert.deepEqual([t.o.getSnapshot().waiting, t.o.getSnapshot().synced], [0, 2]);
});

test("a reopened tab replays the shelf in the order it was made, under the same receipts, and only once", async () => {
  const first = tab();
  void first.o.send("keep", { do: "toggle", slug: "d1", id: "c1", keep: true } satisfies KeepAct);
  void first.o.send("keep", { do: "toggle", slug: "d1", id: "c1", keep: false } satisfies KeepAct);
  void first.o.send("mark", { do: "create", board: "b1", draft: draft("mk-00000002"), at: 1 } satisfies MarkAct);
  await tick();
  const keys = [...first.shelf.map.values()].map((raw) => JSON.parse(raw).key);
  // the tab closes here: what it owed is only on the shelf
  const again = tab(mapShelf(new Map(first.shelf.map)), mapShelf(), false);
  assert.equal(again.o.restore(), 3);
  assert.equal(again.o.restore(), 0, "an act already on its lane is not put back twice");
  await tick();
  const order = again.sent.map((s) => [s.req.path, s.req.body, s.req.headers["Idempotency-Key"]]);
  assert.deepEqual(order.map(([path, body]) => [path, body]), [
    ["/api/decks/d1/keeps", JSON.stringify({ add: ["c1"] })],
    ["/api/boards/b1/marks", JSON.stringify({ ...draft("mk-00000002") })],
  ], "the keeps lane sends its first toggle first; the mark's own lane goes beside it");
  assert.deepEqual(order.map(([, , key]) => key), [keys[0], keys[2]]);
  await again.reply(0, answer(200, { ids: ["c1"] }));
  assert.deepEqual([again.sent[2].req.body, again.sent[2].req.headers["Idempotency-Key"]], [JSON.stringify({ remove: ["c1"] }), keys[1]]);
});

test("a lost answer is sent again under the same receipt, so a replay never doubles", async () => {
  const t = tab(mapShelf(), mapShelf(), false);
  void t.o.send("mark", { do: "create", board: "b1", draft: draft("mk-00000003"), at: 1 } satisfies MarkAct);
  await tick();
  t.sent[0].reply.reject(new Error("Failed to fetch"));
  await tick();
  t.m.retry(t.m.pending()[0].id);
  await tick();
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[1].req.headers["Idempotency-Key"], t.sent[0].req.headers["Idempotency-Key"]);
  assert.equal(t.shelf.map.size, 1, "still owed until an answer says so");
});

test("a write refused for good leaves the shelf, so a reopen does not send it forever", async () => {
  const t = tab(mapShelf(), mapShelf(), false);
  const gone = t.o.send("mark", { do: "remove", board: "b1", id: "mk-00000004", undo: false } satisfies MarkAct).catch((e) => e);
  await tick();
  await t.reply(0, answer(404, { error: "no such mark" }));
  assert.equal((await gone).status, 404);
  assert.equal(t.shelf.map.size, 0);
});

test("only the newest shelved save of a board's notes is replayed: it is the whole document", async () => {
  const first = tab();
  void first.o.send("notes", { board: "b1", text: "draft one", base: 4 } satisfies NotesAct);
  void first.o.send("notes", { board: "b1", text: "draft two", base: 4 } satisfies NotesAct);
  await tick();
  const again = tab(mapShelf(new Map(first.shelf.map)), mapShelf(), false);
  assert.equal(again.o.restore(), 1);
  await tick();
  assert.equal(again.sent.length, 1);
  assert.deepEqual([again.sent[0].req.body, again.sent[0].req.headers["If-Match"]], [JSON.stringify({ text: "draft two" }), '"4"']);
  assert.equal(again.shelf.map.size, 1, "the older draft is dropped from the shelf");
});

test("a note saved offline that meets a newer text is not written over it: the clash is recorded and kept", async () => {
  const t = tab();
  t.store.apply<NotesEntity>(notesKey("b1"), 4, { text: "the start", notesRev: 4 }, "wire");
  t.store.apply(`board:b1`, 4, { board: { id: "b1", title: "Plane reading" } }, "wire");
  const save = notesSender(t.m, t.store, t.o)("b1", "mine, typed on the plane", false, 4).catch((e) => e);
  await tick();
  t.up();
  await tick();
  assert.equal(t.sent[0].req.headers["If-Match"], '"4"');
  await t.reply(0, answer(409, { error: "changed elsewhere", conflict: { rev: 7, value: { text: "theirs, from the laptop" } } }));
  const e = await save;
  assert.equal(e.status, 409);
  assert.equal(e.clashed, true, "said as a clash, so the box does not toast it too");
  const [clash] = t.o.getSnapshot().clashes;
  assert.deepEqual({ where: clash.where, mine: clash.mine, theirs: clash.theirs, rev: clash.rev },
    { where: { board: "b1", title: "Plane reading", source: null, passage: null }, mine: "mine, typed on the plane", theirs: "theirs, from the laptop", rev: 7 });
  assert.equal(t.clashShelf.map.size, 1, "a clash outlives the tab");
  assert.equal(t.sent.length, 1, "nothing was sent over theirs");
  const reopened = new Outbox(t.m, mapShelf(), t.clashShelf);
  assert.equal(reopened.getSnapshot().clashes[0].mine, "mine, typed on the plane");
});

test("an online 409 is the box's own conflict, and a 409 carrying my own text is a lost save that landed: neither is a clash", async () => {
  const t = tab(mapShelf(), mapShelf(), false);
  const online = notesSender(t.m, t.store, t.o)("b1", "typed online", false, 4).catch(() => {});
  await tick();
  await t.reply(0, answer(409, { conflict: { rev: 6, value: { text: "other" } } }));
  await online;
  t.wire.isDown = true;
  const landed = notesSender(t.m, t.store, t.o)("b1", "same text", false, 4).catch(() => {});
  t.up();
  await tick();
  await t.reply(1, answer(409, { conflict: { rev: 6, value: { text: "same text" } } }));
  await landed;
  assert.equal(t.o.getSnapshot().clashes.length, 0);
});

test("keep mine sends my text over the newer revision through the save path; keep theirs drops mine", async () => {
  const t = tab();
  const save = notesSender(t.m, t.store, t.o)("b1", "mine", false, 4).catch(() => {});
  const other = notesSender(t.m, t.store, t.o)("b2", "mine too", false, 2).catch(() => {});
  t.up();
  await tick();
  await t.reply(0, answer(409, { conflict: { rev: 7, value: { text: "theirs" } } }));
  await t.reply(1, answer(409, { conflict: { rev: 3, value: { text: "theirs too" } } }));
  await Promise.all([save, other]);
  const [a, b] = t.o.getSnapshot().clashes;
  void t.o.resolve(a.id, "mine");
  await tick();
  assert.equal(t.sent.length, 3);
  assert.deepEqual([t.sent[2].req.path, t.sent[2].req.body, t.sent[2].req.headers["If-Match"]], ["/api/boards/b1/notes", JSON.stringify({ text: "mine" }), '"7"']);
  assert.notEqual(t.sent[2].req.headers["Idempotency-Key"], t.sent[0].req.headers["Idempotency-Key"], "a new act, so a new receipt");
  await t.reply(2, answer(200, { notesRev: 8 }));
  assert.equal(t.store.get<NotesEntity>(notesKey("b1"))?.text, "mine");
  await t.o.resolve(b.id, "theirs");
  assert.equal(t.sent.length, 3, "keeping theirs sends nothing");
  assert.deepEqual([t.o.getSnapshot().clashes.length, t.clashShelf.map.size], [0, 0]);
});

test("a screen holding the clashed text settles it itself", async () => {
  const t = tab();
  const save = notesSender(t.m, t.store, t.o)("b1", "mine", false, 4).catch(() => {});
  t.up();
  await tick();
  await t.reply(0, answer(409, { conflict: { rev: 7, value: { text: "theirs" } } }));
  await save;
  const heard: string[] = [];
  t.o.resolver("notes", (c, how) => { heard.push(`${c.where.board}:${how}`); return true; });
  await t.o.resolve(t.o.getSnapshot().clashes[0].id, "mine");
  assert.deepEqual(heard, ["b1:mine"]);
  assert.equal(t.sent.length, 1, "the screen sends it, not the outbox");
});
