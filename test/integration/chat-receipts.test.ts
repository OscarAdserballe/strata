// STRATA_FAKE_MODEL_FAIL makes the fake model fail the first time a question contains that text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

const FAIL = "[fail-once]";
const server = useServer({ env: { STRATA_FAKE_MODEL: "1", STRATA_FAKE_MODEL_FAIL: FAIL } });

function rows(sql: string, ...args: (string | number)[]): Record<string, unknown>[] {
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  try { return db.prepare(sql).all(...args) as Record<string, unknown>[]; }
  finally { db.close(); }
}
const said = (board: string, text: string) => rows("SELECT idx, archived FROM messages WHERE board_id = ? AND role = 'user' AND text = ?", board, text);
const replies = (board: string) => rows("SELECT idx, text FROM messages WHERE board_id = ? AND role = 'assistant' AND idx > 0 ORDER BY idx", board);
const receipt = (key: string) => rows("SELECT state, status, body FROM request_receipts WHERE key = ?", key)[0];

let keys = 0;
const newKey = (): string => `chat-key-${process.pid}-${++keys}-${Date.now().toString(36)}`;

interface Frame { event: string; data: any }
async function ask(board: string, message: string, key?: string): Promise<{ status: number; frames: Frame[]; replay: boolean }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (key) headers["Idempotency-Key"] = key;
  const r = await server.fetch(`/api/boards/${board}/chat`, { method: "POST", headers, body: JSON.stringify({ message }) });
  const frames = (await r.text()).split("\n\n").map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return event && data ? { event, data: JSON.parse(data) } : null;
  }).filter((f): f is Frame => f !== null);
  return { status: r.status, frames, replay: r.headers.get("Idempotent-Replay") === "true" };
}
const named = (frames: Frame[], event: string) => frames.filter((f) => f.event === event);

test("the question is stored before the model is asked: a failed call no longer loses it", async () => {
  const board = await newBoard(server, { title: "failed turn" });
  const question = `What is DV01? ${FAIL} unkeyed`;
  const failed = await ask(board, question);
  assert.equal(failed.status, 200, "an SSE turn opens before the model answers");
  assert.equal(named(failed.frames, "error").length, 1);
  assert.match(named(failed.frames, "error")[0].data.error, /model failed/);
  assert.equal(named(failed.frames, "error")[0].data.resumable, undefined, "no key, nothing to resume under");
  const start = named(failed.frames, "start")[0].data;
  assert.equal(typeof start.userIdx, "number");
  assert.deepEqual(said(board, question).map((r) => r.idx), [start.userIdx], "the question is in the thread, once");
  assert.equal(replies(board).length, 0);

  const { body: state } = await server.api(`/api/boards/${board}`);
  assert.deepEqual(state.messages.filter((m: { role: string }) => m.role === "user").map((m: { text: string }) => m.text), [question]);
  const next = await ask(board, "And convexity?");
  const done = named(next.frames, "done")[0].data;
  assert.ok(done, "the next turn is answered");
  assert.doesNotMatch(named(next.frames, "delta").map((f) => f.data.t).join(""), /Earlier you asked/,
    "the fake model quotes the last question it was handed: there was none answered before");
  assert.deepEqual(done.state.messages.filter((m: { role: string }) => m.role === "user").map((m: { text: string }) => m.text), [question, "And convexity?"]);
});

