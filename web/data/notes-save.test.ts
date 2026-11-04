import { test } from "node:test";
import assert from "node:assert/strict";
import { NotesSave, type NotesSaveState } from "./notes-save.ts";
import { Store } from "./store.ts";
import { notesKey, type NotesEntity } from "./entities/boards.ts";

function deferred() {
  let resolve!: (answer?: unknown) => void, reject!: (e: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((r) => setImmediate(r));

/* A NotesSave with its clock and wire in the test's hands, and the room's store beside it. */
function harness() {
  const sent: { board: string; text: string; keepalive: boolean; base: number | null; reply: ReturnType<typeof deferred> }[] = [];
  const failures: unknown[] = [];
  let pending: (() => void) | null = null;
  const store = new Store();
  const server = { epoch: "boot-1" };
  const ns = new NotesSave({
    store,
    send: (board, text, keepalive, base) => {
      const reply = deferred();
      sent.push({ board, text, keepalive, base, reply });
      return reply.promise.then((res) => {
        const rev = (res as { notesRev?: number } | undefined)?.notesRev;
        if (rev !== undefined) store.patch<NotesEntity>(notesKey(board), rev, (held) => ({ ...held, text, notesRev: rev }), { epoch: server.epoch });
        return res;
      }, (e: { conflict?: { rev: number; value?: { text?: string } } }) => {
        const c = e?.conflict;
        // in the log's order within the epoch, as the save path takes it: a newer read stays
        if (c) store.patch<NotesEntity>(notesKey(board), c.rev, () => ({ text: c.value?.text ?? "", notesRev: c.rev }), { epoch: server.epoch, ordered: true });
        throw e;
      });
    },
    failed: (e) => failures.push(e),
    setTimer: (fn) => { pending = fn; return 1; },
    clearTimer: () => { pending = null; },
  });
  const states: NotesSaveState[] = [];
  ns.subscribe(() => states.push(ns.getSnapshot()));
  /** a board read at revision `rev`, from the wire or (stale) the offline copy: the store first, then the box */
  const open = (board: string, text: string, opts: { rev: number; stale?: boolean }): string => {
    store.apply<NotesEntity>(notesKey(board), opts.rev, { text, notesRev: opts.rev }, opts.stale ? "shelf" : "wire", { epoch: server.epoch });
    return ns.seed(board, text, { ...opts, epoch: server.epoch });
  };
  return { ns, sent, failures, states, store, server, open, beat: () => { const fn = pending; pending = null; fn?.(); }, waiting: () => pending !== null };
}

test("'saved' means the server took exactly the text in the box, never an older save landing late", async () => {
  const { ns, sent, beat } = harness();
  assert.equal(ns.seed("b1", "start"), "start");
  assert.equal(ns.getSnapshot().saved, true);
  ns.edit("start, then A");
  assert.equal(ns.getSnapshot().saved, false);
  beat();                                              // the debounce: A goes out
  assert.deepEqual(sent.map((s) => s.text), ["start, then A"]);
  ns.edit("start, then A and B");                      // typed while A is on the wire
  beat();                                              // …B's beat comes, but A is still out
  assert.equal(sent.length, 1, "one save on the wire at a time — B must not overtake A");
  sent[0].reply.resolve(); await settle();
  assert.equal(ns.getSnapshot().saved, false, "A landing must not say saved over B");
  assert.deepEqual(sent.map((s) => s.text), ["start, then A", "start, then A and B"], "B follows A, as the latest text");
  sent[1].reply.resolve(); await settle();
  assert.equal(ns.getSnapshot().saved, true);
});

test("a failed save stays unsaved, says why once, and the next edit or blur retries", async () => {
  const { ns, sent, failures, beat } = harness();
  ns.seed("b1", "");
  ns.edit("a sentence"); beat();
  const err = Object.assign(new Error("unauthorized"), { status: 401 });
  sent[0].reply.reject(err); await settle();
  assert.equal(ns.getSnapshot().saved, false);
  assert.equal(ns.getSnapshot().error, err);
  assert.deepEqual(failures, [err]);
  assert.equal(sent.length, 1, "no retry loop on its own");
  ns.edit("a sentence, longer"); beat();
  sent[1].reply.reject(new Error("still down")); await settle();
  assert.equal(failures.length, 1, "the reason is said once per run of failures");
  ns.flush();
  assert.equal(sent.at(-1)!.text, "a sentence, longer");
  sent.at(-1)!.reply.resolve(); await settle();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
  ns.edit("again"); beat();
  sent.at(-1)!.reply.reject(new Error("a new run")); await settle();
  assert.equal(failures.length, 2, "a failure after a success is news again");
});

test("a blur with nothing new sends nothing", () => {
  const { ns, sent } = harness();
  ns.seed("b1", "as the server has it");
  ns.flush(); ns.flush();
  assert.equal(sent.length, 0);
});

test("the tab going hidden sends what waits at once, keepalive; the page going away does not wait behind a save in flight", async () => {
  const { ns, sent, waiting } = harness();
  ns.seed("b1", "");
  ns.edit("typed, then the tab closed inside the beat");
  ns.leave(false);
  assert.equal(waiting(), false, "the beat is not waited for");
  assert.deepEqual(sent.map((s) => [s.text, s.keepalive]), [["typed, then the tab closed inside the beat", true]]);
  // hidden while a save is on the wire: the newer text follows it, keepalive
  ns.edit("more"); ns.leave(false);
  assert.equal(sent.length, 1);
  sent[0].reply.resolve(); await settle();
  assert.deepEqual(sent.map((s) => [s.text, s.keepalive]).at(-1), ["more", true]);
  // unloading: the in-flight request dies with the page, so the latest goes now
  ns.edit("last words"); ns.leave(true);
  assert.deepEqual(sent.map((s) => [s.text, s.keepalive]).at(-1), ["last words", true]);
});

test("opening another board sends the old board's unsaved text to the OLD board", async () => {
  const { ns, sent } = harness();
  ns.seed("b1", "");
  ns.edit("for b1");
  assert.equal(ns.seed("b2", "b2's log"), "b2's log");
  assert.deepEqual(sent.map((s) => [s.board, s.text]), [["b1", "for b1"]]);
  assert.equal(ns.getSnapshot().saved, true, "b2's own log is as the server has it");
  ns.edit("for b2");
  ns.flush();
  assert.equal(sent.length, 1, "b2 waits for b1's save to finish");
  sent[0].reply.resolve(); await settle();
  assert.deepEqual(sent.map((s) => [s.board, s.text]).at(-1), ["b2", "for b2"]);
});

test("a failure on a board already left is still said", async () => {
  const { ns, sent, failures } = harness();
  ns.seed("b1", "");
  ns.edit("for b1");
  ns.seed("b2", "");
  sent[0].reply.reject(new Error("b1 refused")); await settle();
  assert.equal(failures.length, 1);
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false }, "b2's badge is b2's");
});

