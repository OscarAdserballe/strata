import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardListEntry, RegisterResponse } from "../../../shared/types/index.ts";
import { Store } from "../store.ts";
import { ATTEMPT_DEADLINE_MS, Mutator, RETRY_DELAYS_MS, type SendAnswer, type SendRequest } from "../mutate.ts";
import { BOARDS, REGISTER, boardOps, run, sourceOps } from "./sources.ts";
import { applyBoardState, boardKey, type BoardEntity } from "./boards.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const entry = (resourceId: string, boardId: string, filename: string) =>
  ({ resourceId, pairId: "p-" + resourceId, boardId, boardTitle: "T " + boardId, unfiled: boardId === "inbox", filename, kind: "text", originUrl: null, createdAt: 1 });
const reg = (...entries: ReturnType<typeof entry>[]) => ({ entries, overview: {}, keptRecent: [] } as unknown as RegisterResponse);
const board = (id: string, title: string) => ({ id, title, resources: [], msgCount: 0, touchedAt: 1 } as unknown as BoardListEntry);
const state = (id: string) => ({ board: { id, title: "t" }, resources: [], pairs: [], sections: [], trees: {}, messages: [] });

function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({ store, transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })), setTimer: () => 0, clearTimer: () => {} });
  let reads = 0;
  store.watch(REGISTER, () => {}, async () => { reads++; return { value: reg(entry("r1", "b1", "old.md"), entry("r2", "b2", "other.md")), rev: 50, stamp: 50, epoch: "", origin: "wire" as const }; });
  store.apply(REGISTER, 5, reg(entry("r1", "b1", "old.md"), entry("r2", "b2", "other.md")), "wire", { stamp: 5 });
  store.apply(BOARDS, 5, [board("b1", "One"), board("b2", "Two")], "wire", { stamp: 5 });
  return { store, sent, m, reads: () => reads };
}
const names = (s: Store) => (s.get<RegisterResponse>(REGISTER)?.entries ?? []).map((e) => e.filename).join(",");

test("a source rename is one request, shown at once, kept through the answer and read again past it", async () => {
  const { store, sent, m, reads } = room();
  const saving = m.mutate(sourceOps.rename("b1", "r1", "Lecture 3", store));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].req.method, "PATCH");
  assert.equal(sent[0].req.path, "/api/boards/b1/resources/r1");
  assert.deepEqual(JSON.parse(sent[0].req.body!), { filename: "Lecture 3", pair: true }, "the source and its one pair, in one request");
  assert.ok(sent[0].req.headers["Idempotency-Key"]);
  assert.equal(names(store), "Lecture 3,other.md", "the row says the new name before the answer");
  sent[0].reply({ status: 200, body: { state: state("b1") }, rev: 20, epoch: "" });
  await saving;
  assert.equal(store.entry(REGISTER)?.layers.length, 0);
  assert.equal(names(store), "Lecture 3,other.md", "folded into the held list: no flicker back to the old name");
  await tick();
  assert.equal(reads(), 1, "the watched register is asked again past the rename's stamp");
});

test("a board delete takes the board and its rows away at once, and puts them back when refused", async () => {
  const { store, sent, m } = room();
  const deleting = m.mutate(boardOps.remove("b1", store)).catch((e) => e);
  assert.deepEqual(store.get<BoardListEntry[]>(BOARDS)?.map((b) => b.id), ["b2"]);
  assert.equal(names(store), "other.md");
  sent[0].reply({ status: 404, body: { error: "no such board" }, rev: 0, epoch: "" });
  assert.equal((await deleting).status, 404);
  assert.deepEqual(store.get<BoardListEntry[]>(BOARDS)?.map((b) => b.id), ["b1", "b2"], "refused: back on the list");
  assert.equal(names(store), "old.md,other.md");
});

