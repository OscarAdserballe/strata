// STRATA_DB is set before the imports because db.ts opens its file at import time.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STRATA_DB = join(tmpdir(), `strata-register-test-${process.pid}.db`);

const { db } = await import("../../platform/db/db.ts");
const { q } = await import("../repo.ts");
const { now, genId } = await import("../../platform/db/sql.ts");
const { registerOf } = await import("./register.ts");
const { INBOX_ID, INBOX_TYPE } = await import("../boards/unfiled.ts");

// Closed first: Windows will not delete a file a connection still holds.
after(() => { try { db.close(); rmSync(process.env.STRATA_DB as string, { force: true }); } catch { /* scratch */ } });

const ev = (event: string, props: unknown, ts: number) =>
  db.prepare("INSERT INTO events (ts, session, app, event, props) VALUES (?, ?, ?, ?, ?)")
    .run(ts, "test", "strata", event, JSON.stringify(props));

/** All tests share one database, so the fixed-id inbox is inserted only once. */
function ensureInbox(): void {
  if (!q.board.get(INBOX_ID)) { const t = now(); q.insBoard.run(INBOX_ID, "unfiled", INBOX_TYPE, t, t); }
}

function seedSource(boardTitle: string, boardType: string | null, filename: string, createdAt: number): { boardId: string; resourceId: string } {
  const boardId = genId("b-");
  q.insBoard.run(boardId, boardTitle, boardType, createdAt, createdAt);
  const resourceId = genId("r-");
  q.insResource.run(resourceId, boardId, filename, "application/pdf", "text", null, createdAt, "pdf", null, null);
  q.insPair.run(genId("p-"), boardId, filename, resourceId, null, 0, null);
  return { boardId, resourceId };
}

function seedDeck(boardId: string, resourceId: string, n: number): string {
  const slug = "src-" + genId();
  q.upsertCourse.run(slug, "test deck", null, now());
  for (let i = 0; i < n; i++) q.insCard.run(`${slug}/${i}`, slug, `${slug}/0-flashcard`, "flashcard", JSON.stringify({ front: "q", back: "a" }), i);
  db.prepare("UPDATE pairs SET deck = ? WHERE board_id = ? AND resource_id = ?").run(slug, boardId, resourceId);
  return slug;
}

test("a source with no reader activity at all reads as fresh", () => {
  const t = now();
  const { resourceId } = seedSource("board", null, "untouched.pdf", t);
  const e = registerOf().entries.find((x) => x.resourceId === resourceId);
  assert.equal(e?.status, "fresh");
  assert.equal(e?.waiting, true);
  assert.equal(e?.unfiled, false);
});

test("an open or a scroll, short of a distilled deck, reads as reading — never to-review", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("board", null, "opened.pdf", t);
  ev("resource_view", { board: boardId, resource: resourceId }, t + 1);
  ev("read_progress", { board: boardId, resource: resourceId, deepest: 97 }, t + 2);
  const e = registerOf().entries.find((x) => x.resourceId === resourceId);
  // pct >= 90 with no cards must not read "to review": there is nothing to review yet.
  assert.equal(e?.status, "reading");
  assert.equal(e?.readPct, 97);
});

test("seen through and benched, nothing kept, is the debt — to-review", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("board", null, "seen-through.pdf", t);
  const slug = seedDeck(boardId, resourceId, 3);
  for (let i = 0; i < 3; i++) ev("card_show", { board: boardId, card: `${slug}/${i}` }, t + i + 1);
  ev("bench_open", { board: boardId, deck: slug }, t + 10);
  const e = registerOf().entries.find((x) => x.resourceId === resourceId);
  assert.equal(e?.status, "to-review");
  assert.equal(e?.cards, 3);
  assert.equal(e?.kept, 0);
});

test("seen through but never benched is not the same as seen-through-and-declined", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("board", null, "never-benched.pdf", t);
  const slug = seedDeck(boardId, resourceId, 2);
  for (let i = 0; i < 2; i++) ev("card_show", { board: boardId, card: `${slug}/${i}` }, t + i + 1);
  const e = registerOf().entries.find((x) => x.resourceId === resourceId);
  assert.notEqual(e?.status, "to-review");
});

test("a kept card outranks to-review, and the register carries the count", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("board", null, "kept.pdf", t);
  const slug = seedDeck(boardId, resourceId, 4);
  for (let i = 0; i < 4; i++) ev("card_show", { board: boardId, card: `${slug}/${i}` }, t + i + 1);
  q.insKeep.run(`${slug}/0`, slug, `${slug}/0-flashcard`, t + 20);
  q.insKeep.run(`${slug}/1`, slug, `${slug}/0-flashcard`, t + 21);
  const e = registerOf().entries.find((x) => x.resourceId === resourceId);
  assert.equal(e?.status, "kept");
  assert.equal(e?.kept, 2);
  assert.equal(e?.waiting, false, "a source with a keep on it is not owed reading anymore");
});

