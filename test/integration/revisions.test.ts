import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useServer, type TestServer } from "../support/server.ts";
import { newBoard, addMarkdown, MD } from "./seed.ts";
import {
  NOT_REVISIONED, REVISIONED, ROOM_ONLY, STAMP_COLUMNS, TRIGGER_PREFIX, ensureRevisionTriggers, revisionTriggers,
} from "../../server/platform/db/revisions.ts";

let A = "", B = "", C = "", source = "", section = "";
const server: TestServer = useServer({
  async seed(s) {
    A = await newBoard(s, { title: "revisions: the board written to" });
    B = await newBoard(s, { title: "revisions: the board left alone" });
    C = await newBoard(s, { title: "revisions: the board a pair moves to" });
    source = await addMarkdown(s, A, "hedging.md", MD);
    section = (await s.api(`/api/boards/${A}`)).body.sections[0].id;
  },
});
const api = (path: string, init?: RequestInit) => server.api(path, init);
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// opened and closed per read, so no handle outlives the server that owns the temp directory
function read<T>(sql: string, ...args: (string | number)[]): T {
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  try { return db.prepare(sql).get(...args) as T; } finally { db.close(); }
}
const room = (): number => read<{ rev: number }>("SELECT rev FROM room_rev WHERE id = 1").rev;
const boardRev = (id: string): number => read<{ rev: number }>("SELECT rev FROM boards WHERE id = ?", id).rev;
const planRev = (id: string): number => read<{ plan_rev: number }>("SELECT plan_rev FROM boards WHERE id = ?", id).plan_rev;
const deckRev = (slug: string): number => read<{ rev: number }>("SELECT rev FROM courses WHERE slug = ?", slug).rev;

async function movesOnlyA(what: string, write: () => Promise<{ status: number }>): Promise<void> {
  const [a, b, r] = [boardRev(A), boardRev(B), room()];
  const { status } = await write();
  assert.ok(status >= 200 && status < 300, `${what}: answered ${status}`);
  assert.ok(boardRev(A) > a, `${what}: the board it wrote to moves (${a} → ${boardRev(A)})`);
  assert.equal(boardRev(B), b, `${what}: an unrelated board does not`);
  assert.ok(room() > r, `${what}: the room's counter moves`);
  assert.ok(boardRev(A) <= room(), `${what}: a board's rev is a stamp from the room's counter`);
}

test("each board write moves that board's rev, and no other board's", async () => {
  await movesOnlyA("board rename", () => api(`/api/boards/${A}`, json("PATCH", { title: "renamed" })));
  await movesOnlyA("notes PUT", () => api(`/api/boards/${A}/notes`, json("PUT", { text: "# the running log" })));
  await movesOnlyA("notes PUT again (the upsert's update)", () => api(`/api/boards/${A}/notes`, json("PUT", { text: "# the running log, longer" })));

  let mark = "";
  await movesOnlyA("mark create", async () => {
    const r = await api(`/api/boards/${A}/marks`, json("POST", { resourceId: source, start: 2, end: 10, quote: "Duration" }));
    mark = r.body.id;
    return r;
  });
  await movesOnlyA("mark note", () => api(`/api/boards/${A}/marks/${mark}`, json("PATCH", { note: "the one to remember" })));
  await movesOnlyA("mark delete", () => api(`/api/boards/${A}/marks/${mark}`, { method: "DELETE" }));

  const plan = planRev(A);
  await movesOnlyA("plan purpose", () => api(`/api/boards/${A}/plan/purpose`, json("PUT", { purpose: "pass the exam" })));
  assert.ok(planRev(A) > plan, "the purpose is the plan's: plan_rev moves with it");
  const planBefore = planRev(A);
  await movesOnlyA("plan group", () => api(`/api/boards/${A}/plan/groups`, json("POST", { name: "week 1" })));
  assert.ok(planRev(A) > planBefore, "a group is the plan's too");
  const notPlan = planRev(A);
  await movesOnlyA("board rename, plan untouched", () => api(`/api/boards/${A}`, json("PATCH", { title: "renamed again" })));
  assert.equal(planRev(A), notPlan, "a rename is not a plan write: plan_rev stays");

  await movesOnlyA("pair add", () => api(`/api/boards/${A}/pairs`, json("POST", { label: "a blank page" })));
  await movesOnlyA("resource rename", () => api(`/api/boards/${A}/resources/${source}`, json("PATCH", { filename: "hedging, renamed.md" })));
  await movesOnlyA("minted create", () => api(`/api/boards/${A}/minted`, json("POST", { front: "Why does convexity break a DV01 hedge?", variant: "bare" })));

  const page = await api(`/api/boards/${A}/resources`, json("POST", { filename: "live.html", base64: Buffer.from("<html><body><input><script>1</script></body></html>").toString("base64") }));
  const state = `/api/boards/${A}/resources/${page.body.id}/state`;
  await movesOnlyA("page state PUT", () => api(state, json("PUT", { value: "{}" })));
  await movesOnlyA("page state PUT again (the upsert's update)", () => api(state, json("PUT", { value: '{"a":1}' })));
  const own = read<{ rev: number }>("SELECT rev FROM page_states WHERE resource_id = ?", page.body.id).rev;
  assert.equal(own, (await api(state)).body.rev, "a page's state carries its own rev");
  const noted = await api(`/api/boards/${A}/marks`, json("POST", { resourceId: page.body.id, start: 0, end: 4, quote: "live", note: "on a live page" }));
  await movesOnlyA("note reply", () => api(`/api/boards/${A}/marks/${noted.body.id}/replies`, json("POST", { text: "an answer" })));
});