test("reopening the same board keeps typing that has not landed yet", () => {
  const { ns } = harness();
  ns.seed("b1", "old");
  ns.edit("old and new");
  assert.equal(ns.seed("b1", "old"), "old and new");
});

test("leaving a board while its save is in flight still sends that board's newest text, to it", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "");
  ns.edit("A"); beat();                                // A on the wire
  ns.edit("A and B");                                  // typed while A is out
  assert.equal(ns.seed("b2", "b2's log"), "b2's log"); // the next board opens before A answers
  assert.equal(sent.length, 1, "still one save at a time");
  sent[0].reply.resolve(); await settle();
  assert.deepEqual(sent.map((s) => [s.board, s.text]), [["b1", "A"], ["b1", "A and B"]], "b1's latest goes to b1 after A");
  sent[1].reply.resolve(); await settle();
  ns.edit("for b2"); beat();
  assert.deepEqual(sent.map((s) => [s.board, s.text]).at(-1), ["b2", "for b2"], "and b1 is not sent again");
  assert.equal(sent.length, 3);
});

test("a left board's failed save is kept, said once, and retried by the next flush — not in a loop", async () => {
  const { ns, sent, failures } = harness();
  ns.seed("b1", "");
  ns.edit("for b1");
  ns.seed("b2", "");
  sent[0].reply.reject(new Error("b1 refused")); await settle();
  assert.equal(failures.length, 1);
  assert.equal(sent.length, 1, "no retry on its own");
  ns.flush();
  assert.deepEqual(sent.map((s) => [s.board, s.text]).at(-1), ["b1", "for b1"]);
  sent[1].reply.resolve(); await settle();
  ns.flush();
  assert.equal(sent.length, 2, "landed: nothing more is owed to b1");
});

