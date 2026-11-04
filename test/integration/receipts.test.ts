import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startServer, useServer } from "../support/server.ts";
import { ensureReceipts } from "../../server/platform/db/receipts.ts";
import type { Ctx } from "../../server/platform/router/router.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const server = useServer();

const room = (): DatabaseSync => new DatabaseSync(server.db, { timeout: 5000 });
function count(sql: string, ...args: string[]): number {
  const db = room();
  try { return Number((db.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...args) as { n: number }).n); }
  finally { db.close(); }
}

let keys = 0;
const newKey = (): string => `test-key-${process.pid}-${++keys}-${Date.now().toString(36)}`;

interface Answer { status: number; body: any; replay: boolean; rev: string | null }
async function send(method: string, path: string, body: unknown, key?: string): Promise<Answer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== undefined) headers["Idempotency-Key"] = key;
  const r = await server.fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json(), replay: r.headers.get("Idempotent-Replay") === "true", rev: r.headers.get("X-Strata-Rev") };
}

async function sourced(title: string): Promise<{ board: string; rid: string }> {
  const board = await newBoard(server, { title });
  return { board, rid: await addMarkdown(server, board, "hedging.md", MD) };
}
const marksOn = (board: string): number => count("marks WHERE board_id = ?", board);

// the type is the first guard: a block that awaits cannot be handed to commit
// @ts-expect-error a commit cannot await
export const _awaits = (ctx: Ctx) => ctx.commit(async () => ({ status: 200, body: {} }));

test("a write sent again under its key is replayed: same status, same body, written once", async () => {
  const { board, rid } = await sourced("replayed");
  const key = newKey();
  const mark = { resourceId: rid, start: 2, end: 10, quote: "Duration" };
  const first = await send("POST", `/api/boards/${board}/marks`, mark, key);
  assert.equal(first.status, 201);
  assert.equal(first.replay, false, "the first answer is the real one");
  const again = await send("POST", `/api/boards/${board}/marks`, mark, key);
  assert.equal(again.status, 201);
  assert.equal(again.replay, true);
  assert.deepEqual(again.body, first.body);
  assert.equal(marksOn(board), 1, "the handler ran once");

  const db = room();
  try {
    const r = db.prepare("SELECT method, path, body_hash, state, status, body, rev FROM request_receipts WHERE key = ?").get(key) as Record<string, unknown>;
    assert.equal(r.method, "POST");
    assert.equal(r.path, `/api/boards/${board}/marks`);
    assert.match(String(r.body_hash), /^[0-9a-f]{64}$/);
    assert.equal(r.state, "done");
    assert.equal(r.status, 201);
    assert.deepEqual(JSON.parse(String(r.body)), first.body);
    assert.equal(String(r.rev), first.rev, "rev is room_rev after the commit");
  } finally { db.close(); }

  const noteKey = newKey(), dropKey = newKey();
  const said = await send("PATCH", `/api/boards/${board}/marks/${first.body.id}`, { note: "the point" }, noteKey);
  assert.equal(said.status, 200);
  const saidAgain = await send("PATCH", `/api/boards/${board}/marks/${first.body.id}`, { note: "the point" }, noteKey);
  assert.equal(saidAgain.replay, true);
  assert.deepEqual(saidAgain.body, said.body);
  const gone = await send("DELETE", `/api/boards/${board}/marks/${first.body.id}`, undefined, dropKey);
  assert.equal(gone.status, 200);
  const goneAgain = await send("DELETE", `/api/boards/${board}/marks/${first.body.id}`, undefined, dropKey);
  assert.equal(goneAgain.status, 200);
  assert.equal(goneAgain.replay, true);
  assert.deepEqual(goneAgain.body, gone.body);
  assert.equal((await send("DELETE", `/api/boards/${board}/marks/${first.body.id}`, undefined)).status, 404);
});