test("a board rename renames the list and the register's rows; a create lands at the head of the list", async () => {
  const { store, sent, m } = room();
  const renaming = m.mutate(boardOps.rename("b2", "Second", store));
  assert.equal(store.get<BoardListEntry[]>(BOARDS)?.[1].title, "Second");
  assert.equal(store.get<RegisterResponse>(REGISTER)?.entries[1].boardTitle, "Second");
  sent[0].reply({ status: 200, body: { board: { id: "b2", title: "Second" }, state: state("b2") }, rev: 21, epoch: "" });
  await renaming;
  const creating = m.mutate(boardOps.create({ title: "Fresh" }, store));
  assert.deepEqual(JSON.parse(sent[1].req.body!), { title: "Fresh" });
  sent[1].reply({ status: 201, body: { board: { id: "b3", title: "Fresh" }, state: state("b3") }, rev: 22, epoch: "" });
  await creating;
  assert.deepEqual(store.get<BoardListEntry[]>(BOARDS)?.map((b) => b.id), ["b3", "b1", "b2"]);
  assert.ok(store.get("board:b3"), "the new board's snapshot is in the store");
});

test("a board rename retitles the board's own key at once; each guess goes with its own answer", async () => {
  const { store, sent, m } = room();
  const title = () => store.get<BoardEntity>(boardKey("b2"))?.board.title;
  applyBoardState({ ...state("b2"), board: { id: "b2", title: "Two" } } as never, { epoch: "" }, store);
  const first = m.mutate(boardOps.rename("b2", "Second", store));
  assert.equal(title(), "Second", "shown at once");
  const second = m.mutate(boardOps.rename("b2", "Third", store));
  assert.equal(title(), "Third", "the newer guess on top");
  sent[0].reply({ status: 200, body: { board: { id: "b2", title: "Second" }, state: { ...state("b2"), board: { id: "b2", title: "Second" } } }, rev: 21, epoch: "" });
  await first; await tick();
  assert.equal(title(), "Third", "the first answer takes off only its own guess");
  sent[1].reply({ status: 200, body: { board: { id: "b2", title: "Third" }, state: { ...state("b2"), board: { id: "b2", title: "Third" } } }, rev: 22, epoch: "" });
  await second;
  assert.equal(title(), "Third");
  assert.equal(store.entry(boardKey("b2"))?.layers.length, 0, "no guess is left behind");
  const refused = m.mutate(boardOps.rename("b2", "Fourth", store)).catch((e) => e);
  assert.equal(title(), "Fourth");
  await tick();
  sent[2].reply({ status: 409, body: { error: "no" }, rev: 0, epoch: "" });
  await refused;
  assert.equal(title(), "Third", "refused: the title goes back");
  assert.equal(store.entry(boardKey("b2"))?.layers.length, 0);
});

test("filing waits behind a write to either board it names, and moves the row at once", async () => {
  const { store, sent, m } = room();
  const renaming = m.mutate(boardOps.rename("b2", "Two!", store));
  const filing = m.mutate(sourceOps.file("b1", "p-r1", "r1", "b2", "Two!", store));
  assert.equal(sent.length, 1, "the file waits for the destination board's rename");
  assert.equal(store.get<RegisterResponse>(REGISTER)?.entries[0].boardId, "b2", "…but the row has moved already");
  sent[0].reply({ status: 200, body: { board: { id: "b2", title: "Two!" }, state: state("b2") }, rev: 23, epoch: "" });
  await renaming; await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].req.path, "/api/boards/b1/pairs/p-r1/move");
  assert.deepEqual(JSON.parse(sent[1].req.body!), { to: "b2" });
  sent[1].reply({ status: 200, body: { to: "b2", state: state("b1"), destState: state("b2") }, rev: 24, epoch: "" });
  await filing;
  const row = store.get<RegisterResponse>(REGISTER)?.entries[0];
  assert.equal(row?.boardId, "b2");
  assert.equal(row?.unfiled, false);
});