test("a left board's failure does not hold up the open board's own save", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "");
  ns.edit("for b1");
  ns.seed("b2", "");
  ns.edit("for b2"); beat();                           // b2's beat, behind b1's save
  sent[0].reply.reject(new Error("b1 refused")); await settle();
  assert.deepEqual(sent.map((s) => [s.board, s.text]).at(-1), ["b2", "for b2"]);
  sent[1].reply.resolve(); await settle();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
});

test("coming back to a board whose text has not landed shows that text, not the server's older answer", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "");
  ns.edit("A"); beat();                                // A on the wire
  ns.seed("b2", "");
  assert.equal(ns.seed("b1", ""), "A", "the read that answered before A landed is older than A");
  assert.equal(ns.getSnapshot().saved, false);
  sent[0].reply.resolve(); await settle();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
  assert.equal(sent.length, 1);
});

test("the page going away sends a left board's text and the open one's, side by side", () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "");
  ns.edit("A"); beat();                                // an ordinary save, which dies with the page
  ns.seed("b2", "");
  ns.edit("B");
  ns.leave(true);
  assert.deepEqual(sent.slice(1).map((s) => [s.board, s.text, s.keepalive]).sort(), [["b1", "A", true], ["b2", "B", true]]);
});

test("hidden, then gone: a keepalive save already carrying the text is not sent twice", async () => {
  const { ns, sent } = harness();
  ns.seed("b1", "");
  ns.edit("typed, then the tab closed");
  ns.leave(false);                                     // visibilitychange → hidden
  ns.leave(true);                                      // pagehide
  assert.deepEqual(sent.map((s) => [s.text, s.keepalive]), [["typed, then the tab closed", true]]);
  // …but text typed after it, or an ordinary save that would die with the page, still goes
  ns.edit("typed, then the tab closed, and one more");
  ns.leave(true);
  assert.equal(sent.length, 2);
});

test("a live read lifts a saved copy's seal even while owed text is on its way", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "");
  ns.edit("typed live"); beat();
  ns.seed("b2", "");
  ns.seed("b1", "days old", { stale: true });          // back on b1, but from the shelf
  assert.equal(ns.stale, true);
  ns.seed("b1", "typed live");
  assert.equal(ns.stale, false);
  sent[0].reply.resolve(); await settle();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
});

test("a save refused because the log changed elsewhere is not sent again until you choose: keep mine, or use theirs", async () => {
  const { ns, sent, failures, beat } = harness();
  ns.seed("b1", "ours");
  ns.edit("ours, then mine");
  beat();
  sent[0].reply.reject(Object.assign(new Error("changed elsewhere"), { status: 409, conflict: { rev: 9, value: { text: "theirs" } } }));
  await settle();
  assert.equal(failures.length, 1, "said once");
  assert.deepEqual(ns.getSnapshot(), { saved: false, error: ns.getSnapshot().error, conflict: true });
  ns.edit("ours, then mine, and more");
  beat();
  ns.flush();
  ns.leave(true);
  assert.equal(sent.length, 1, "no silent overwrite: not on an edit, a blur, or the page going away");
  ns.keepMine();
  assert.deepEqual(sent.map((s) => s.text), ["ours, then mine", "ours, then mine, and more"], "keep mine is a save of the box");
  sent[1].reply.resolve();
  await settle();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });

  const two = harness();
  two.ns.seed("b1", "ours");
  two.ns.edit("mine");
  two.beat();
  two.sent[0].reply.reject(Object.assign(new Error("changed elsewhere"), { status: 409, conflict: { rev: 9, value: { text: "theirs" } } }));
  await settle();
  assert.equal(two.ns.useTheirs(), "theirs", "the box takes their text");
  assert.deepEqual(two.ns.getSnapshot(), { saved: true, error: null, conflict: false });
  two.ns.flush();
  assert.equal(two.sent.length, 1, "nothing owed");
});