test("a key reused for a different body, path or method is refused with 422 and writes nothing", async () => {
  const { board, rid } = await sourced("reused key");
  const other = await sourced("another board");
  const key = newKey();
  const mark = { resourceId: rid, start: 2, end: 10, quote: "Duration" };
  const first = await send("POST", `/api/boards/${board}/marks`, mark, key);
  assert.equal(first.status, 201);

  const body = await send("POST", `/api/boards/${board}/marks`, { ...mark, quote: "hedging" }, key);
  assert.equal(body.status, 422);
  assert.match(body.body.error, /already used for a different request/);
  const path = await send("POST", `/api/boards/${other.board}/marks`, { ...mark, resourceId: other.rid }, key);
  assert.equal(path.status, 422);
  const method = await send("PATCH", `/api/boards/${board}/marks/${first.body.id}`, { note: "x" }, key);
  assert.equal(method.status, 422);

  assert.equal(marksOn(board), 1);
  assert.equal(marksOn(other.board), 0);
  const db = room();
  try { assert.equal((db.prepare("SELECT note FROM marks WHERE id = ?").get(first.body.id) as { note: string | null }).note, null); }
  finally { db.close(); }
});

// A converted route commits synchronously, so the second request finds the first's receipt, not a run.
test("two requests sent together under one key make one mark and one receipt", async () => {
  const { board, rid } = await sourced("raced");
  const key = newKey();
  const mark = { resourceId: rid, start: 2, end: 10, quote: "Duration" };
  const [a, b] = await Promise.all([
    send("POST", `/api/boards/${board}/marks`, mark, key),
    send("POST", `/api/boards/${board}/marks`, mark, key),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual(a.body, b.body);
  assert.equal([a, b].filter((x) => x.replay).length, 1, "one answer is the write, the other its replay");
  assert.equal(marksOn(board), 1);
  assert.equal(count("request_receipts WHERE key = ?", key), 1);
});

test("the running log's save replays its revisions rather than writing again", async () => {
  const board = await newBoard(server, { title: "notes" });
  const key = newKey();
  const first = await send("PUT", `/api/boards/${board}/notes`, { text: "day one" }, key);
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ["notesRev", "rev"]);
  const again = await send("PUT", `/api/boards/${board}/notes`, { text: "day one" }, key);
  assert.equal(again.replay, true);
  assert.deepEqual(again.body, first.body);
  assert.equal(count("events WHERE event = 'notes_write' AND json_extract(props, '$.board') = ?", board), 1, "one save, one event");
});

test("a plan write replays: a retried add makes one group, a retried move swaps once", async () => {
  const board = await newBoard(server, { title: "plan" });
  const plan = `/api/boards/${board}/plan`;
  const addKey = newKey();
  const added = await send("POST", `${plan}/groups`, { name: "week 1" }, addKey);
  assert.equal(added.status, 201);
  const addedAgain = await send("POST", `${plan}/groups`, { name: "week 1" }, addKey);
  assert.equal(addedAgain.status, 201);
  assert.equal(addedAgain.replay, true);
  assert.deepEqual(addedAgain.body, added.body);
  assert.equal(count("board_groups WHERE board_id = ?", board), 1);

  const a = await send("POST", `${plan}/milestones`, { name: "first" });
  const b = await send("POST", `${plan}/milestones`, { name: "second" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const moveKey = newKey();
  const moved = await send("PATCH", `${plan}/milestones/${b.body.id}`, { move: -1 }, moveKey);
  assert.deepEqual(moved.body.plan.milestones.map((m: { name: string }) => m.name), ["second", "first"]);
  // without a key this retry would swap them back
  const movedAgain = await send("PATCH", `${plan}/milestones/${b.body.id}`, { move: -1 }, moveKey);
  assert.equal(movedAgain.replay, true);
  assert.deepEqual(movedAgain.body, moved.body);
  const { body: now } = await server.api(`/api/boards/${board}`);
  assert.deepEqual(now.plan.milestones.map((m: { name: string }) => m.name), ["second", "first"]);
});

test("an authored card replays with the board as it is now; its snapshot is stored as a reference", async () => {
  const board = await newBoard(server, { title: "authored" });
  const key = newKey();
  const card = { front: "Why hedge convexity?", variant: "bare" };
  const first = await send("POST", `/api/boards/${board}/minted`, card, key);
  assert.equal(first.status, 201);
  assert.equal(first.body.state.board.id, board, "the answer carries the whole board, as before");
  assert.deepEqual(first.body.state.minted.map((m: { id: string }) => m.id), [first.body.id]);

  const db = room();
  try {
    const stored = JSON.parse(String((db.prepare("SELECT body FROM request_receipts WHERE key = ?").get(key) as { body: string }).body));
    assert.deepEqual(stored, { id: first.body.id, state: { $boardState: board, thread: null } });
  } finally { db.close(); }

  const other = await send("POST", `/api/boards/${board}/minted`, { front: "What is DV01?", variant: "bare" });
  assert.equal(other.status, 201);
  const again = await send("POST", `/api/boards/${board}/minted`, card, key);
  assert.equal(again.status, 201);
  assert.equal(again.replay, true);
  assert.equal(again.body.id, first.body.id);
  assert.deepEqual(again.body.state.minted.map((m: { id: string }) => m.id).sort(), [first.body.id, other.body.id].sort());
  assert.equal(count("minted WHERE board_id = ? AND front = ?", board, card.front), 1);

  // a new key with the same front is a deliberate re-ask, and so is a request with none
  const reasked = await send("POST", `/api/boards/${board}/minted`, card, newKey());
  assert.equal(reasked.status, 201);
  assert.notEqual(reasked.body.id, first.body.id);
  const unkeyed = await send("POST", `/api/boards/${board}/minted`, card);
  assert.equal(unkeyed.status, 201);
  assert.equal(count("minted WHERE board_id = ? AND front = ?", board, card.front), 3);
});

test("a keep and an unkeep replay rather than failing the second time", async () => {
  const slug = "aio-lecture-5";
  const { body: dk } = await server.api(`/api/decks/${slug}`);
  const id = dk.cards[0].id;
  const addKey = newKey();
  const kept = await send("POST", `/api/decks/${slug}/keeps`, { add: [id] }, addKey);
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.body.ids, [id]);
  const keptAgain = await send("POST", `/api/decks/${slug}/keeps`, { add: [id] }, addKey);
  assert.equal(keptAgain.replay, true);
  assert.deepEqual(keptAgain.body, kept.body);

  const dropKey = newKey();
  const dropped = await send("POST", `/api/decks/${slug}/keeps`, { remove: [id] }, dropKey);
  assert.equal(dropped.status, 200);
  assert.deepEqual(dropped.body.ids, []);
  const droppedAgain = await send("POST", `/api/decks/${slug}/keeps`, { remove: [id] }, dropKey);
  assert.equal(droppedAgain.status, 200);
  assert.equal(droppedAgain.replay, true);
  assert.deepEqual(droppedAgain.body, dropped.body);
  assert.equal((await send("POST", `/api/decks/${slug}/keeps`, { remove: [id] })).status, 400);
  assert.equal(count("card_keeps WHERE course = ?", slug), 0);
});

test("a move, a delete, a clear or a note sent again under its key answers what the first did, once", async () => {
  const { board, rid } = await sourced("retried");
  const elsewhere = await newBoard(server, { title: "elsewhere" });
  const pair = await send("POST", `/api/boards/${board}/pairs`, { label: "a deck-only pair" }, newKey());
  assert.equal(pair.status, 201);
  const moveKey = newKey();
  const moved = await send("POST", `/api/boards/${board}/pairs/${pair.body.id}/move`, { to: elsewhere }, moveKey);
  assert.equal(moved.status, 200);
  const movedAgain = await send("POST", `/api/boards/${board}/pairs/${pair.body.id}/move`, { to: elsewhere }, moveKey);
  assert.equal(movedAgain.status, 200);
  assert.equal(movedAgain.replay, true);
  assert.deepEqual(movedAgain.body.destState.pairs.map((p: { id: string }) => p.id), [pair.body.id]);
  assert.equal((await send("POST", `/api/boards/${board}/pairs/${pair.body.id}/move`, { to: elsewhere })).status, 404, "without the key, the pair is not here any more");

  const clearKey = newKey();
  for (let i = 0; i < 2; i++) assert.equal((await send("DELETE", `/api/boards/${board}/messages`, undefined, clearKey)).status, 200);
  assert.equal(count("events WHERE event = 'chat_clear' AND json_extract(props, '$.board') = ?", board), 1, "cleared once");
  assert.equal(count("thread_revisions WHERE board = ? AND revision = 1", board), 1, "the thread's revision moved once");

  const noteKey = newKey();
  const note = { kind: "general", comment: `replayed note ${noteKey}` };
  const said = await send("POST", "/api/feedback", note, noteKey);
  const saidAgain = await send("POST", "/api/feedback", note, noteKey);
  assert.equal(saidAgain.replay, true);
  assert.equal(saidAgain.body.id, said.body.id);
  assert.equal(count("feedback WHERE comment = ?", note.comment), 1);

  const dropKey = newKey();
  assert.equal((await send("DELETE", `/api/boards/${board}/resources/${rid}`, undefined, dropKey)).status, 200);
  const droppedAgain = await send("DELETE", `/api/boards/${board}/resources/${rid}`, undefined, dropKey);
  assert.equal(droppedAgain.status, 200);
  assert.equal(droppedAgain.replay, true);
  assert.deepEqual(droppedAgain.body.state.resources, []);

  const goneKey = newKey();
  assert.deepEqual((await send("DELETE", `/api/boards/${board}`, undefined, goneKey)).body, { ok: true });
  const goneAgain = await send("DELETE", `/api/boards/${board}`, undefined, goneKey);
  assert.equal(goneAgain.replay, true);
  assert.deepEqual(goneAgain.body, { ok: true });
  assert.equal(count("events WHERE event = 'board_delete' AND json_extract(props, '$.id') = ?", board), 1);
});

const sourcesOn = (board: string): number => count("resources WHERE board_id = ?", board);
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nDuration is the first-order measure.\n\n00:00:05.000 --> 00:00:09.000\nConvexity is the second.\n";

test("a dropped source sent again under its key is one source, and its answer replays", async () => {
  const board = await newBoard(server, { title: "dropped twice" });
  const key = newKey();
  const file = { filename: "hedging.md", base64: Buffer.from(MD, "utf-8").toString("base64"), pair: true };
  const first = await send("POST", `/api/boards/${board}/resources`, file, key);
  assert.equal(first.status, 201);
  assert.equal(first.replay, false);
  assert.equal(first.body.state.board.id, board, "the answer still carries the board");
  const again = await send("POST", `/api/boards/${board}/resources`, file, key);
  assert.equal(again.status, 201);
  assert.equal(again.replay, true);
  assert.equal(again.body.id, first.body.id);
  assert.deepEqual(again.body.state.resources.map((r: { id: string }) => r.id), [first.body.id]);
  assert.equal(sourcesOn(board), 1, "the token count and the write ran once");
  assert.equal(count("pairs WHERE board_id = ?", board), 1);
  assert.equal(count("events WHERE event = 'resource_add' AND json_extract(props, '$.board') = ?", board), 1);
});

test("a transcript capture whose answer was lost is replayed, not added a second time", async () => {
  const board = await newBoard(server, { title: "captured twice" });
  const key = newKey();
  const finish = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Hedging, live", vtt: VTT };
  const first = await send("POST", `/api/boards/${board}/capture/finish`, finish, key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.kind, "transcript");
  const again = await send("POST", `/api/boards/${board}/capture/finish`, finish, key);
  assert.equal(again.replay, true);
  assert.deepEqual([again.body.resourceId, again.body.pairId], [first.body.resourceId, first.body.pairId]);
  assert.equal(sourcesOn(board), 1);
  assert.equal(count("pairs WHERE board_id = ?", board), 1, "the source and its pair, once");
  assert.equal(count("events WHERE event = 'capture_done' AND json_extract(props, '$.board') = ?", board), 1);

  const db = room();
  const failKey = newKey();
  try {
    db.exec(`CREATE TRIGGER capture_receipt_fail BEFORE INSERT ON request_receipts WHEN NEW.key = '${failKey}'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    assert.equal((await send("POST", `/api/boards/${board}/capture/finish`, finish, failKey)).status, 500);
    assert.equal(sourcesOn(board), 1, "no half-captured source");
    assert.equal(count("pairs WHERE board_id = ?", board), 1);
  } finally { db.exec("DROP TRIGGER IF EXISTS capture_receipt_fail"); db.close(); }

  assert.equal((await send("POST", `/api/boards/${board}/capture/finish`, finish)).status, 201);
  assert.equal(sourcesOn(board), 2);
});

test("a commit that throws stores no receipt and no rows, and the retry runs afresh", async () => {
  const { board, rid } = await sourced("thrown");
  const key = newKey();
  const mark = { resourceId: rid, start: 2, end: 10, quote: "Duration" };
  const db = room();
  try {
    // the receipt is the LAST statement of the commit: refusing it must take the mark with it
    db.exec(`CREATE TRIGGER receipt_fail BEFORE INSERT ON request_receipts WHEN NEW.key = '${key}'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const failed = await send("POST", `/api/boards/${board}/marks`, mark, key);
    assert.equal(failed.status, 500);
    assert.match(failed.body.error, /injected failure/);
    assert.equal(marksOn(board), 0, "the mark was rolled back with its receipt");
    assert.equal(count("request_receipts WHERE key = ?", key), 0);
    assert.equal(count("events WHERE event = 'mark_add' AND json_extract(props, '$.board') = ?", board), 0, "and its event");

    db.exec("DROP TRIGGER receipt_fail");
    db.exec(`CREATE TRIGGER mark_fail BEFORE INSERT ON marks WHEN NEW.board_id = '${board}'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    assert.equal((await send("POST", `/api/boards/${board}/marks`, mark, key)).status, 500);
    assert.equal(count("request_receipts WHERE key = ?", key), 0);
    db.exec("DROP TRIGGER mark_fail");

    const retried = await send("POST", `/api/boards/${board}/marks`, mark, key);
    assert.equal(retried.status, 201);
    assert.equal(retried.replay, false);
    assert.equal(marksOn(board), 1);
    assert.equal(count("request_receipts WHERE key = ?", key), 1);
  } finally { db.close(); }
});

test("a refusal before the commit stores nothing: the same key is judged afresh", async () => {
  const { board, rid } = await sourced("refused first");
  const key = newKey();
  const empty = await send("POST", `/api/boards/${board}/marks`, { resourceId: rid, quote: "   " }, key);
  assert.equal(empty.status, 400);
  assert.equal(count("request_receipts WHERE key = ?", key), 0);
  const made = await send("POST", `/api/boards/${board}/marks`, { resourceId: rid, start: 2, end: 10, quote: "Duration" }, key);
  assert.equal(made.status, 201);
  assert.equal(marksOn(board), 1);
});

test("a key that is not 8 to 80 letters, digits and dashes is a 400, and nothing is written", async () => {
  const { board, rid } = await sourced("bad key");
  const mark = { resourceId: rid, start: 2, end: 10, quote: "Duration" };
  for (const key of ["short", "has space in it", "under_score_key", "x".repeat(81)]) {
    const r = await send("POST", `/api/boards/${board}/marks`, mark, key);
    assert.equal(r.status, 400, key);
    assert.match(r.body.error, /Idempotency-Key/);
  }
  assert.equal(marksOn(board), 0);
});

test("a request without a key is answered as it always was, and leaves no receipt", async () => {
  const { board, rid } = await sourced("unkeyed");
  const before = count("request_receipts");
  const mark = { resourceId: rid, start: 2, end: 10, quote: "Duration" };
  const a = await send("POST", `/api/boards/${board}/marks`, mark);
  const b = await send("POST", `/api/boards/${board}/marks`, mark);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.replay || b.replay, false);
  assert.notEqual(a.body.id, b.body.id, "two requests, two marks: no key, no dedupe");
  assert.deepEqual(Object.keys(a.body).sort(), ["id", "mark", "rev"]);
  assert.equal(marksOn(board), 2);
  assert.equal(count("request_receipts"), before);
});

test("receipts older than a week are pruned by the housekeeping, newer ones kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-receipts-"));
  const file = join(dir, "strata.db");
  try {
    const seed = new DatabaseSync(file);
    ensureReceipts(seed);
    const put = seed.prepare("INSERT INTO request_receipts (key, method, path, body_hash, status, body, rev, created_at) VALUES (?, 'POST', '/api/x', '', 200, '{}', 0, ?)");
    put.run("receipt-old-0001", Date.now() - 8 * 864e5);
    put.run("receipt-new-0001", Date.now() - 6 * 864e5);
    seed.close();
    const server = await startServer({ db: file });
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const keys = (db.prepare("SELECT key FROM request_receipts ORDER BY key").all() as { key: string }[]).map((r) => r.key);
        assert.deepEqual(keys, ["receipt-new-0001"]);
      } finally { db.close(); }
    } finally { await server.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
