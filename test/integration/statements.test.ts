import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_DIR, useServer } from "../support/server.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const preload = pathToFileURL(join(APP_DIR, "test", "support", "count-runs.mjs")).href;
const server = useServer({ env: { NODE_OPTIONS: `--import=${preload}` } });

const settle = () => new Promise((r) => setTimeout(r, 150));
/** statements run while `fn` made its request, minus what every request pays (rev header, logs, probe) */
const EVERY_REQUEST = /^(SELECT rev FROM room_rev |INSERT INTO request_log |INSERT INTO events |SELECT watermark,latest,reset FROM activity_meta )/;
async function ran(fn: () => Promise<unknown>): Promise<string[]> {
  await settle();
  const from = server.written();
  await fn();
  await settle();
  return server.output(from).split("\n").filter((l) => l.startsWith("[run] ")).map((l) => l.slice("[run] ".length))
    .filter((sql) => !EVERY_REQUEST.test(sql));
}
const get = async (path: string, init?: RequestInit) => {
  const r = await server.fetch(path, init);
  await r.arrayBuffer();
  assert.ok(r.status < 400, `${path} answered ${r.status}`);
  return r;
};
const BYTES = /resource_blobs/;
const tally = (sqls: string[]) => sqls.reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map<string, number>());

let first = "";
const boards: string[] = [];
async function board(title: string, deck?: string): Promise<string> {
  const b = await newBoard(server, { title });
  const rid = await addMarkdown(server, b, `${title}.md`, MD);
  if (deck) {
    const p = await server.api(`/api/boards/${b}/pairs`, { method: "POST", body: JSON.stringify({ label: title, resourceId: rid, deck }) });
    assert.ok(p.status < 300, JSON.stringify(p.body));
  }
  boards.push(b);
  return b;
}

test("the register asks the same eleven queries, each once, with one board or four, and never the bytes", async () => {
  first = await board("one", "aio-lecture-4");
  const one = await ran(() => get("/api/register"));
  for (const t of ["two", "three", "four"]) await board(t, "aio-lecture-4");
  const four = await ran(() => get("/api/register"));

  assert.deepEqual([...tally(four)].filter(([, n]) => n > 1), [], "a statement ran more than once in one register");
  assert.equal(four.length, 11, `register.ts says eleven queries; it ran:\n${four.join("\n")}`);
  assert.deepEqual(tally(four), tally(one), "the register asked more of the database with more boards: it loops over them");
  assert.deepEqual(four.filter((s) => BYTES.test(s)), [], "the register read a source's bytes");
});

test("the register finds the fortnight's keeps through the date index, not by scanning card_keeps", async () => {
  const sql = (await ran(() => get("/api/register"))).find((s) => /FROM card_keeps WHERE created_at >= \?/.test(s));
  assert.ok(sql, "the register reads the fortnight's keeps");
  const db = new DatabaseSync(server.db, { readOnly: true });
  try {
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0) as { detail: string }[]).map((r) => r.detail);
    assert.ok(plan.some((d) => /^SEARCH card_keeps USING COVERING INDEX idx_card_keeps_created \(created_at>\?\)$/.test(d)),
      `the keeps are found by date through idx_card_keeps_created (platform/db/schema.ts):\n${plan.join("\n")}`);
    assert.deepEqual(plan.filter((d) => /SCAN card_keeps|TEMP B-TREE/.test(d)), [], "card_keeps was scanned or sorted");
  } finally { db.close(); }
});

test("the boards list asks where you left off of the front board only, and never the bytes", async () => {
  assert.ok(boards.length >= 4, "the register's boards are here");
  const sqls = await ran(() => get("/api/boards"));
  assert.equal(sqls.filter((s) => /FROM activity_read WHERE board=\? ORDER BY last_id DESC LIMIT 1/.test(s)).length, 1,
    `where you left off was asked once per board, not of the front board alone:\n${sqls.join("\n")}`);
  assert.deepEqual(sqls.filter((s) => BYTES.test(s)), [], "the boards list read a source's bytes");
});

test("the collection pays for the log-derived facts once, however many boards it walks", async () => {
  const sqls = await ran(() => get("/api/collection"));
  assert.ok(sqls.filter((s) => /FROM pairs WHERE board_id = \?/.test(s)).length >= 4, "it walked the boards");
  assert.equal(sqls.filter((s) => s === "SELECT deck FROM activity_bench").length, 1, "the bench's decks were asked per board");
  assert.equal(sqls.filter((s) => /FROM events WHERE event = 'card_keep'/.test(s)).length, 1, "the last keeps were asked per board");
});

test("a PDF's bytes are read from the database once; a reopen, a range and a 304 read none", async () => {
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  const made = await server.api(`/api/boards/${first}/resources`, { method: "POST",
    body: JSON.stringify({ filename: "kept.pdf", base64: bytes.toString("base64") }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const raw = `/api/boards/${first}/resources/${made.body.id}/raw`;

  let tag = "";
  const opened = await ran(async () => { tag = (await get(raw)).headers.get("etag") ?? ""; });
  assert.equal(opened.filter((s) => BYTES.test(s)).length, 1, `the first open reads the blob once:\n${opened.join("\n")}`);
  await settle();                       // the file is written beside the database, unawaited
  const again = await ran(() => get(raw));
  assert.deepEqual(again.filter((s) => BYTES.test(s)), [], "the reopen read the blob, not the file kept beside the database");
  const range = await ran(async () => {
    const r = await get(raw, { headers: { Range: "bytes=1000-1999" } });
    assert.equal(r.status, 206);
  });
  assert.deepEqual(range.filter((s) => BYTES.test(s)), [], "a range read the blob, not the file");
  assert.ok(tag, "the answer carries an etag");
  const unchanged = await ran(async () => {
    const r = await server.fetch(raw, { headers: { "If-None-Match": tag } });
    await r.arrayBuffer();
    assert.equal(r.status, 304);
  });
  assert.deepEqual(unchanged.filter((s) => BYTES.test(s)), [], "a 304 read the blob to decide not to send it");
});

test("the board's snapshot and the room's hot reads never touch a source's bytes or page text", async () => {
  const b = first;
  const { body: state } = await server.api(`/api/boards/${b}`);
  const rid = state.resources[0].id as string;
  const sqls = await ran(async () => {
    for (const path of [`/api/boards/${b}`, `/api/boards/${b}/status`, `/api/boards/${b}/touched`, `/api/boards/${b}/seen`,
      `/api/boards/${b}/messages`, `/api/boards/${b}/resources/${rid}/tree`, "/api/boards", "/api/register", "/api/library",
      "/api/decks", "/api/review", "/api/collection", `/api/boards/${b}/collection`]) await get(path);
  });
  assert.ok(sqls.length > 20, "the reads ran");
  assert.deepEqual(sqls.filter((s) => BYTES.test(s) || /\bpage_text\b/.test(s)), [], "a hot read touched resource_blobs");
});