test("a board left in conflict keeps its text unsent until you are back on it to choose", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "ours");
  ns.edit("mine");
  beat();
  sent[0].reply.reject(Object.assign(new Error("changed elsewhere"), { status: 409, conflict: { rev: 9, value: { text: "theirs" } } }));
  await settle();
  ns.seed("b2", "other");
  ns.edit("other, edited");
  beat();
  assert.deepEqual(sent.map((s) => s.board), ["b1", "b2"], "b2 saves; b1's text waits");
  sent[1].reply.resolve();
  await settle();
  assert.equal(ns.seed("b1", "theirs, newer"), "mine", "back on b1: your text in the box");
  assert.equal(ns.getSnapshot().conflict, true, "and the choice to make");
  assert.equal(ns.useTheirs(), "theirs, newer");
});

test("the log's save goes through the save path's transport: a 401 rejects, keepalive rides along under the cap, and a write drops the reads kept warm", async (t) => {
  // web/data/api.ts reads navigator.onLine at load; Node's navigator has none
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  const calls: { url: string; method: string; keepalive?: boolean; body?: string }[] = [];
  let status = 204;
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method || "GET"), keepalive: init?.keepalive, body: init?.body as string });
    if (String(url).endsWith("/api/boards/b1")) return new Response(JSON.stringify({ board: { id: "b1" }, notes: "x" }), { headers: { "Content-Type": "application/json" } });
    return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify({ error: "no" }), { status });
  });
  const { StrataAPI } = await import("./api.ts");
  const { notesSender } = await import("./entities/notes.ts");
  const saveNotes = notesSender();

  assert.equal(await saveNotes("b1", "hello"), null);
  const { url, method, body } = calls.at(-1)!;
  assert.deepEqual({ url, method, body }, { url: "/api/boards/b1/notes", method: "PUT", body: JSON.stringify({ text: "hello" }) });
  assert.notEqual(calls.at(-1)!.keepalive, true);
  // a refusal (not a busy server, which the save path retries) rejects with its status
  status = 401;
  await assert.rejects(saveNotes("b1", "hello"), (e: Error & { status?: number }) => e.status === 401);
  status = 204;
  await saveNotes("b1", "short", true);
  assert.equal(calls.at(-1)!.keepalive, true);
  await saveNotes("b1", "x".repeat(70_000), true);
  assert.notEqual(calls.at(-1)!.keepalive, true, "past the browser's keepalive cap it goes as an ordinary request");

  // a board read warmed ahead of the click must not survive a save of that board's log
  await StrataAPI.warmBoard("b1");
  const reads = () => calls.filter((c) => c.url === "/api/boards/b1").length;
  assert.equal(reads(), 1);
  await saveNotes("b1", "changed");
  await StrataAPI.getBoard("b1");
  assert.equal(reads(), 2, "the read after the save asks the server again");
});

