import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

let boardId = "";

const server = useServer({ seed: async (s) => { boardId = await newBoard(s, { question: "How does duration hedging actually fail?" }); } });
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("create a board from a question → the question is the title, a welcome message exists", async () => {
  const { status, body } = await api("/api/boards", { method: "POST", body: JSON.stringify({ question: "How does duration hedging actually fail?" }) });
  assert.equal(status, 201);
  try {
    assert.equal(body.board.title, "How does duration hedging actually fail?");
    assert.equal(body.state.messages.length, 1);
    assert.equal(body.state.messages[0].role, "assistant");
    assert.deepEqual(body.state.resources, []);
    assert.equal(body.state.budget.over, false);
  } finally { await api(`/api/boards/${body.board.id}`, { method: "DELETE" }); }
});

// metadata only: this list must never carry a source's bytes
test("boards list carries resources (id, name, kind) + msgCount for the launcher", async () => {
  const { body } = await api("/api/boards");
  const b = body.boards.find((x: { id: string }) => x.id === boardId);
  assert.ok(b);
  assert.deepEqual(b.resources, []);
  assert.equal(b.msgCount, 1);
  const withFile = body.boards.find((x: { resources: unknown[] }) => x.resources.length);
  if (withFile) {
    const r = withFile.resources[0] as Record<string, unknown>;
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.filename, "string");
    assert.ok(["pdf", "text", "transcript", "article"].includes(r.kind as string));
    assert.deepEqual(Object.keys(r).sort(), ["filename", "id", "kind"]);
  }
});

// touch comes from the event sink, never a board GET: the offline warm pass fetches every board
test("boards list orders by last touch — the event sink bumps, a board GET does not", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "the newer board" }) });
  const otherId = made.board.id as string;
  await new Promise((res) => setTimeout(res, 5)); // distinct ms, so the order is a fact
  await api("/api/log", { method: "POST", body: JSON.stringify({ event: "board_enter", props: { board: boardId } }) });
  let { body } = await api("/api/boards");
  assert.equal(body.boards[0].id, boardId, "the touched board fronts the list");
  assert.equal(typeof body.boards[0].touchedAt, "number");
  assert.ok(Object.hasOwn(body.boards[0], "lastRead"), "the front board carries lastRead (null until something is read)");
  assert.ok(!Object.hasOwn(body.boards[1], "lastRead"), "only the front board pays for lastRead");
  await new Promise((res) => setTimeout(res, 5));
  await api(`/api/boards/${otherId}`);
  ({ body } = await api("/api/boards"));
  assert.equal(body.boards[0].id, boardId, "a warm-pass GET is not a touch");
  await api(`/api/boards/${otherId}`, { method: "DELETE" });
});

test("rename a board", async () => {
  const { status, body } = await api(`/api/boards/${boardId}`, { method: "PATCH", body: JSON.stringify({ title: "Duration hedging" }) });
  assert.equal(status, 200);
  assert.equal(body.board.title, "Duration hedging");
});

test("delete a board removes it from the list", async () => {
  const { status } = await api(`/api/boards/${boardId}`, { method: "DELETE" });
  assert.equal(status, 200);
  const { body } = await api("/api/boards");
  assert.ok(!body.boards.some((x: { id: string }) => x.id === boardId));
  const gone = await api(`/api/boards/${boardId}`);
  assert.equal(gone.status, 404);
});

test("a thread remembers its deck", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "deck binding" }) });
  const id = made.board.id;
  assert.equal(made.state.deck, null);
  const { status, body } = await api(`/api/boards/${id}`, { method: "PATCH", body: JSON.stringify({ deck: "aio-lecture-1" }) });
  assert.equal(status, 200);
  assert.equal(body.state.deck, "aio-lecture-1");
  const reopened = await api(`/api/boards/${id}`);
  assert.equal(reopened.body.deck, "aio-lecture-1");
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("every board has a home page — a running log that persists", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "with a log" }) });
  const id = made.board.id;
  assert.equal(made.state.notes, "");
  const text = "# Exam plan\n\n- **Lecture 4** is the weak spot\n";
  const r = await fetch(`${server.base}/api/boards/${id}/notes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  assert.equal(r.status, 200);
  const saved = await r.json();
  assert.ok(saved.rev > 0 && saved.notesRev > 0 && saved.notesRev <= saved.rev);
  const { body: reopened } = await api(`/api/boards/${id}`);
  assert.equal(reopened.notes, text);
  await api(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify({ label: "1 · intro" }) });
  const { body: still } = await api(`/api/boards/${id}`);
  assert.equal(still.notes, text);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});