// A fresh pair has no plan place, so only the trigger's OLD half can stamp A here.
test("a pair moved to another board moves both boards, and no third", async () => {
  const { body: made } = await api(`/api/boards/${A}/pairs`, json("POST", { label: "a page that moves" }));
  const [a, b, c] = [boardRev(A), boardRev(B), boardRev(C)];
  const moved = await api(`/api/boards/${A}/pairs/${made.id}/move`, json("POST", { to: C }));
  assert.equal(moved.status, 200);
  assert.ok(boardRev(A) > a, "the board it left moves");
  assert.ok(boardRev(C) > c, "the board it arrived on moves");
  assert.equal(boardRev(B), b, "a third board does not");
  assert.equal(moved.body.state.rev, boardRev(A), "and each state in the answer carries its board's rev");
  assert.equal(moved.body.destState.rev, boardRev(C));
});

test("writes that stamp no board still move the room's counter", async () => {
  const stamped = async (res: Response): Promise<number> => { await res.arrayBuffer(); return Number(res.headers.get("X-Strata-Rev")); };
  const post = (path: string, body: unknown): Promise<Response> =>
    server.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const [a, b] = [boardRev(A), boardRev(B)];

  const review = await stamped(await server.fetch("/api/review"));
  const card = (await api("/api/decks/aio-lecture-4")).body.cards[0];
  const grade = await post("/api/review/grade", { requestId: "grade-revisions-01", course: "aio-lecture-4", card: card.id, got: true });
  assert.equal(grade.status, 200);
  const graded = await stamped(grade);
  assert.ok(graded > review, `a grade's answer outranks the review read before it (${review} → ${graded})`);

  const listed = await stamped(await server.fetch("/api/imports"));
  const made = await post("/api/imports", { id: "import-revisions-01", board: A, filename: "a book.pdf", size: 10 });
  assert.equal(made.status, 201);
  const created = await stamped(made);
  assert.ok(created > listed, "an import's create outranks the imports list before it");
  const cancel = await server.fetch("/api/imports/import-revisions-01", { method: "DELETE" });
  assert.equal(cancel.status, 200);
  assert.ok(await stamped(cancel) > created, "and so does its cancel (a stage change)");
  assert.deepEqual([boardRev(A), boardRev(B)], [a, b], "none of them moved a board");

  const db = new DatabaseSync(server.db, { timeout: 5000 });
  try {
    db.prepare("INSERT INTO boards (id,title,type,created_at,touched_at) VALUES ('b-revisions-bare','bare','blank',1,1)").run();
    const before = room();
    db.prepare("DELETE FROM boards WHERE id = 'b-revisions-bare'").run();
    assert.ok(room() > before, "a bare board's delete moves the counter");
  } finally { db.close(); }
});