test("text whose save failed is owed until a save of it lands; text on its beat is not", async () => {
  const { ns, sent, beat } = harness();
  let told = 0;
  ns.subscribe(() => { told++; });
  ns.seed("b1", "start");
  ns.edit("start, typed on the train");
  assert.equal(ns.owes(), false, "on its beat: pagehide sends it");
  beat();
  sent[0].reply.reject(Object.assign(new Error("offline — read only"), { status: 0 })); await settle();
  assert.equal(ns.owes(), true, "refused with the wire down: owed");
  const before = told;
  ns.edit("start, typed on the train, and more");
  assert.equal(ns.owes(), true, "typing on keeps it owed");
  beat();
  sent[1].reply.resolve(); await settle();
  assert.equal(ns.owes(), false, "a save of it landed");
  assert.ok(told > before, "the listeners heard it change");
});

test("text held under 'changed elsewhere' is owed, and so is a left board's until it lands", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "start");
  ns.edit("mine"); beat();
  sent[0].reply.reject(Object.assign(new Error("changed elsewhere"), { status: 409, conflict: { value: { text: "theirs" } } })); await settle();
  assert.equal(ns.owes(), true, "held, unsent, until the person chooses");
  ns.useTheirs();
  assert.equal(ns.owes(), false);
  ns.edit("a last line"); beat();
  ns.seed("b2", "other");                                    // left while b1's save is out
  assert.equal(ns.owes(), true, "b1's text is owed to b1");
  sent[1].reply.resolve(); await settle();
  assert.equal(ns.owes(), false, "taken");
});

test("a left board's save refused for good is dropped and said once, not sent before every save", async () => {
  const { ns, sent, failures, beat } = harness();
  ns.seed("A", "a0");
  ns.edit("a0 + last line");
  ns.seed("B", "b0");                                        // left with A's last line unsent
  assert.deepEqual(sent.map((s) => `${s.board}:${s.text}`), ["A:a0 + last line"]);
  sent[0].reply.reject(Object.assign(new Error("no such board"), { status: 404 })); await settle();
  assert.equal(ns.owes(), false, "nowhere to put it: nothing is owed");
  for (const t of ["b1", "b2", "b3"]) {
    ns.edit(t); beat();
    sent.at(-1)!.reply.resolve(); await settle();
  }
  assert.deepEqual(sent.map((s) => `${s.board}:${s.text}`), ["A:a0 + last line", "B:b1", "B:b2", "B:b3"], "A is not sent again");
  assert.equal(failures.length, 1, "said once");
  assert.equal(ns.getSnapshot().saved, true);
});

test("a left board's save that may still land (busy, signed out) stays owed", async () => {
  for (const status of [503, 401]) {
    const { ns, sent } = harness();
    ns.seed("A", "a0");
    ns.edit("a0 + last line");
    ns.seed("B", "b0");
    sent[0].reply.reject(Object.assign(new Error("not now"), { status })); await settle();
    assert.equal(ns.owes(), true, `${status}: kept for the next edit, blur, board or leave`);
  }
});

// A snapshot landing while the box holds a draft must not move the draft's If-Match base.
const changedElsewhere = (rev: number, text: string) =>
  Object.assign(new Error("changed elsewhere"), { status: 409, conflict: { rev, value: { text } } });

test("a save carries the revision its text was written over: the seed's, then each answer's", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "server", { rev: 7 });
  ns.edit("server, then A"); beat();
  assert.equal(sent[0].base, 7, "the first draft is written over the revision the box was seeded with");
  sent[0].reply.resolve({ rev: 30, notesRev: 12 }); await settle();
  ns.edit("server, then A and B"); beat();
  assert.equal(sent[1].base, 12, "the next over the revision the last save produced");
  sent[1].reply.resolve(null); await settle();         // an answer that names no revision
  ns.edit("server, then A, B and C"); beat();
  assert.equal(sent[2].base, null, "unknown is said as unknown (the sender reads the store), never guessed");
});

