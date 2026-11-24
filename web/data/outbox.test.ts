import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "./mutate.ts";
import { Outbox, type Shelf } from "./outbox.ts";
import { markKind, type MarkAct } from "./entities/marks.ts";
import { keepActOp, type KeepAct } from "./entities/keeps.ts";
import { notesKind, notesSender, type NotesAct } from "./entities/notes.ts";
import { marksKey, notesKey, type NotesEntity } from "./entities/boards.ts";
import type { Card, Mark } from "../../shared/types/index.ts";
import { authoredKind, type AuthoredAct } from "./entities/authored.ts";
import { cardEditKind, type CardEditAct } from "../capabilities/card/saveCard.ts";

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
  o.kind<MarkAct>("mark", markKind(store));
  o.kind<KeepAct>("keep", { build: keepActOp, release: true });
  o.kind<NotesAct>("notes", notesKind(store));
  o.kind<AuthoredAct>("authored", authoredKind(store));
  o.kind<CardEditAct>("card-edit", cardEditKind(store));
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
  assert.equal(((await gone) as { status?: number }).status, 404);
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

test("a highlight's note written offline over one changed elsewhere is a clash on its passage; keep mine names theirs as what it overwrites", async () => {
  const t = tab();
  t.store.apply<Mark[]>(marksKey("b1"), 4, [{ ...draft("mk-00000005"), note: "first thought", createdAt: 1 }], "wire");
  t.store.apply("board:b1", 4, { board: { id: "b1", title: "Plane reading" }, resources: [{ id: "r1", filename: "essay.md" }] }, "wire");
  const save = t.o.send("mark", { do: "note", board: "b1", id: "mk-00000005", note: "on the plane", was: "first thought" } satisfies MarkAct).catch((e) => e);
  assert.equal(markOn(t.store)[0].note, "on the plane", "painted at once");
  t.up();
  await tick();
  assert.deepEqual(JSON.parse(t.sent[0].req.body!), { note: "on the plane", was: "first thought" });
  await t.reply(0, answer(409, { error: "changed elsewhere", conflict: { rev: 9, value: { note: "on the laptop" } } }));
  assert.equal(((await save) as { clashed?: boolean }).clashed, true);
  assert.equal(markOn(t.store)[0].note, "on the laptop", "the page shows what the server holds, not mine over it");
  const [clash] = t.o.getSnapshot().clashes;
  assert.deepEqual([clash.where, clash.mine, clash.theirs, clash.rev],
    [{ board: "b1", title: "Plane reading", source: "essay.md", passage: "words" }, "on the plane", "on the laptop", 9]);
  void t.o.resolve(clash.id, "mine");
  await tick();
  assert.deepEqual(JSON.parse(t.sent[1].req.body!), { note: "on the plane", was: "on the laptop" });
  await t.reply(1, answer(200, { mark: { ...draft("mk-00000005"), note: "on the plane", createdAt: 1 }, rev: 10 }));
  assert.equal(markOn(t.store)[0].note, "on the plane");
});

test("an unguarded note (made online, or on a mark the server hasn't seen) is never read as a clash", async () => {
  const t = tab();
  const save = t.o.send("mark", { do: "note", board: "b1", id: "mk-00000006", note: "x" } satisfies MarkAct).catch((e) => e);
  t.up();
  await tick();
  assert.deepEqual(JSON.parse(t.sent[0].req.body!), { note: "x" });
  await t.reply(0, answer(409, { conflict: { rev: 2, value: { note: "y" } } }));
  await save;
  assert.equal(t.o.getSnapshot().clashes.length, 0);
});

const deckCard = { id: "econ/flashcard/ols", deck: "econ/0-flashcard", type: "flashcard", ord: 0, front: "What does OLS minimise?", back: "the squared residuals", rev: 7 } as Card;

test("a card written on the plane is shelved under its draft's receipt and reaches the board on reconnect; a second press is the same write", async () => {
  const t = tab();
  const act: AuthoredAct = { do: "create", board: "b1", draft: { front: "Why is OLS unbiased?", variant: "bare", back: "E[u|X]=0", state: "closed" }, draftKey: "draft-0001-abcd" };
  void t.o.send("authored", act).catch(() => {});
  void t.o.send("authored", act).catch(() => {});
  await tick();
  assert.equal(t.sent.length, 0);
  assert.equal(t.shelf.map.size, 1, "one draft, one receipt: the second press is the same entry");
  const reopened = tab(t.shelf, t.clashShelf, false);
  assert.equal(reopened.o.restore(), 1);
  await tick();
  assert.equal(reopened.sent[0].req.path, "/api/boards/b1/minted");
  assert.match(reopened.sent[0].req.headers["Idempotency-Key"], /^draft-0001-abcd-[0-9a-f]{8}$/);
  await reopened.reply(0, answer(201, { id: "m-9", state: {} }));
  assert.equal(reopened.shelf.map.size, 0);
});

test("a deck card edited offline waits; meeting a newer card on reconnect it is a clash with both faces, and keep mine sends it over theirs", async () => {
  const t = tab();
  const edit = t.o.send("card-edit", { card: deckCard, patch: { back: "the sum of squared residuals" } } satisfies CardEditAct).catch((e: { clashed?: boolean }) => e);
  await tick();
  assert.equal(t.sent.length, 0);
  t.up();
  await tick();
  assert.equal(t.sent[0].req.method, "PATCH");
  assert.equal(t.sent[0].req.headers["If-Match"], '"7"');
  await t.reply(0, answer(409, { error: "changed", conflict: { rev: 9, value: { ...deckCard, back: "squared errors, summed", rev: 9 } } }));
  assert.equal(((await edit) as { clashed?: boolean }).clashed, true);
  const [clash] = t.o.clashes();
  assert.match(clash.mine, /the sum of squared residuals/);
  assert.match(clash.theirs, /squared errors, summed/);
  void t.o.resolve(clash.id, "mine");
  await tick();
  assert.equal(t.sent[1].req.headers["If-Match"], '"9"', "keep mine is sent over the revision it met");
});

test("an offline edit that meets its own landed text is no clash", async () => {
  const t = tab();
  const edit = t.o.send("card-edit", { card: deckCard, patch: { back: "mine" } } satisfies CardEditAct).catch((e) => e);
  t.up();
  await tick();
  await t.reply(0, answer(409, { error: "changed", conflict: { rev: 8, value: { ...deckCard, back: "mine", rev: 8 } } }));
  await edit;
  assert.equal(t.o.clashes().length, 0);
});