test("open, model error, retry: the turn resumes at the model and the question is stored once", async () => {
  const board = await newBoard(server, { title: "resumed turn" });
  const key = newKey();
  const question = `Why does a DV01 hedge fail? ${FAIL} keyed`;
  const failed = await ask(board, question, key);
  assert.equal(named(failed.frames, "error").length, 1);
  assert.equal(named(failed.frames, "error")[0].data.resumable, true, "the client is told the same key resumes it");
  const { userIdx } = named(failed.frames, "start")[0].data;
  const open = receipt(key);
  assert.equal(open.state, "open", "phase 1 committed with its receipt; phase 2 never ran");
  assert.equal(open.status, 202);
  assert.deepEqual(JSON.parse(String(open.body)), { userIdx });

  const retried = await ask(board, question, key);
  assert.equal(retried.replay, false, "a resume is not a replay: the model is asked now");
  assert.equal(named(retried.frames, "start")[0].data.userIdx, userIdx, "the same question, not a new one");
  assert.ok(named(retried.frames, "delta").length > 1, "the reply streams");
  const done = named(retried.frames, "done")[0].data;
  assert.equal(done.userIdx, userIdx);
  assert.equal(said(board, question).length, 1, "the question was stored once");
  assert.deepEqual(replies(board).map((r) => r.idx), [done.replyIdx]);
  const closed = receipt(key);
  assert.equal(closed.state, "done");
  assert.equal(closed.status, 200);
  const replyId = rows("SELECT id FROM messages WHERE board_id = ? AND idx = ?", board, done.replyIdx)[0].id;
  assert.deepEqual(JSON.parse(String(closed.body)), { state: { $boardState: board, thread: null }, replyIdx: done.replyIdx, userIdx, replyId }, "the reply's row, which a replay reads");
});

test("a turn that was answered is answered again from what was stored: start, one delta, done", async () => {
  const board = await newBoard(server, { title: "replayed turn" });
  const key = newKey();
  const first = await ask(board, "What is a basis point?", key);
  const done = named(first.frames, "done")[0].data;
  const reply = named(first.frames, "delta").map((f) => f.data.t).join("");
  assert.equal(replies(board)[0].text, reply);

  const again = await ask(board, "What is a basis point?", key);
  assert.equal(again.replay, true);
  assert.deepEqual(again.frames.map((f) => f.event), ["start", "delta", "done"]);
  assert.deepEqual(again.frames[0].data, { userIdx: done.userIdx, replyIdx: done.replyIdx });
  assert.equal(again.frames[1].data.t, reply, "the stored reply, whole, as one delta");
  assert.equal(again.frames[2].data.replyIdx, done.replyIdx);
  assert.deepEqual(again.frames[2].data.state.messages.map((m: { idx: number }) => m.idx), done.state.messages.map((m: { idx: number }) => m.idx),
    "the board as it is now, which is the board the first answer left");
  assert.equal(said(board, "What is a basis point?").length, 1);
  assert.equal(replies(board).length, 1, "no second reply, no second model call");

  const json = await server.fetch(`/api/boards/${board}/chat`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ message: "What is a basis point?" }) });
  assert.equal(json.status, 200);
  assert.equal(json.headers.get("Idempotent-Replay"), "true");
  assert.equal((await json.json()).replyIdx, done.replyIdx);

  const other = await server.fetch(`/api/boards/${board}/chat`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ message: "Something else" }) });
  assert.equal(other.status, 422);
});

test("two sends of one turn under one key, together: the second waits for the first and replays it", async () => {
  const board = await newBoard(server, { title: "sent twice" });
  const key = newKey();
  const [a, b] = await Promise.all([ask(board, "What is key rate duration?", key), ask(board, "What is key rate duration?", key)]);
  assert.equal([a, b].filter((x) => x.replay).length, 1, "one is the turn, the other its replay");
  const [turn, replay] = a.replay ? [b, a] : [a, b];
  assert.deepEqual(replay.frames.map((f) => f.event), ["start", "delta", "done"]);
  assert.equal(replay.frames[1].data.t, named(turn.frames, "delta").map((f) => f.data.t).join(""));
  assert.equal(said(board, "What is key rate duration?").length, 1);
  assert.equal(replies(board).length, 1, "the model was asked once");
});

test("a thread cleared between the failed try and its retry ends the turn: refused once, stored never", async () => {
  const board = await newBoard(server, { title: "cleared turn" });
  const key = newKey();
  const question = `What moves the curve? ${FAIL} cleared`;
  assert.equal(named((await ask(board, question, key)).frames, "error").length, 1);
  assert.equal((await server.api(`/api/boards/${board}/messages`, { method: "DELETE" })).status, 200);
  const retried = await ask(board, question, key);
  assert.deepEqual(retried.frames.map((f) => f.event), ["error"]);
  assert.match(retried.frames[0].data.error, /Conversation changed/);
  assert.equal(replies(board).length, 0);
  assert.deepEqual(said(board, question).map((r) => r.archived), [1], "the question stays where the clear put it");
  assert.equal(receipt(key).status, 409, "the refusal is what the key answers from now on");
  const again = await ask(board, question, key);
  assert.equal(again.replay, true);
  assert.deepEqual(again.frames.map((f) => f.event), ["error"]);
});