test("a rename also renames the source on the board list, and the front board's where-you-left-off", async () => {
  const { store, sent, m } = room();
  store.apply(BOARDS, 6, [
    { ...board("b1", "One"), resources: [{ id: "r1", filename: "old.md", kind: "text" }], lastRead: { resourceId: "r1", filename: "old.md", deepest: 40 } },
    board("b2", "Two"),
  ], "wire", { stamp: 6 });
  const two = store.get<BoardListEntry[]>(BOARDS)?.[1];
  const saving = m.mutate(sourceOps.rename("b1", "r1", "Lecture 3", store));
  const front = () => store.get<BoardListEntry[]>(BOARDS)?.[0];
  assert.equal(front()?.resources[0].filename, "Lecture 3", "the board's own list of sources, at once");
  assert.equal(front()?.lastRead?.filename, "Lecture 3", "the Continue card, at once");
  assert.equal(store.get<BoardListEntry[]>(BOARDS)?.[1], two, "a board without it is left as it was");
  sent[0].reply({ status: 200, body: { state: state("b1") }, rev: 20, epoch: "" });
  await saving;
  assert.equal(store.entry(BOARDS)?.layers.length, 0);
  assert.equal(front()?.lastRead?.filename, "Lecture 3", "folded into the held list: no flicker back");
});

function failing() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const retries: (() => void)[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: (fn, wait) => { if (wait !== ATTEMPT_DEADLINE_MS) retries.push(fn); return 0; }, clearTimer: () => {},
  });
  store.apply(REGISTER, 5, reg(entry("r1", "b1", "old.md")), "wire", { stamp: 5 });
  store.apply(BOARDS, 5, [board("b1", "One")], "wire", { stamp: 5 });
  const exhaust = async () => {
    for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
      sent.at(-1)!.reply({ status: 500, body: { error: "boom" }, rev: 0, epoch: "" });
      await tick();
      if (i < RETRY_DELAYS_MS.length) retries.shift()!();
    }
  };
  return { store, sent, m, exhaust };
}

test("a source rename out of retries takes its name back and lets the next verb on that source go", async () => {
  const { store, sent, m, exhaust } = failing();
  const renaming = run(sourceOps.rename("b1", "r1", "Lecture 3", store), m).catch((e) => e);
  assert.equal(names(store), "Lecture 3");
  await exhaust();
  const e = await renaming;
  assert.equal(e.retryable, true, "out of retries");
  assert.equal(sent.length, RETRY_DELAYS_MS.length + 1);
  assert.equal(store.entry(REGISTER)?.layers.length, 0, "the guess is given up");
  assert.equal(names(store), "old.md", "the row says what the server has");
  assert.deepEqual(m.pending(), [], "nothing left holding the source's lane");
  const deleting = run(sourceOps.remove("b1", "r1", store), m);
  assert.equal(sent.length, RETRY_DELAYS_MS.length + 2, "a delete of the same source is sent, not queued behind it");
  assert.equal(sent.at(-1)!.req.method, "DELETE");
  sent.at(-1)!.reply({ status: 200, body: { state: state("b1") }, rev: 30, epoch: "" });
  await deleting;
  await m.settled();
});

test("a board create out of retries frees the new-board lane for the next one", async () => {
  const { store, sent, m, exhaust } = failing();
  const making = run(boardOps.create({ title: "Fresh" }, store), m).catch((e) => e);
  await exhaust();
  assert.equal((await making).retryable, true);
  assert.deepEqual(m.pending(), []);
  const again = run(boardOps.create({ title: "Fresh" }, store), m);
  assert.equal(sent.length, RETRY_DELAYS_MS.length + 2, "the next 'new board' is sent");
  sent.at(-1)!.reply({ status: 201, body: { board: { id: "b3", title: "Fresh" }, state: state("b3") }, rev: 22, epoch: "" });
  await again;
  assert.deepEqual(store.get<BoardListEntry[]>(BOARDS)?.map((b) => b.id), ["b3", "b1"]);
});