test("deck writes move the deck's rev: a card edit, a keep, and a deck installed from a tree", async () => {
  const slug = "aio-lecture-7";
  const { body: dk } = await api(`/api/decks/${slug}`);
  const card = dk.cards[0];
  const other = deckRev("csharp-async");

  let before = deckRev(slug);
  const edit = await api(`/api/decks/${slug}/cards/${card.id}`, json("PATCH", { front: "Rewritten, in my words?" }));
  assert.equal(edit.status, 200);
  assert.ok(deckRev(slug) > before, "a card edit moves its deck");

  before = deckRev(slug);
  const keep = await api(`/api/decks/${slug}/keeps`, json("POST", { add: [card.id] }));
  assert.equal(keep.status, 200);
  assert.ok(deckRev(slug) > before, "a keep moves its deck");
  before = deckRev(slug);
  await api(`/api/decks/${slug}/keeps`, json("POST", { remove: [card.id] }));
  assert.ok(deckRev(slug) > before, "and so does taking it back");
  assert.equal(deckRev("csharp-async"), other, "another deck is left alone");

  const boardBefore = boardRev(A);
  const put = await api(`/api/boards/${A}/resources/${source}/tree?section=${section}`, json("PUT", {
    tree: { title: "Hedging", nodes: [{ label: "DV01 hedges fail under convexity", children: [] }] },
    cards: [{ front: "What does a DV01 hedge protect against?", back: "Small, parallel shifts." }],
  }));
  assert.equal(put.status, 200);
  const gen = "src-" + section.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const installed = deckRev(gen);
  assert.ok(installed > 0, "the installed deck carries a stamp");
  assert.ok(boardRev(A) > boardBefore, "the board whose tree changed moves");

  const again = await api(`/api/boards/${A}/resources/${source}/tree?section=${section}`, json("PUT", {
    tree: { title: "Hedging", nodes: [{ label: "DV01 hedges fail under convexity", children: [] }] },
    cards: [{ front: "What does a DV01 hedge protect against?", back: "Small, parallel shifts only." }],
  }));
  assert.equal(again.status, 200);
  assert.ok(deckRev(gen) > installed, "re-installing the deck moves it again");
});

test("reads, logged events and status polls move nothing", async () => {
  const r = room();
  for (const path of [
    `/api/boards/${A}`, "/api/boards", `/api/boards/${A}/status`, `/api/boards/${A}/touched`,
    `/api/boards/${A}/seen`, `/api/boards/${A}/messages`, `/api/boards/${A}/minted`,
    `/api/boards/${A}/resources/${source}/raw`, `/api/boards/${A}/resources/${source}/tree`,
    "/api/decks", "/api/decks/aio-lecture-4", "/api/decks/aio-lecture-4/keeps", "/api/register",
    "/api/review", "/api/library", "/api/collection",
  ]) {
    const res = await server.fetch(path);
    assert.ok(res.status < 500, `${path}: ${res.status}`);
    await res.arrayBuffer();
  }
  const log = await api("/api/log", json("POST", { event: "read_progress", props: { board: A, resource: source, depth: 0.4 } }));
  assert.ok(log.status < 300);
  assert.equal(room(), r, "no read, beacon or poll moved the room's counter");
});

test("a writer on its own connection moves the revision too — the reason for triggers", async () => {
  const [a, b] = [boardRev(A), boardRev(B)];
  const db = new DatabaseSync(server.db, { timeout: 5000 });
  try {
    db.prepare(`INSERT INTO marks (id,board_id,resource_id,page,start_off,end_off,quote,note,rects,created_at,updated_at)
                VALUES ('mk-0123abcd',?,?,NULL,0,8,'Duration',NULL,NULL,1,1)`).run(A, source);
    db.prepare("DELETE FROM marks WHERE board_id = ? AND id = 'mk-0123abcd'").run(A);
  } finally { db.close(); }
  assert.ok(boardRev(A) > a, "an operator tool's write is stamped like the server's own");
  assert.equal(boardRev(B), b);
});

