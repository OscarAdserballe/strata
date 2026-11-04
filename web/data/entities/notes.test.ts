import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type Failure, type SendAnswer, type SendRequest } from "../mutate.ts";
import { notesOps, notesSender } from "./notes.ts";
import { applyBoardState } from "./boards.ts";
import type { BoardState } from "../../../shared/types/index.ts";
import { NotesSave } from "../notes-save.ts";
import type { NotesEntity } from "./boards.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const surfaced: Failure[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
    surface: (f) => surfaced.push(f),
  });
  store.apply<NotesEntity>("notes:b1", 7, { text: "server", notesRev: 7 }, "wire");
  return { store, sent, surfaced, m };
}

test("a save goes out over the rev held when it is SENT, and newer text replaces a save still waiting", async () => {
  const { store, sent, m } = room();
  const one = m.mutate(notesOps.save("b1", "a", store));
  const two = m.mutate(notesOps.save("b1", "ab", store));
  const three = m.mutate(notesOps.save("b1", "abc", store));
  assert.equal(store.get<NotesEntity>("notes:b1")?.text, "abc", "the box's text, before any answer");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.headers["If-Match"], '"7"');
  sent[0].reply({ status: 200, body: { rev: 12, notesRev: 12 }, rev: 12, epoch: "" });
  await one;
  await tick();
  assert.deepEqual(store.entry<NotesEntity>("notes:b1")?.base, { text: "a", notesRev: 12 });
  assert.equal(sent.length, 2, "the middle save was replaced, never sent");
  assert.equal(JSON.parse(sent[1].req.body!).text, "abc");
  assert.equal(sent[1].req.headers["If-Match"], '"12"', "over the rev the first save produced");
  // today's server answers 204: the text is confirmed, the rev stays as held
  sent[1].reply({ status: 204, body: null, rev: 0, epoch: "" });
  await Promise.all([two, three]);
  assert.deepEqual(store.get<NotesEntity>("notes:b1"), { text: "abc", notesRev: 12 });
  assert.equal(store.entry("notes:b1")?.layers.length, 0);
});

test("a conflict hands the server's text to the store and fails the save with it, for Keep mine / Use theirs", async () => {
  const { store, sent, surfaced, m } = room();
  const saving = m.mutate(notesOps.save("b1", "mine", store)).catch((e) => e);
  sent[0].reply({ status: 409, body: { error: "changed elsewhere", conflict: { rev: 9, value: { text: "theirs" } } }, rev: 15, epoch: "" });
  const e = await saving;
  assert.equal(e.status, 409);
  assert.deepEqual(e.conflict, { rev: 9, value: { text: "theirs" } });
  assert.deepEqual(store.get<NotesEntity>("notes:b1"), { text: "theirs", notesRev: 9 }, "no silent merge: their text is the base");
  assert.equal(surfaced[0].label, "save the notes");
  // Keep mine: another save, now over the new rev
  void m.mutate(notesOps.save("b1", "mine", store));
  assert.equal(sent[1].req.headers["If-Match"], '"9"');
  assert.equal(notesOps.save("b1", "x").flush, true, "flushed on pagehide");
});

test("a save queued behind the conflicted one fails with it, rather than overwriting their text over the new rev", async () => {
  const { store, sent, surfaced, m } = room();
  const first = m.mutate(notesOps.save("b1", "mine-a", store)).catch((e) => e);
  const second = m.mutate(notesOps.save("b1", "mine-ab", store)).catch((e) => e);   // the person kept typing
  sent[0].reply({ status: 409, body: { error: "changed elsewhere", conflict: { rev: 9, value: { text: "theirs" } } }, rev: 15, epoch: "" });
  const [a, b] = await Promise.all([first, second]);
  await tick();
  assert.equal(sent.length, 1, "nothing was sent over the rev the conflict brought");
  assert.deepEqual([a.status, b.status], [409, 409]);
  assert.deepEqual(b.conflict, { rev: 9, value: { text: "theirs" } }, "the queued save carries the same conflict");
  assert.deepEqual(store.get<NotesEntity>("notes:b1"), { text: "theirs", notesRev: 9 }, "both layers rolled back: their text, until the person decides");
  assert.deepEqual(surfaced.map((f) => f.label), ["save the notes", "save the notes"]);
  assert.deepEqual(m.pending(), []);
});

