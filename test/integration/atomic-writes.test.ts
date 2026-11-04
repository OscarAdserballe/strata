// Each test makes the last table a handler writes refuse, then checks every earlier write rolled back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";
import { MD, addMarkdown, newBoard } from "./seed.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

function room(): DatabaseSync {
  return new DatabaseSync(server.db, { timeout: 5000 });
}
const count = (db: DatabaseSync, sql: string, ...args: string[]): number =>
  Number((db.prepare(`SELECT count(*) AS n FROM ${sql}`).get(...args) as { n: number }).n);

async function furnished(title: string): Promise<{ board: string; rid: string }> {
  const board = await newBoard(server, { title });
  const rid = await addMarkdown(server, board, "hedging.md", MD);
  const pair = await api(`/api/boards/${board}/pairs`, { method: "POST", body: JSON.stringify({ label: "hedging", resourceId: rid }) });
  assert.equal(pair.status, 201);
  const mark = await api(`/api/boards/${board}/marks`, { method: "POST", body: JSON.stringify({ resourceId: rid, start: 2, end: 10, quote: "Duration" }) });
  assert.equal(mark.status, 201);
  const group = await api(`/api/boards/${board}/plan/groups`, { method: "POST", body: JSON.stringify({ name: "week 1" }) });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  return { board, rid };
}

function rowsOf(db: DatabaseSync, board: string, rid: string) {
  return {
    board: count(db, "boards WHERE id = ?", board),
    messages: count(db, "messages WHERE board_id = ?", board),
    resources: count(db, "resources WHERE id = ?", rid),
    blobs: count(db, "resource_blobs WHERE resource_id = ?", rid),
    sections: count(db, "sections WHERE resource_id = ?", rid),
    trees: count(db, "trees WHERE resource_id = ?", rid),
    pairs: count(db, "pairs WHERE board_id = ?", board),
    marks: count(db, "marks WHERE resource_id = ?", rid),
    groups: count(db, "board_groups WHERE board_id = ?", board),
  };
}

test("a board delete that fails at its last statement leaves the whole board in place", async () => {
  const { board, rid } = await furnished("delete me, but not halfway");
  const db = room();
  try {
    const before = rowsOf(db, board, rid);
    for (const [table, n] of Object.entries(before)) if (table !== "blobs") assert.ok(n > 0, `the fixture has ${table}`);
    // the board row is the last of the board's own rows to go
    db.exec(`CREATE TRIGGER atomic_board_fail BEFORE DELETE ON boards WHEN OLD.id = '${board}'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const failed = await api(`/api/boards/${board}`, { method: "DELETE" });
    assert.equal(failed.status, 500);
    assert.match(failed.body.error, /injected failure/);
    assert.deepEqual(rowsOf(db, board, rid), before, "every statement before the failure was rolled back");
    const { status, body } = await api(`/api/boards/${board}`);
    assert.equal(status, 200);
    assert.equal(body.resources.length, 1);

    db.exec("DROP TRIGGER atomic_board_fail");
    assert.equal((await api(`/api/boards/${board}`, { method: "DELETE" })).status, 200);
    for (const [table, n] of Object.entries(rowsOf(db, board, rid))) assert.equal(n, 0, `${table} went with the board`);
  } finally { db.close(); }
});

test("a source delete that fails at its last statement leaves the source, its sections and its marks", async () => {
  const { board, rid } = await furnished("a source that stays whole");
  const db = room();
  try {
    const before = rowsOf(db, board, rid);
    // the marks are the last thing a source delete takes
    db.exec(`CREATE TRIGGER atomic_source_fail BEFORE DELETE ON marks WHEN OLD.resource_id = '${rid}'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const failed = await api(`/api/boards/${board}/resources/${rid}?pairs=1`, { method: "DELETE" });
    assert.equal(failed.status, 500);
    assert.deepEqual(rowsOf(db, board, rid), before, "the source, its blob, sections, tree, pair and marks are all still there");
    const raw = await server.fetch(`/api/boards/${board}/resources/${rid}/raw`);
    assert.equal(raw.status, 200, "and it still opens");
    await raw.arrayBuffer();

    db.exec("DROP TRIGGER atomic_source_fail");
    assert.equal((await api(`/api/boards/${board}/resources/${rid}?pairs=1`, { method: "DELETE" })).status, 200);
    const after = rowsOf(db, board, rid);
    assert.deepEqual({ ...after, board: 0, messages: 0, groups: 0 },
      { board: 0, messages: 0, resources: 0, blobs: 0, sections: 0, trees: 0, pairs: 0, marks: 0, groups: 0 });
    assert.equal(after.board, 1, "the board itself stays");
  } finally { db.close(); }
});

test("a tree put whose tree write fails keeps the deck it had, not half of the new one", async () => {
  const board = await newBoard(server, { title: "a deck rebuilt whole" });
  const rid = await addMarkdown(server, board, "hedging.md", MD);
  const tree = { title: "Hedging", question: "?", nodes: [{ label: "convexity", kind: "concept", anchor: "#duration-hedging" }] };
  const card = (front: string) => ({ node: "n1", type: "flashcard", source: "#duration-hedging", front, back: "a." });
  const first = await api(`/api/boards/${board}/resources/${rid}/tree`, { method: "PUT", body: JSON.stringify({ tree, cards: [card("one?"), card("two?")] }) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.cards, 2);
  const db = room();
  try {
    const sid = String((db.prepare("SELECT id FROM sections WHERE resource_id = ?").get(rid) as { id: string }).id);
    const slug = "src-" + sid.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const fronts = () => db.prepare("SELECT payload FROM cards WHERE course = ? ORDER BY ord").all(slug).map((r) => JSON.parse(String(r.payload)).front);
    assert.deepEqual(fronts(), ["one?", "two?"]);
    // installDeck deletes and rewrites the deck first; the tree's own row is written last
    db.exec(`CREATE TRIGGER atomic_tree_fail BEFORE UPDATE ON trees WHEN OLD.section_id = '${sid}'
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    const failed = await api(`/api/boards/${board}/resources/${rid}/tree`, { method: "PUT", body: JSON.stringify({ tree, cards: [card("three?")] }) });
    assert.equal(failed.status, 500);
    assert.deepEqual(fronts(), ["one?", "two?"], "the old deck survives the failed rebuild");
    db.exec("DROP TRIGGER atomic_tree_fail");
  } finally { db.close(); }
});
