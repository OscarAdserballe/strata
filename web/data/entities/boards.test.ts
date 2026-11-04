import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardState, Message } from "../../../shared/types/index.ts";
import { Store } from "../store.ts";
import { applyBoardState, authoredKey, boardKey, keepDrawn, threadKey, THREAD_PAGE, type BoardEntity, type NotesEntity, type ThreadEntity } from "./boards.ts";
import { confirmByShape } from "./confirm.ts";

const msg = (idx: number, resourceId: string | null = null): Message => ({ role: idx % 2 ? "model" : "user", text: `m${idx}`, idx, resourceId });
function snapshot(over: Partial<BoardState> & Record<string, unknown> = {}): BoardState {
  return {
    board: { id: "b1", title: "Corporate finance", type: "board" },
    messages: [msg(0), msg(1)], resources: [], budget: { usedTokens: 0, targetTokens: 1, over: false }, deck: null, pairs: [],
    notes: "the log", trees: {}, sections: [], marks: [], minted: [], mintedEverywhere: [], windowFrom: { "": 0 }, touched: {},
    plan: { purpose: "pass", groups: [], milestones: [], places: {} },
    ...over,
  } as BoardState;
}

test("a snapshot without revs splits into its keys at rev 0, and the next one replaces it", () => {
  const s = new Store();
  assert.equal(applyBoardState(snapshot(), {}, s), true);
  assert.equal(s.get<BoardEntity>("board:b1")?.board.title, "Corporate finance");
  assert.deepEqual(s.get<NotesEntity>("notes:b1"), { text: "the log", notesRev: 0 });
  assert.deepEqual(s.get("marks:b1"), []);
  assert.deepEqual(s.get("plan:b1"), { purpose: "pass", groups: [], milestones: [], places: {}, rev: 0 });
  assert.deepEqual(s.get("authored:b1"), []);
  assert.deepEqual(s.get<ThreadEntity>("thread:b1/")?.messages.map((m) => m.idx), [0, 1]);
  assert.equal(s.entry("board:b1")?.rev, 0);
  assert.equal(applyBoardState(snapshot({ notes: "edited" }), {}, s), true, "equal revs replace: today's behaviour");
  assert.equal(s.get<NotesEntity>("notes:b1")?.text, "edited");
  assert.equal(s.get<BoardEntity>("board:b1") && "notes" in (s.get<BoardEntity>("board:b1") as object), false, "notes live under their own key");
});

test("revs order every key of the board: an older snapshot arriving late changes none of them", () => {
  const s = new Store();
  applyBoardState(snapshot({ rev: 8, notesRev: 6, notes: "new", plan: { purpose: "new", groups: [], milestones: [], places: {}, rev: 4 } } as never), { epoch: "e" }, s);
  assert.equal(applyBoardState(snapshot({ rev: 7, notes: "old" } as never), { epoch: "e" }, s), false);
  assert.deepEqual(s.get<NotesEntity>("notes:b1"), { text: "new", notesRev: 6 });
  assert.equal(s.get<{ purpose: string; rev: number }>("plan:b1")?.rev, 4);
  assert.equal(s.entry("marks:b1")?.rev, 8);
  // a shelf copy never replaces what the wire said
  assert.equal(applyBoardState(snapshot({ rev: 99, notes: "shelf" } as never), { epoch: "e", origin: "shelf" }, s), false);
  assert.equal(s.get<NotesEntity>("notes:b1")?.text, "new");
});

// Reading stats move every 15 s while you read; the route must not re-render for them.
const source = (id: string, over: Record<string, unknown> = {}) => ({ id, filename: id + ".pdf", mime: "application/pdf", kind: "pdf", tokens: 10,
  included: true, originUrl: null, read: "unread", readPct: 0, readMs: 0, createdAt: 1, lastReadAt: null, doneAt: null, ...over });
const entity = (over: Partial<BoardEntity> & Record<string, unknown> = {}) => {
  const s = new Store();
  applyBoardState(snapshot({ resources: [source("r1")], ...over } as never), {}, s);
  return s.get<BoardEntity>(boardKey(String((over.board as { id?: string } | undefined)?.id ?? "b1")))!;
};

test("keepDrawn: the same board drawn the same keeps the view; what it draws, another board or no board gives the new one", () => {
  const drawn = entity();
  assert.equal(keepDrawn(undefined, drawn), drawn, "nothing drawn yet: the key's");
  assert.equal(keepDrawn(drawn, undefined), undefined, "no board open (no key held): none");
  assert.equal(keepDrawn(drawn, entity({ touched: { d: { seen: 3, done: 1, last: "c9" } } } as never)), drawn, "a card shown (touched) draws the same");
  assert.equal(keepDrawn(drawn, entity({ windowFrom: { "": 40 } })), drawn, "a long thread's window draws the same");
  assert.equal(keepDrawn(drawn, entity({ resources: [source("r1", { read: "opened", readPct: 40, readMs: 15000, lastReadAt: 9 })] } as never)), drawn,
    "a source's reading stats draw the same");
  const renamed = entity({ resources: [source("r1", { filename: "Lecture 1.pdf" })] } as never);
  assert.equal(keepDrawn(drawn, renamed), renamed, "a source renamed draws differently");
  const added = entity({ resources: [source("r1"), source("r2")] } as never);
  assert.equal(keepDrawn(drawn, added), added, "a new source draws differently");
  const minted = entity({ mintedEverywhere: [{ id: "m1" }] } as never);
  assert.equal(keepDrawn(drawn, minted), minted, "a question asked anywhere draws differently");
  const other = entity({ board: { id: "b2", title: "Corporate finance", type: "board" } });
  assert.equal(keepDrawn(drawn, other), other, "another board is never the same board drawn");
});