test("every /api answer says where the counter stands, and which boot said so", async () => {
  const first = await server.fetch(`/api/boards/${A}`);
  await first.arrayBuffer();
  const rev = Number(first.headers.get("X-Strata-Rev"));
  const epoch = first.headers.get("X-Strata-Epoch");
  assert.ok(Number.isInteger(rev) && rev > 0, "X-Strata-Rev is the room's counter");
  assert.equal(rev, room());
  assert.match(epoch ?? "", /^[0-9a-f]{16}$/, "X-Strata-Epoch is a random id");

  const w = await server.fetch(`/api/boards/${A}/notes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "headers" }) });
  await w.arrayBuffer();
  assert.ok(Number(w.headers.get("X-Strata-Rev")) > rev, "the write's answer is stamped after it");
  assert.equal(Number(w.headers.get("X-Strata-Rev")), room());
  assert.equal(w.headers.get("X-Strata-Epoch"), epoch, "one epoch for the life of the boot");

  const missing = await server.fetch("/api/boards/no-such-board");
  await missing.arrayBuffer();
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("X-Strata-Epoch"), epoch);
  const health = await server.fetch("/api/health");
  await health.arrayBuffer();
  assert.equal(health.headers.get("X-Strata-Rev"), null, "the public health check says nothing about the room");
  const ranged = await server.fetch(`/api/boards/${A}/resources/${source}/raw`, { headers: { Range: "bytes=0-9" } });
  await ranged.arrayBuffer();
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("X-Strata-Rev"), null, "ranged bytes are immutable and carry no rev");
  assert.equal(ranged.headers.get("X-Strata-Epoch"), null);

  const chat = await server.fetch(`/api/boards/${B}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message: "what is convexity?" }),
  });
  assert.equal(chat.status, 200);
  assert.ok(Number(chat.headers.get("X-Strata-Rev")) > 0, "the SSE start carries the rev");
  assert.equal(chat.headers.get("X-Strata-Epoch"), epoch);
  await chat.text();
});

test("board answers carry the board's rev, and its documents' own", async () => {
  const notes = await api(`/api/boards/${A}/notes`, json("PUT", { text: "# revs in bodies" }));
  assert.equal(notes.status, 200, "a notes save answers 200 with its revisions now, not 204");
  assert.equal(notes.body.rev, boardRev(A));
  assert.equal(notes.body.notesRev, read<{ rev: number }>("SELECT rev FROM board_notes WHERE board_id = ?", A).rev);

  const { body: state } = await api(`/api/boards/${A}`);
  assert.equal(state.rev, boardRev(A), "BoardState.rev is boards.rev");
  assert.equal(state.notesRev, notes.body.notesRev, "BoardState.notesRev is the log's own");
  assert.equal(state.notes, "# revs in bodies");
  assert.equal(state.plan.rev, planRev(A), "BoardState.plan.rev is boards.plan_rev");
  assert.ok(state.minted.length > 0 && state.minted.every((m: { rev: number }) => m.rev > 0), "each minted row carries its own stamp");
  const { body: fresh } = await api(`/api/boards/${B}`);
  assert.equal(fresh.notesRev, 0, "a board with no log yet has notesRev 0");

  const status = await api(`/api/boards/${A}/status`);
  assert.deepEqual(Object.keys(status.body).sort(), ["busy", "rev", "version"]);
  assert.equal(status.body.rev, boardRev(A), "the status poll answers the board's rev");
  assert.equal(typeof status.body.version, "string", "version stays one release for old tabs");

  const made = await api(`/api/boards/${A}/marks`, json("POST", { resourceId: source, start: 2, end: 10, quote: "Duration" }));
  assert.equal(made.status, 201);
  assert.equal(made.body.rev, boardRev(A), "a mark's answer carries the board's rev after it");
  assert.equal(made.body.mark.quote, "Duration");
  const said = await api(`/api/boards/${A}/marks/${made.body.id}`, json("PATCH", { note: "said" }));
  assert.equal(said.body.rev, boardRev(A));
  const gone = await api(`/api/boards/${A}/marks/${made.body.id}`, { method: "DELETE" });
  assert.deepEqual([gone.body.ok, gone.body.id, gone.body.rev], [true, made.body.id, boardRev(A)]);

  const group = await api(`/api/boards/${A}/plan/groups`, json("POST", { name: "week 2" }));
  assert.equal(group.status, 201);
  assert.ok(group.body.id && group.body.plan.groups.some((g: { id: string }) => g.id === group.body.id));
  assert.equal(group.body.rev, boardRev(A), "a plan answer carries the board's rev…");
  assert.equal(group.body.plan.rev, planRev(A), "…and the plan its own");

  const page = await api(`/api/boards/${A}/messages`);
  assert.ok(Array.isArray(page.body.messages) && "before" in page.body);
  assert.equal(page.body.rev, boardRev(A), "a thread page carries the board's rev");

  const treeRev = read<{ rev: number }>("SELECT rev FROM trees WHERE section_id = ?", section).rev;
  assert.ok(treeRev > 0, "the tree the deck test put back is stamped");
  const tree = await api(`/api/boards/${A}/resources/${source}/tree?section=${section}`);
  assert.equal(tree.status, 200);
  assert.equal(tree.body.rev, treeRev, "a section's tree answers trees.rev");
  assert.equal((await api(`/api/boards/${A}/resources/${source}/tree`)).body.rev, treeRev, "and so does a one-section source's, asked without ?section");
});