test("a source still distilling says so, ahead of anything else", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("board", null, "mid-distil.pdf", t);
  db.prepare("INSERT INTO trees (section_id,resource_id,board_id,title,question,json,ascii,status,error,cards,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(genId("s-"), resourceId, boardId, "t", "", null, null, "running", null, 0, t);
  const e = registerOf().entries.find((x) => x.resourceId === resourceId);
  assert.equal(e?.status, "distilling");
});

test("a distil that died says failed, and stops saying distilling", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("board", null, "dead-distil.pdf", t);
  db.prepare("INSERT INTO trees (section_id,resource_id,board_id,title,question,json,ascii,status,error,cards,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(genId("s-"), resourceId, boardId, "t", "", null, null, "error", "model call failed", 0, t);
  const e = registerOf().entries.find((x) => x.resourceId === resourceId);
  assert.equal(e?.status, "failed");
});

test("said done by hand outranks every derived state, kept cards included", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("board", null, "done.pdf", t);
  const slug = seedDeck(boardId, resourceId, 1);
  q.insKeep.run(`${slug}/0`, slug, `${slug}/0-flashcard`, t + 1);
  db.prepare("UPDATE resources SET done_at = ? WHERE id = ?").run(t + 5, resourceId);
  const e = registerOf().entries.find((x) => x.resourceId === resourceId);
  assert.equal(e?.status, "done");
  assert.equal(e?.waiting, false);
});

test("the inbox board's own sources carry the unfiled bit; nothing else does", () => {
  const t = now();
  ensureInbox();
  const rid = genId("r-");
  q.insResource.run(rid, INBOX_ID, "loose.pdf", "application/pdf", "text", null, t, "pdf", null, null);
  q.insPair.run(genId("p-"), INBOX_ID, "loose.pdf", rid, null, 0, null);
  const { resourceId: filedRid } = seedSource("a real thread", null, "filed.pdf", t);

  const entries = registerOf().entries;
  assert.equal(entries.find((x) => x.resourceId === rid)?.unfiled, true);
  assert.equal(entries.find((x) => x.resourceId === filedRid)?.unfiled, false);
});

test("the ledger reads newest first, whatever order the rows were written in", () => {
  const t = now();
  seedSource("b2", null, "middle.pdf", t - 2000);
  seedSource("b3", null, "newest.pdf", t - 1000);
  seedSource("b1", null, "oldest.pdf", t - 3000);
  const mine = new Set(["oldest.pdf", "middle.pdf", "newest.pdf"]);
  const order = registerOf().entries.filter((e) => mine.has(e.filename)).map((e) => e.filename);
  assert.deepEqual(order, ["newest.pdf", "middle.pdf", "oldest.pdf"]);
});

test("finished work stays in the ledger — the page filters it, the route never hides it", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("board", null, "finished.pdf", t);
  const slug = seedDeck(boardId, resourceId, 1);
  q.insKeep.run(`${slug}/0`, slug, `${slug}/0-flashcard`, t + 1);
  const r = registerOf();
  const e = r.entries.find((x) => x.resourceId === resourceId);
  assert.equal(e?.waiting, false);
  assert.ok(e, "a source that has been gone through is still a row of the register");
  assert.ok(r.overview.sources > r.overview.waiting, "the room is bigger than its backlog");
});

test("the overview counts waiting and unfiled off the same rows the ledger shows", () => {
  ensureInbox();
  const before = registerOf();
  const t = now();
  const rid = genId("r-");
  q.insResource.run(rid, INBOX_ID, "fresh-unfiled.pdf", "application/pdf", "text", null, t, "pdf", null, null);
  q.insPair.run(genId("p-"), INBOX_ID, "fresh-unfiled.pdf", rid, null, 0, null);
  const after = registerOf();
  assert.equal(after.overview.sources, before.overview.sources + 1);
  assert.equal(after.overview.waiting, before.overview.waiting + 1);
  assert.equal(after.overview.unfiled, before.overview.unfiled + 1);
});

test("the register carries the last fortnight's keeps, dated and filed under their board", () => {
  const t = now();
  const { boardId, resourceId } = seedSource("charted", null, "charted.pdf", t);
  const slug = seedDeck(boardId, resourceId, 3);
  q.insKeep.run(`${slug}/0`, slug, `${slug}/0-flashcard`, t - 3600e3);
  q.insKeep.run(`${slug}/1`, slug, `${slug}/0-flashcard`, t - 2 * 864e5);
  q.insKeep.run(`${slug}/2`, slug, `${slug}/0-flashcard`, t - 20 * 864e5);
  const mine = registerOf().keptRecent.filter((k) => k.boardId === boardId);
  assert.equal(mine.length, 2);
  assert.deepEqual(mine.map((k) => k.at), [t - 2 * 864e5, t - 3600e3], "oldest first");
});