test("the board in hand is the store's: a late older read does not step it back, a chat turn's answer keeps it, a new question moves it", () => {
  const s = new Store();
  let drawn: BoardEntity | undefined;
  const select = () => (drawn = keepDrawn(drawn, s.get<BoardEntity>(boardKey("b1"))));   // useBoardView's selector, run on each change
  applyBoardState(snapshot({ rev: 12, resources: [source("r2")] } as never), { epoch: "e" }, s);
  assert.equal(applyBoardState(snapshot({ rev: 11, resources: [source("r1"), source("r2")] } as never), { epoch: "e" }, s), false);
  const first = select()!;
  assert.deepEqual(first.resources.map((r) => r.id), ["r2"], "the room keeps the delete's answer");
  const mine = s.get(authoredKey("b1"));
  applyBoardState(snapshot({ rev: 13, resources: [source("r2", { read: "read", readPct: 95, readMs: 60000, lastReadAt: 13 })], touched: { d: { seen: 3, done: 1, last: "c9" } } } as never), { epoch: "e" }, s);
  assert.notEqual(s.get(boardKey("b1")), first, "the key holds the chat turn's snapshot…");
  assert.equal(select(), first, "…and the room draws the board it drew");
  assert.equal(s.get(authoredKey("b1")), mine, "your questions are the list already held: the view stays");
  applyBoardState(snapshot({ rev: 14, resources: [source("r2")], minted: [{ id: "m1", front: "why?" }] } as never), { epoch: "e" }, s);
  assert.notEqual(s.get(authoredKey("b1")), mine, "a new question is a new list: a new view");
  assert.equal(select(), first, "…while the board itself draws the same");
  applyBoardState(snapshot({ rev: 15, resources: [source("r2"), source("r3")] } as never), { epoch: "e" }, s);
  assert.notEqual(select(), first, "a new source is a new board drawn");
});

test("a snapshot carries one thread's newest page: a short page is the whole thread, a full one keeps older pages beneath it", () => {
  const s = new Store();
  const full = Array.from({ length: THREAD_PAGE }, (_, i) => msg(200 + i, "r1"));
  // an older page read through GET …/messages, then a full newest page over it
  s.apply<ThreadEntity>(threadKey("b1", "r1"), 0, { messages: [msg(150, "r1"), msg(151, "r1")], windowFrom: 0, before: 150 }, "wire");
  applyBoardState(snapshot({ messages: full, windowFrom: { r1: 210 } }), { thread: "r1" }, s);
  const thread = s.get<ThreadEntity>(threadKey("b1", "r1"))!;
  assert.deepEqual(thread.messages.slice(0, 3).map((m) => m.idx), [150, 151, 200], "older pages stay beneath a full page");
  assert.equal(thread.windowFrom, 210);
  assert.equal(thread.before, 150);
  // the thread is cleared, and one new turn is asked: the page is short, so it is all there is
  applyBoardState(snapshot({ messages: [msg(400, "r1"), msg(401, "r1")] }), {}, s);
  assert.deepEqual(s.get<ThreadEntity>(threadKey("b1", "r1"))?.messages.map((m) => m.idx), [400, 401], "read from the page's messages");
  assert.equal(s.get<ThreadEntity>(threadKey("b1", "r1"))?.before, null);
  applyBoardState(snapshot({ messages: [] }), { thread: null }, s);
  assert.deepEqual(s.get<ThreadEntity>("thread:b1/")?.messages, [], "an empty page for the board's own thread: empty");
  assert.equal(s.get<ThreadEntity>(threadKey("b1", "r1"))?.messages.length, 2, "another thread is untouched");
  applyBoardState(snapshot({ messages: [] }), {}, s);
  assert.equal(s.get<ThreadEntity>(threadKey("b1", "r1"))?.messages.length, 2, "an empty page naming no thread touches none");
});