test("deck answers carry the deck's rev, and each card its own", async () => {
  const slug = "csharp-async";
  const { body: dk } = await api(`/api/decks/${slug}`);
  assert.equal(dk.rev, deckRev(slug), "a deck read carries courses.rev");
  assert.ok(dk.cards.length > 0 && dk.cards.every((c: { rev: unknown }) => typeof c.rev === "number"), "and every card its stamp");
  const card = dk.cards[0];

  const edit = await api(`/api/decks/${slug}/cards/${card.id}`, json("PATCH", { front: "What is the first async fixture, really?" }));
  assert.equal(edit.status, 200);
  assert.equal(edit.body.ok, true);
  assert.equal(edit.body.rev, deckRev(slug), "a card edit answers the deck's rev");
  assert.equal(edit.body.card.rev, read<{ rev: number }>("SELECT rev FROM cards WHERE id = ?", card.id).rev, "and the card its own");
  assert.ok(edit.body.card.rev > card.rev, "which the edit moved");

  const kept = await api(`/api/decks/${slug}/keeps`, json("POST", { add: [card.id] }));
  assert.deepEqual(kept.body.ids, [card.id]);
  assert.equal(kept.body.rev, deckRev(slug), "keeps answer {ids, rev}");
  assert.equal((await api(`/api/decks/${slug}/keeps`)).body.rev, deckRev(slug), "and so does reading them");
  await api(`/api/decks/${slug}/keeps`, json("POST", { remove: [card.id] }));

  const dropped = dk.cards[1];
  assert.equal((await api(`/api/decks/${slug}/cards/${dropped.id}`, { method: "DELETE" })).status, 200);
  const ignored = await api(`/api/decks/${slug}/ignored`);
  assert.equal(ignored.body.rev, deckRev(slug), "the ignored pile carries the deck's rev");
  const tomb = ignored.body.cards.find((c: { id: string }) => c.id === dropped.id);
  assert.ok(tomb && tomb.rev > 0, "and each dropped card its stamp");
  assert.equal(tomb.rev, read<{ rev: number }>("SELECT rev FROM card_drops WHERE id = ?", dropped.id).rev);
  assert.equal((await api(`/api/decks/${slug}/cards/${dropped.id}/restore`, { method: "POST" })).status, 200);

  const into = "aio-lecture-4";
  const { body: asked } = await api(`/api/boards/${A}/minted`, json("POST", {
    front: "What does a DV01 hedge leave open?", variant: "bare", state: "closed", back: "Convexity.", meta: {} }));
  const keptQ = await api(`/api/decks/${into}/keeps/minted`, json("POST", { board: A, mint: asked.id }));
  assert.equal(keptQ.status, 200);
  assert.ok(keptQ.body.card.rev > 0, "the materialized card carries its stamp");
  assert.equal(keptQ.body.card.rev, read<{ rev: number }>("SELECT rev FROM cards WHERE id = ?", keptQ.body.card.id).rev);
  assert.equal(keptQ.body.rev, deckRev(into), "the keeps beside it, the deck's rev");
  assert.equal(keptQ.body.state.rev, boardRev(A), "and the board state its board's");
});