test("the blocking turn stores its question first too, and answers as it always did", async () => {
  const board = await newBoard(server, { title: "blocking turn" });
  const failed = await server.api(`/api/boards/${board}/chat`, { method: "POST", body: JSON.stringify({ message: `Blocking ${FAIL}` }) });
  assert.equal(failed.status, 502);
  assert.equal(said(board, `Blocking ${FAIL}`).length, 1);
  const ok = await server.api(`/api/boards/${board}/chat`, { method: "POST", body: JSON.stringify({ message: "Blocking, answered" }) });
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.replyIdx, "number");
  assert.equal(ok.body.state.messages.at(-1).idx, ok.body.replyIdx);
  assert.equal(ok.body.state.messages.at(-2).idx, ok.body.userIdx);
  assert.equal(rows("SELECT count(*) AS n FROM request_receipts WHERE path = ?", `/api/boards/${board}/chat`)[0].n, 0, "no key, no receipt");
});

test("a retry whose idx now holds another row does not anchor to it: the turn is refused", async () => {
  const board = await newBoard(server, { title: "idx taken" });
  const key = newKey();
  const question = `What is carry? ${FAIL} idx taken`;
  const failed = await ask(board, question, key);
  const { userIdx } = named(failed.frames, "start")[0].data;
  const db = new DatabaseSync(server.db, { timeout: 5000 });
  try { db.prepare("UPDATE messages SET text = 'someone else' WHERE board_id = ? AND idx = ?").run(board, userIdx); }
  finally { db.close(); }
  const retried = await ask(board, question, key);
  assert.deepEqual(retried.frames.map((f) => f.event), ["error"]);
  assert.match(retried.frames[0].data.error, /Conversation changed/);
  assert.equal(replies(board).length, 0, "no reply stored under someone else's row");
  assert.equal(receipt(key).status, 409);
});

test("two questions on one thread at once are answered one at a time: Q1 A1 Q2 A2, never Q1 Q2 A1 A2", async () => {
  const board = await newBoard(server, { title: "one at a time" });
  const [a, b] = await Promise.all([ask(board, "What is a swap spread?"), ask(board, "And a basis swap?")]);
  assert.ok(named(a.frames, "done")[0] && named(b.frames, "done")[0], "both are answered");
  const thread = rows("SELECT role, text FROM messages WHERE board_id = ? AND idx > 0 AND archived = 0 ORDER BY idx", board);
  assert.deepEqual(thread.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  const first = named(a.frames, "done")[0].data.userIdx < named(b.frames, "done")[0].data.userIdx ? a : b;
  assert.equal(named(first.frames, "done")[0].data.replyIdx, named(first.frames, "done")[0].data.userIdx + 1, "each reply sits under its own question");
});

test("a replay streams this turn's own reply, even after its idx went to another turn", async () => {
  const board = await newBoard(server, { title: "idx reused" });
  const key = newKey();
  const first = await ask(board, "What does a DV01 hedge miss?", key);
  const { replyIdx } = named(first.frames, "done")[0].data;
  const answer = named(first.frames, "delta").map((f) => f.data.t).join("");
  // filing the source elsewhere, then another turn here, leaves this idx holding someone else's reply
  const db = new DatabaseSync(server.db, { timeout: 5000 });
  try {
    db.prepare("UPDATE messages SET board_id = 'filed-elsewhere' WHERE board_id = ? AND idx = ?").run(board, replyIdx);
    db.prepare("INSERT INTO messages (board_id, resource_id, role, text, calls, node_ids, idx, created_at) VALUES (?, NULL, 'assistant', 'Something entirely different about home', NULL, '[]', ?, 0)").run(board, replyIdx);
  } finally { db.close(); }
  const again = await ask(board, "What does a DV01 hedge miss?", key);
  assert.equal(again.replay, true);
  assert.equal(named(again.frames, "delta").map((f) => f.data.t).join(""), answer, "the reply it was given the first time");
});