test("a snapshot landing mid-draft does not move the draft's base: its save is refused, and the person is asked", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "as both tabs read it", { rev: 7 });
  ns.edit("as both tabs read it, and mine");
  // another tab saved; a board snapshot (a reopen, a poll, another write's answer) carries it
  assert.equal(ns.seed("b1", "as both tabs read it, and theirs", { rev: 9 }), "as both tabs read it, and mine", "the box keeps the draft");
  assert.equal(sent.length, 1, "the snapshot sends the draft at once");
  assert.equal(sent[0].base, 7, "over the revision it was written over, not the snapshot's");
  sent[0].reply.reject(changedElsewhere(9, "as both tabs read it, and theirs")); await settle();
  assert.equal(ns.getSnapshot().conflict, true, "asked: keep mine or use theirs");
  ns.edit("as both tabs read it, and mine, more"); beat();
  assert.equal(sent.length, 1, "nothing goes out over theirs until the person chooses");
  ns.keepMine();
  assert.deepEqual([sent[1].text, sent[1].base], ["as both tabs read it, and mine, more", 9], "Keep mine: the box, over their revision");
});

test("Use theirs takes their revision as the box's base; a clean box takes a reopen's", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "ours", { rev: 3 });
  ns.edit("mine"); beat();
  sent[0].reply.reject(changedElsewhere(8, "theirs")); await settle();
  assert.equal(ns.useTheirs(), "theirs");
  ns.edit("theirs, and then mine"); beat();
  assert.equal(sent[1].base, 8, "written over their text, at their revision");
  sent[1].reply.resolve({ notesRev: 11 }); await settle();
  assert.equal(ns.seed("b1", "newer, from elsewhere", { rev: 14 }), "newer, from elsewhere", "no draft: the box takes the reopen's text");
  ns.edit("newer, from elsewhere, and mine"); beat();
  assert.equal(sent[2].base, 14, "and its revision");
});

test("a board left with a draft keeps that draft's base, there and when you come back to it", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "b1 as read", { rev: 4 });
  ns.edit("b1 as read, and mine"); beat();             // on the wire
  ns.edit("b1 as read, and mine, more");               // typed while it is out
  ns.seed("b2", "b2 as read", { rev: 6 });             // away to another board
  sent[0].reply.resolve({ notesRev: 5 }); await settle();
  assert.deepEqual([sent[1].board, sent[1].text, sent[1].base], ["b1", "b1 as read, and mine, more", 5],
    "the left text goes over the revision its own earlier save produced: it was typed over that text");
  sent[1].reply.reject(Object.assign(new Error("busy"), { status: 503 })); await settle();
  assert.equal(ns.seed("b1", "b1, changed elsewhere", { rev: 9 }), "b1 as read, and mine, more", "back on b1: your text");
  ns.flush();
  assert.deepEqual([sent[2].text, sent[2].base], ["b1 as read, and mine, more", 5],
    "not over the reopen's revision: the server refuses it if the log moved meanwhile, and the person is asked");
});

test("a 409 whose 'theirs' is this box's own unanswered save is not a conflict: the newer text goes out over it", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "start", { rev: 7 });
  ns.edit("T1"); beat();
  assert.equal(sent[0].base, 7);
  sent[0].reply.reject(Object.assign(new Error("Failed to fetch"), {}));   // the answer is lost; the server may hold T1
  await settle();
  ns.edit("T1 and more"); beat();
  const second = sent.at(-1)!;
  assert.equal(second.text, "T1 and more");
  assert.equal(second.base, 7, "still written over the revision the box knows");
  second.reply.reject(Object.assign(new Error("changed elsewhere"), { status: 409, conflict: { rev: 8, value: { text: "T1" } } }));
  await settle();
  assert.equal(ns.getSnapshot().conflict, false, "T1 was this box's own save: nothing to choose between");
  const third = sent.at(-1)!;
  assert.deepEqual([third.text, third.base], ["T1 and more", 8], "the newer text goes out over the server's revision");
  third.reply.resolve({ notesRev: 9 }); await settle();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
});

test("a 409 whose 'theirs' is text this box never sent is still a conflict", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "start", { rev: 7 });
  ns.edit("mine"); beat();
  sent[0].reply.reject(Object.assign(new Error("changed elsewhere"), { status: 409, conflict: { rev: 8, value: { text: "another tab's" } } }));
  await settle();
  assert.equal(ns.getSnapshot().conflict, true);
});