test("NotesSave's sender: a save the wire drops is sent again by the save path, same key, without a next edit", async () => {
  const store = new Store();
  store.apply<NotesEntity>("notes:b1", 7, { text: "server", notesRev: 7 }, "wire");
  const sent: SendRequest[] = [];
  const timers: (() => void)[] = [];
  let lose = true;
  const m = new Mutator({
    store,
    transport: async (req) => {
      sent.push(req);
      if (lose) { lose = false; throw Object.assign(new Error("Failed to fetch"), { name: "TypeError" }); }
      return { status: 200, body: { rev: 11, notesRev: 11 }, rev: 11, epoch: "" };
    },
    setTimer: (fn, ms) => { if (ms < 20_000) timers.push(fn); return 0; }, clearTimer: () => {},
  });
  const saving = notesSender(m, store)("b1", "the last words");
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(timers.length, 1, "a retry is waiting");
  timers.shift()!();
  await saving;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].headers["Idempotency-Key"], sent[0].headers["Idempotency-Key"], "the retry is the same op");
  assert.equal(sent[1].body, sent[0].body);
  assert.deepEqual(store.entry<NotesEntity>("notes:b1")?.base, { text: "the last words", notesRev: 11 });
});

test("NotesSave's sender: a save out of retries gives the log's lane back", async () => {
  const store = new Store();
  const timers: (() => void)[] = [];
  const sent: SendRequest[] = [];
  const m = new Mutator({
    store,
    transport: async (req) => { sent.push(req); return { status: 503, body: { error: "busy" }, rev: 0, epoch: "" }; },
    setTimer: (fn, ms) => { if (ms < 20_000) timers.push(fn); return 0; }, clearTimer: () => {},
  });
  const send = notesSender(m, store);
  const saving = send("b1", "owed").catch((e) => e);
  for (let i = 0; i < 6; i++) { await tick(); timers.shift()!(); }
  const e = await saving;
  assert.equal(e.retryable, true);
  assert.deepEqual(m.pending(), [], "not left holding the lane");
  void send("b1", "owed, again");
  await tick();
  assert.equal(JSON.parse(sent.at(-1)!.body!).text, "owed, again", "the next save goes straight out");
});

test("NotesSave's sender: the tab going hidden, and the page going away, send the log with keepalive", async () => {
  const { store, sent, m } = room();
  const ns = new NotesSave({ send: notesSender(m, store), failed: () => {}, setTimer: () => 0, clearTimer: () => {} });
  ns.seed("b1", "server");
  ns.edit("hidden now");
  ns.leave(false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.keepalive, true, "a phone may freeze a hidden page without a pagehide");
  assert.equal(JSON.parse(sent[0].req.body!).text, "hidden now");
  sent[0].reply({ status: 200, body: { rev: 11, notesRev: 11 }, rev: 11, epoch: "" });
  await tick();
  ns.edit("and gone");
  ns.leave(true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].req.keepalive, true);
  assert.equal(JSON.parse(sent[1].req.body!).text, "and gone");
  m.flush();
  assert.equal(sent.length, 2, "the flush leaves a save already out with keepalive be");
});

test("NotesSave's sender: a board snapshot landing mid-draft does not lend the draft its revision", async () => {
  const { store, sent, m } = room();
  let beat: (() => void) | null = null;
  const ns = new NotesSave({ send: notesSender(m, store), failed: () => {}, setTimer: (fn) => { beat = fn; return 1; }, clearTimer: () => { beat = null; } });
  ns.seed("b1", "server", { rev: 7 });
  ns.edit("server, and mine");
  // another tab saved at rev 9; a snapshot carrying it (a poll, another write's answer) lands in the store
  applyBoardState({ board: { id: "b1" }, notes: "server, and theirs", notesRev: 9, rev: 20 } as unknown as BoardState, {}, store);
  assert.equal(store.get<NotesEntity>("notes:b1")?.notesRev, 9, "the store has heard the newer revision");
  beat!();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.headers["If-Match"], '"7"', "the draft goes out over the revision it was written over");
  sent[0].reply({ status: 409, body: { error: "changed elsewhere", conflict: { rev: 9, value: { text: "server, and theirs" } } }, rev: 20, epoch: "" });
  await tick();
  assert.equal(ns.getSnapshot().conflict, true, "refused, and the person is asked");
  ns.keepMine();
  assert.equal(sent[1].req.headers["If-Match"], '"9"', "Keep mine: over their revision, by choice");
  sent[1].reply({ status: 200, body: { rev: 21, notesRev: 21 }, rev: 21, epoch: "" });
  await tick();
  ns.edit("server, and mine, and more");
  beat!();
  assert.equal(sent[2].req.headers["If-Match"], '"21"', "then over the revision that save produced");
});