test("the schema: every board- or deck-scoped table is revisioned or named as not", () => {
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    const columns = (t: string): string[] => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    const triggers = new Map((db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { name: string; sql: string }[]).map((t) => [t.name, t.sql]));
    const listensTo = (sql: string): string[] => (/UPDATE OF (.+?) ON /s.exec(sql)?.[1] ?? "").split(",").map((c) => c.trim()).filter(Boolean);

    const revisioned = new Set(REVISIONED.map((t) => t.table));
    const missing: string[] = [];
    for (const t of tables) {
      const cols = columns(t);
      if (!cols.includes("board_id") && !cols.includes("course")) continue;
      if (NOT_REVISIONED.includes(t)) { assert.ok(!revisioned.has(t), `${t} is both revisioned and not`); continue; }
      for (const verb of ["insert", "update", "delete"]) if (!triggers.has(`${TRIGGER_PREFIX}_${t}_${verb}`)) missing.push(`${TRIGGER_PREFIX}_${t}_${verb}`);
    }
    assert.deepEqual(missing, [], "a table with a board_id or course column needs its revision triggers, or a line in NOT_REVISIONED");

    for (const name of ["boards_insert", "boards_update", "courses_insert", "courses_update"]) {
      assert.ok(triggers.has(`${TRIGGER_PREFIX}_${name}`), `${TRIGGER_PREFIX}_${name} exists`);
    }
    for (const r of ROOM_ONLY) {
      const sql = triggers.get(`${TRIGGER_PREFIX}_room_${r.table}_${r.verb}`);
      assert.ok(sql, `${TRIGGER_PREFIX}_room_${r.table}_${r.verb} exists`);
      assert.doesNotMatch(sql!, /UPDATE (boards|courses)\b/, "a room-only trigger stamps no board and no deck");
    }

    const stamped = [...REVISIONED.filter((t) => t.row).map((t) => t.table), "boards", "courses"];
    for (const t of stamped) {
      assert.ok(columns(t).includes("rev"), `${t} carries a rev`);
      const sql = triggers.get(`${TRIGGER_PREFIX}_${t}_update`);
      assert.ok(sql, `${t} has an update trigger`);
      assert.deepEqual(listensTo(sql!).sort(), columns(t).filter((c) => !STAMP_COLUMNS.has(c)).sort(),
        `${t}'s update trigger listens to every column but the stamps`);
    }
    for (const t of REVISIONED.filter((x) => !x.row)) assert.equal(listensTo(triggers.get(`${TRIGGER_PREFIX}_${t.table}_update`)!).length, 0, `${t.table} fires on any update`);

    const stored = [...triggers].filter(([name]) => /^rev\d+_/.test(name)).sort();
    assert.deepEqual(stored, [...revisionTriggers(db)].sort(), "sqlite_master holds exactly the generated revision triggers");
  } finally { db.close(); }
});

// A column added by a later migration must widen its table's UPDATE OF list at the next boot sync.
test("the trigger set follows the schema: a later column is listened to after the next sync", () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-revisions-"));
  const copy = join(dir, "room.db");
  try {
    const src = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
    try { src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`); } finally { src.close(); }
    const db = new DatabaseSync(copy);
    try {
      assert.equal(ensureRevisionTriggers(db), 0, "a room in step has nothing to sync");
      db.exec("ALTER TABLE minted ADD COLUMN later TEXT");
      db.exec("CREATE TRIGGER rev0_marks_insert AFTER INSERT ON marks BEGIN SELECT 1; END");
      assert.equal(ensureRevisionTriggers(db), 1, "only the widened trigger is rebuilt");
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'rev0_marks_insert'").get(), undefined, "a trigger no longer generated is dropped");
      const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = '${TRIGGER_PREFIX}_minted_update'`).get() as { sql: string }).sql;
      assert.match(sql, /UPDATE OF [^]*\blater\b[^]* ON minted/, "the new column is listened to");

      const m = db.prepare("SELECT id, board_id, rev FROM minted ORDER BY rev DESC LIMIT 1").get() as { id: string; board_id: string; rev: number };
      const board = (db.prepare("SELECT rev FROM boards WHERE id = ?").get(m.board_id) as { rev: number }).rev;
      db.prepare("UPDATE minted SET later = 'x' WHERE id = ?").run(m.id);
      const after = db.prepare("SELECT m.rev mrev, b.rev brev FROM minted m JOIN boards b ON b.id = m.board_id WHERE m.id = ?").get(m.id) as { mrev: number; brev: number };
      assert.ok(after.mrev > m.rev && after.brev > board, "a write through the new column stamps the row and its board");
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