test("a read answered before the box's own save landed, arriving after it, does not take the box back", async () => {
  const { ns, sent, beat, open } = harness();
  open("b1", "start", { rev: 5 });
  ns.edit("start, and my last sentence");              // typing; Back pressed inside the beat
  beat();                                              // the save leaves; the board read is still out
  sent[0].reply.resolve({ notesRev: 6 }); await settle();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
  assert.equal(open("b1", "start", { rev: 5 }), "start, and my last sentence", "the read answered at rev 5 lands late: the box keeps rev 6's text");
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false }, "and still says saved: the server holds it");
  ns.edit("start, and my last sentence, and one more"); beat();
  assert.deepEqual([sent[1].text, sent[1].base], ["start, and my last sentence, and one more", 6], "the next save goes over rev 6, not the late read's 5");
});

test("the same late read, landing after the box went to another board and came back, is older than the save too", async () => {
  const { ns, sent, open } = harness();
  open("b1", "start", { rev: 5 });
  ns.edit("start, and my last sentence");
  open("b2", "other", { rev: 2 });                  // away: b1's text goes to b1
  open("b1", "start", { rev: 5 });                  // …and back, the box showing what was typed there
  sent[0].reply.resolve({ notesRev: 6 }); await settle();
  open("b2", "other", { rev: 2 });                  // away again
  assert.equal(open("b1", "start", { rev: 5 }), "start, and my last sentence", "a read of b1 answered before the save landed");
  ns.edit("start, and my last sentence, more"); ns.flush();
  assert.deepEqual([sent.at(-1)!.text, sent.at(-1)!.base], ["start, and my last sentence, more", 6]);
  // …while a read NEWER than what the box holds is taken as before
  sent.at(-1)!.reply.resolve({ notesRev: 7 }); await settle();
  assert.equal(open("b1", "changed elsewhere since", { rev: 9 }), "changed elsewhere since");
});

test("a late older answer does not take back the text a conflict is choosing against", async () => {
  const { ns, sent, beat, open } = harness();
  open("b1", "start", { rev: 5 });
  ns.edit("mine"); beat();
  sent[0].reply.reject(changedElsewhere(9, "theirs, at 9")); await settle();
  open("b1", "theirs, at 8", { rev: 8 });          // a read that left before rev 9
  assert.equal(ns.useTheirs(), "theirs, at 9");
  ns.edit("theirs, at 9, and mine"); beat();
  assert.equal(sent.at(-1)!.base, 9);
});

test("a saved offline copy older than the box's own save shows the newer text, sealed until the live read", async () => {
  const { ns, sent, beat, open } = harness();
  open("b1", "start", { rev: 5 });
  ns.edit("start, and my last sentence"); beat();
  sent[0].reply.resolve({ notesRev: 6 }); await settle();
  open("b2", "other", { rev: 1 });
  assert.equal(open("b1", "start", { rev: 5, stale: true }), "start, and my last sentence", "the copy from before the save shows the save's text");
  assert.equal(ns.stale, true, "still a saved copy: the box stays shut");
  ns.edit("typed over a copy"); ns.flush();
  assert.equal(sent.length, 1, "nothing is saved over it");
  assert.equal(open("b1", "start, and my last sentence", { rev: 6 }), "start, and my last sentence", "the live read");
  assert.equal(ns.stale, false, "lifts the seal");
  ns.edit("start, and my last sentence, more"); beat();
  assert.deepEqual([sent[1].text, sent[1].base], ["start, and my last sentence, more", 6]);
});

const lostAnswer = () => Object.assign(new Error("Failed to fetch"), {});