test("clearing a source's thread empties that thread, never the board's own", () => {
  const s = new Store();
  applyBoardState(snapshot({ messages: [msg(0), msg(1)] }), { thread: null }, s);
  applyBoardState(snapshot({ messages: [msg(5, "r1")] }), {}, s);
  // DELETE /api/boards/b1/messages?resource=r1 answers {state: boardState(b1, r1)}: an empty page
  confirmByShape({ path: "/api/boards/b1/messages?resource=r1" }, { state: snapshot({ messages: [] }) }, { rev: 9, epoch: "" }, s);
  assert.deepEqual(s.get<ThreadEntity>(threadKey("b1", "r1"))?.messages, [], "the source's thread is cleared");
  assert.deepEqual(s.get<ThreadEntity>("thread:b1/")?.messages.map((m) => m.idx), [0, 1], "the board's own conversation is untouched");
  confirmByShape({ path: "/api/boards/b1/messages" }, { state: snapshot({ messages: [] }) }, { rev: 10, epoch: "" }, s);
  assert.deepEqual(s.get<ThreadEntity>("thread:b1/")?.messages, [], "without ?resource it is the board's own");
});

test("a part that arrives unchanged keeps its view: a chat turn's snapshot repaints the thread, not the marks", () => {
  const s = new Store();
  const mark = { id: "mk-1", resourceId: "r", page: 3, start: 0, end: 3, quote: "abc", note: null, rects: [{ x: 1, y: 2, w: 3, h: 4 }], createdAt: 1 };
  applyBoardState(snapshot({ rev: 4, marks: [mark] } as never), {}, s);
  const marks = s.get("marks:b1"), notes = s.get("notes:b1"), plan = s.get("plan:b1"), board = s.get("board:b1");
  applyBoardState(snapshot({ rev: 5, marks: [structuredClone(mark)], messages: [msg(0), msg(1), msg(2), msg(3)] } as never), {}, s);
  assert.equal(s.get("marks:b1"), marks, "freshly parsed, the same rows: the same view");
  assert.equal(s.get("notes:b1"), notes);
  assert.equal(s.get("plan:b1"), plan);
  assert.equal(s.get("board:b1"), board);
  assert.equal(s.entry("marks:b1")?.rev, 5, "the rev still moves");
  assert.equal(s.get<ThreadEntity>("thread:b1/")?.messages.length, 4, "the part that changed is new");
});

test("a section's tree turning ready in a snapshot invalidates its deck, which no answer carried", () => {
  const s = new Store();
  const tree = (status: string) => ({ status, cards: 0, error: null, at: 0 });
  applyBoardState(snapshot({ trees: { s1: tree("running"), s2: tree("ready") } }), {}, s);
  s.apply("deck:src-s1", 1, { ids: [] }, "wire");
  s.apply("deck:src-s2", 1, { ids: ["c"] }, "wire");
  applyBoardState(snapshot({ trees: { s1: tree("ready"), s2: tree("ready") } }), {}, s);
  assert.equal(s.entry("deck:src-s1")?.stale, true, "turned ready: stale");
  assert.equal(s.entry("deck:src-s2")?.stale, false, "was ready already");
});

test("an answer confirms by its shape: state and destState, plan, mark, card and ids", () => {
  const s = new Store();
  applyBoardState(snapshot({ rev: 1 } as never), {}, s);
  const meta = { rev: 30, epoch: "" };
  confirmByShape({ path: "/api/boards/b1/plan/order" }, { plan: { purpose: "moved", groups: [], milestones: [], places: {}, rev: 5 }, rev: 3 }, meta, s);
  assert.deepEqual(s.get("plan:b1"), { purpose: "moved", groups: [], milestones: [], places: {}, rev: 5 });
  assert.equal(s.entry("plan:b1")?.rev, 3, "ordered by the board rev the answer carried");
  const mark = { id: "mk-1", resourceId: "r", page: null, start: 0, end: 3, quote: "abc", note: null, rects: [], createdAt: 1 };
  confirmByShape({ path: "/api/boards/b1/marks" }, { id: "mk-1", mark, rev: 4 }, meta, s);
  confirmByShape({ path: "/api/boards/b1/marks/mk-1" }, { mark: { ...mark, note: "why" }, rev: 5 }, meta, s);
  assert.deepEqual(s.get("marks:b1"), [{ ...mark, note: "why" }], "a row folded in place");
  confirmByShape({ path: "/api/decks/fin%201/cards/c1" }, { ok: true, card: { id: "c1", deck: "fin", type: "flashcard", ord: 0, rev: 2 }, rev: 9 }, meta, s);
  assert.equal(s.entry("card:c1")?.rev, 9);
  confirmByShape({ path: "/api/decks/fin%201/keeps" }, { ids: ["c1"] }, meta, s);
  assert.deepEqual(s.get("keeps:fin 1"), { ids: ["c1"] }, "a missing rev reads as 0, never a crash");
  confirmByShape({ path: "/api/boards/b1/pairs/p/move" }, { to: "b2", state: snapshot({ rev: 6, notes: "moved from" } as never), destState: snapshot({ board: { id: "b2", title: "Other", type: "board" }, rev: 6 } as never) }, meta, s);
  assert.equal(s.get<NotesEntity>("notes:b1")?.text, "moved from");
  assert.equal(s.get<BoardEntity>("board:b2")?.board.title, "Other");
  confirmByShape({ path: "/api/boards/b1/notes" }, null, meta, s);   // a 204: nothing to read
});