// A restore onto a backup: the server comes back on a new epoch with lower revisions.
function restoredRoom() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {}, surface: () => {},
  });
  let beat: (() => void) | null = null;
  const ns = new NotesSave({ send: notesSender(m, store), store, failed: () => {}, setTimer: (fn) => { beat = fn; return 1; }, clearTimer: () => { beat = null; } });
  const read = (board: string, notes: string, notesRev: number, rev: number, epoch: string) => {
    applyBoardState({ board: { id: board }, notes, notesRev, rev } as unknown as BoardState, { epoch }, store);
    return ns.seed(board, notes, { rev: notesRev, epoch });
  };
  const saved = (i: number, rev: number, notesRev: number, epoch: string) => sent[i].reply({ status: 200, body: { rev, notesRev }, rev, epoch });
  const ifMatch = (i: number) => sent[i].req.headers["If-Match"];
  return { store, sent, ns, read, saved, ifMatch, beat: () => beat!() };
}
/** the tab saved b1 at rev 6, then the server was restored onto a backup holding b1 at rev 3 */
async function afterRestore() {
  const r = restoredRoom();
  r.read("b1", "before", 5, 10, "boot-1");
  r.ns.edit("before, and a line saved before the restore"); r.beat();
  assert.equal(r.ifMatch(0), '"5"');
  r.saved(0, 11, 6, "boot-1"); await tick();
  r.read("b2", "other", 1, 11, "boot-1");
  return r;
}

test("after a restore onto a backup, the log reopens on what the server holds, saved, and the next save goes over its revision", async () => {
  const { ns, read, saved, ifMatch, beat } = await afterRestore();
  assert.equal(read("b1", "restored", 3, 8, "boot-2"), "restored", "the server's text, not the text from before the restore");
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
  ns.edit("restored, and more"); beat();
  assert.equal(ifMatch(1), '"3"', "over the revision the server holds now");
  saved(1, 9, 4, "boot-2"); await tick();
  read("b2", "other", 1, 9, "boot-2");
  assert.equal(read("b1", "restored, and more", 4, 9, "boot-2"), "restored, and more", "and reopened, what was saved since");
  ns.edit("restored, and more, again"); beat();
  assert.equal(ifMatch(2), '"4"');
});

test("after a restore, a change made elsewhere is still asked about, and Keep mine or Use theirs holds when the board is opened again", async () => {
  for (const choice of ["mine", "theirs"] as const) {
    const { ns, sent, read, saved, ifMatch, beat } = await afterRestore();
    read("b1", "restored", 3, 8, "boot-2");
    ns.edit("restored, mine"); beat();
    assert.equal(ifMatch(1), '"3"');
    // another device wrote at rev 4 meanwhile
    sent[1].reply({ status: 409, body: { error: "changed elsewhere", conflict: { rev: 4, value: { text: "restored, theirs" } } }, rev: 9, epoch: "boot-2" });
    await tick();
    assert.equal(ns.getSnapshot().conflict, true, `${choice}: asked`);
    if (choice === "mine") {
      ns.keepMine();
      assert.equal(ifMatch(2), '"4"', "Keep mine: over their revision");
      saved(2, 10, 5, "boot-2"); await tick();
      read("b2", "other", 1, 10, "boot-2");
      assert.equal(read("b1", "restored, mine", 5, 10, "boot-2"), "restored, mine", "reopened on the text kept");
    } else {
      assert.equal(ns.useTheirs(), "restored, theirs");
      read("b2", "other", 1, 9, "boot-2");
      assert.equal(read("b1", "restored, theirs", 4, 9, "boot-2"), "restored, theirs", "reopened on the text taken, not undone");
    }
    assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false }, choice);
    ns.edit("one more line"); beat();
    assert.equal(ifMatch(sent.length - 1), choice === "mine" ? '"5"' : '"4"', `${choice}: the next save goes over what the server holds`);
  }
});