test("after a lost answer, a box edited back to the last confirmed text is still sent, so the server ends on it", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "confirmed", { rev: 4 });
  ns.edit("confirmed, and a line I took back"); beat();
  sent[0].reply.reject(lostAnswer()); await settle();     // it may have landed
  ns.edit("confirmed"); beat();                           // …taken back
  assert.equal(ns.getSnapshot().saved, false, "not 'saved': the server may hold the taken-back line");
  assert.deepEqual([sent.at(-1)!.text, sent.at(-1)!.base], ["confirmed", 4], "sent, over the revision the box knows");
  // it had landed: the server refuses with the lost save's own text, and the box goes over it
  sent.at(-1)!.reply.reject(changedElsewhere(5, "confirmed, and a line I took back")); await settle();
  assert.equal(ns.getSnapshot().conflict, false, "the box's own lost save, not a change elsewhere");
  assert.deepEqual([sent.at(-1)!.text, sent.at(-1)!.base], ["confirmed", 5]);
  sent.at(-1)!.reply.resolve({ notesRev: 6 }); await settle();
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false });
});

test("after a lost answer, text edited back is owed on the way out and kept for its board on a switch", async () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "confirmed", { rev: 4 });
  ns.edit("confirmed, plus"); beat();
  sent[0].reply.reject(lostAnswer()); await settle();
  ns.edit("confirmed"); ns.flush();
  sent.at(-1)!.reply.reject(lostAnswer()); await settle(); // lost again
  assert.equal(ns.owes(), true, "the page going away asks first");
  const before = sent.length;
  ns.seed("b2", "other", { rev: 1 });                     // away to another board
  assert.deepEqual(sent.slice(before).map((s) => [s.board, s.text]), [["b1", "confirmed"]], "b1's text goes to b1");
  assert.equal(ns.owes(), true, "and stays owed to it until it lands");
  sent.at(-1)!.reply.resolve({ notesRev: 6 }); await settle();
  assert.equal(ns.owes(), false);
});

test("a read of the board settles a lost answer only once the log has moved past the revision it was sent over", async () => {
  const lostTwice = async (read: { text: string; rev: number }) => {
    const h = harness();
    h.open("b1", "confirmed", { rev: 4 });
    h.ns.edit("confirmed, plus"); h.beat();
    h.sent[0].reply.reject(lostAnswer()); await settle();  // may have landed
    h.open("b2", "other", { rev: 1 });                  // away: b1's text is owed to b1…
    h.sent[1].reply.reject(lostAnswer()); await settle();  // …and lost again
    assert.equal(h.open("b1", read.text, { rev: read.rev }), "confirmed, plus", "back on b1: the text typed there");
    h.sent.at(-1)!.reply.reject(lostAnswer()); await settle();
    const before = h.sent.length;
    h.ns.edit(read.text); h.ns.flush();                    // edited back to what the read said
    return { ...h, after: h.sent.slice(before) };
  };
  // a read at the revision the lost save was written over: it may land yet, after the read
  const atBase = await lostTwice({ text: "confirmed", rev: 4 });
  assert.deepEqual(atBase.after.map((s) => [s.text, s.base]), [["confirmed", 4]], "still sent: the server may end on the lost text");
  // a read past it (another device wrote since): the lost save can no longer land (If-Match)
  const past = await lostTwice({ text: "written elsewhere", rev: 7 });
  assert.deepEqual(past.after, [], "nothing to send: the box holds what the server holds");
  assert.equal(past.ns.owes(), false);
  assert.equal(past.ns.getSnapshot().saved, true, "and the blur that found nothing to send says so");
});

test("typing and deleting back inside the beat says saved when the beat finds nothing to send", () => {
  const { ns, sent, beat } = harness();
  ns.seed("b1", "as saved", { rev: 2 });
  ns.edit("as saved, x");
  ns.edit("as saved");
  assert.equal(ns.getSnapshot().saved, false, "on its beat");
  beat();
  assert.equal(sent.length, 0);
  assert.deepEqual(ns.getSnapshot(), { saved: true, error: null, conflict: false }, "not left at '…'");
  ns.edit("as saved, y"); ns.edit("as saved"); ns.flush();  // a blur inside the beat, the same
  assert.equal(ns.getSnapshot().saved, true);
});