// The failure the box hears is the last attempt's; an earlier one may have landed.
test("NotesSave's sender: a refusal that follows a lost attempt still leaves the box unsure, so text edited back is sent", async () => {
  const store = new Store();
  store.apply<NotesEntity>("notes:b1", 4, { text: "confirmed", notesRev: 4 }, "wire");
  const sent: SendRequest[] = [];
  const timers: (() => void)[] = [];
  const answers: (() => Promise<SendAnswer>)[] = [
    async () => { throw Object.assign(new Error("Failed to fetch"), { name: "TypeError" }); },  // landed; its answer did not
    async () => ({ status: 401, body: { error: "sign in again" }, rev: 0, epoch: "" }),
  ];
  const m = new Mutator({
    store,
    transport: (req) => { sent.push(req); return (answers.shift() ?? (async () => ({ status: 200, body: { rev: 12, notesRev: 6 }, rev: 12, epoch: "" })))(); },
    setTimer: (fn, ms) => { if (ms < 20_000) timers.push(fn); return 0; }, clearTimer: () => {}, surface: () => {},
  });
  let beat: (() => void) | null = null;
  const ns = new NotesSave({ send: notesSender(m, store), store, failed: () => {}, setTimer: (fn) => { beat = fn; return 1; }, clearTimer: () => { beat = null; } });
  ns.seed("b1", "confirmed", { rev: 4 });
  ns.edit("confirmed, and a line I took back"); beat!();
  await tick();
  timers.shift()!();                                   // the save path's retry, same key: 401
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(ns.getSnapshot().error && (ns.getSnapshot().error as { status?: number }).status, 401);
  ns.edit("confirmed"); beat!();                       // taken back
  assert.equal(ns.getSnapshot().saved, false, "not 'saved': the first attempt may have landed");
  assert.equal(sent.length, 3, "sent, so the server ends on the box");
  assert.deepEqual([JSON.parse(sent[2].body!).text, sent[2].headers["If-Match"]], ["confirmed", '"4"']);
  await tick();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
});

test("late409: a refusal heard after a newer read asks over the newest text, and Use theirs or Keep mine ends on what the server holds", async () => {
  for (const choice of ["theirs", "mine"] as const) {
    const r = restoredRoom();
    r.read("b1", "c", 4, 10, "boot-1");
    // another device writes "co" at 5; the box saves "ca" over 4, refused at 5, the answer slow
    r.ns.edit("ca"); r.beat(); await tick();
    assert.equal(r.ifMatch(0), '"4"');
    const refusal: SendAnswer = { status: 409, body: { error: "changed elsewhere", conflict: { rev: 5, value: { text: "co" } } }, rev: 11, epoch: "boot-1" };
    // the other device writes again ("coo" at 6), and the board is reopened: read first
    assert.equal(r.read("b1", "coo", 6, 12, "boot-1"), "ca", `${choice}: the draft stays in the box`);
    r.sent[0].reply(refusal); await tick();
    assert.equal(r.ns.getSnapshot().conflict, true, `${choice}: asked`);
    assert.deepEqual([r.store.entry<NotesEntity>("notes:b1")?.base, r.store.entry("notes:b1")?.rev], [{ text: "coo", notesRev: 6 }, 6],
      `${choice}: the log stays at the newer revision it was read at, in its own order`);
    if (choice === "theirs") {
      assert.equal(r.ns.useTheirs(), "coo", "Use theirs: the newest text the box has heard, not the refused one");
      assert.deepEqual(r.ns.getSnapshot(), { saved: true, error: null, conflict: false });
      r.ns.edit("coo, and mine"); r.beat();
      assert.equal(r.ifMatch(1), '"6"', "the next save goes over what the server holds");
    } else {
      r.ns.edit("co"); r.beat();                       // typed back to the refused text
      r.ns.keepMine(); await tick();
      assert.equal(r.sent.length, 2, "Keep mine sends the box: the server holds \"coo\", not \"co\"");
      assert.deepEqual([JSON.parse(r.sent[1].req.body!).text, r.ifMatch(1)], ["co", '"6"']);
      r.saved(1, 13, 7, "boot-1"); await tick();
      assert.deepEqual(r.ns.getSnapshot(), { saved: true, error: null, conflict: false });
    }
  }
});
