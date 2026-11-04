// Each migration probes the live schema and no-ops once done; append only, never reorder or delete one.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { ensureImports, SCHEMA, SECTION_TO_END } from "./schema.ts";
import { noteOfThread, replyOfMessage } from "../../../shared/reading/notes.ts";
import { transaction } from "./transaction.ts";
import { ensureRevisionTriggers } from "./revisions.ts";
import { ensureReceipts } from "./receipts.ts";
import { ensureEventsTable, ensureRequestLog } from "../events/events.ts";
import { ensurePerfSamples } from "../events/perf.ts";
import { ensureProjections } from "../projections.ts";
import { asFlashcard } from "../../../shared/cards/flashcard.ts";

let db: DatabaseSync;

const tableColumns = (table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const addColumn = (table: string, col: string, ddl: string): void => {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); } catch { /* already there */ }
};

function resourceColumns(): void {
  for (const [col, ddl] of [["kind", "TEXT"], ["origin_url", "TEXT"], ["bytes_len", "INTEGER"]]) {
    addColumn("resources", col, ddl);
  }
}

// Interruptible: rows move one at a time, and the columns drop only once every row has its blob.
function bytesMoveOut(): void {
  const cols = tableColumns("resources");
  if (!cols.includes("data")) return;
  const hasPageText = cols.includes("page_text");
  const todo = db.prepare(
    `SELECT id FROM resources WHERE (data IS NOT NULL${hasPageText ? " OR page_text IS NOT NULL" : ""})
       AND id NOT IN (SELECT resource_id FROM resource_blobs)`).all() as { id: string }[];
  if (todo.length) console.log(`  migrating ${todo.length} resource${todo.length > 1 ? "s" : ""} out of the resources table…`);
  const one = db.prepare(`SELECT data${hasPageText ? ", page_text" : ""} FROM resources WHERE id = ?`);
  const put = db.prepare("INSERT OR REPLACE INTO resource_blobs (resource_id, bytes, page_text) VALUES (?,?,?)");
  const len = db.prepare("UPDATE resources SET bytes_len = ? WHERE id = ?");
  for (const { id } of todo) {
    const row = one.get(id) as { data: string | null; page_text?: string | null } | undefined;
    if (!row) continue;
    const bytes = row.data ? Buffer.from(row.data, "base64") : null;
    transaction(db, () => {
      put.run(id, bytes, row.page_text ?? null);
      len.run(bytes ? bytes.length : null, id);
    });
  }
  // DROP COLUMN leaves the freed pages in the file; VACUUM gives them back.
  const left = (db.prepare(
    `SELECT count(*) AS n FROM resources WHERE (data IS NOT NULL${hasPageText ? " OR page_text IS NOT NULL" : ""})
       AND id NOT IN (SELECT resource_id FROM resource_blobs)`).get() as { n: number }).n;
  if (left === 0) {
    db.exec("ALTER TABLE resources DROP COLUMN data");
    if (hasPageText) db.exec("ALTER TABLE resources DROP COLUMN page_text");
    db.exec("VACUUM");
    // VACUUM under WAL leaves a large -wal behind; checkpoint so the disk is actually reclaimed.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (todo.length) console.log("  …moved, and the resources table is narrow again");
  } else {
    console.warn(`  ${left} resource(s) did not migrate — leaving the old columns in place`);
  }
}

function laterColumns(): void {
  addColumn("minted", "deck", "TEXT");
  addColumn("minted", "card_id", "TEXT");
  db.exec(`UPDATE resources SET kind = CASE
             WHEN COALESCE(mime,'') LIKE '%pdf%' OR LOWER(COALESCE(filename,'')) LIKE '%.pdf' THEN 'pdf'
             ELSE 'text' END
           WHERE kind IS NULL`);
  addColumn("pairs", "section_id", "TEXT");
  addColumn("messages", "archived", "INTEGER NOT NULL DEFAULT 0");
  addColumn("sections", "kind", "TEXT");
  addColumn("sections", "tokens", "INTEGER");
  addColumn("sections", "content_ranges", "TEXT");
}

function sectionsBackfill(): void {
  const rows = db.prepare("SELECT id, board_id, filename, tokens FROM resources WHERE id NOT IN (SELECT resource_id FROM sections)").all() as { id: string; board_id: string; filename: string | null; tokens: number | null }[];
  if (!rows.length) return;
  const ins = db.prepare("INSERT INTO sections (id,resource_id,board_id,ord,label,first_page,last_page,created_at,tokens) VALUES (?,?,?,0,?,1,?,?,?)");
  const point = db.prepare("UPDATE pairs SET section_id = ? WHERE resource_id = ? AND section_id IS NULL");
  for (const r of rows) {
    const sid = "s" + randomUUID().replace(/-/g, "").slice(0, 8);
    ins.run(sid, r.id, r.board_id, r.filename ?? "the whole source", SECTION_TO_END, Date.now(), r.tokens ?? 0);
    point.run(sid, r.id);
  }
  console.log(`  sections: backfilled ${rows.length} source${rows.length === 1 ? "" : "s"} to one section each`);
}

function sectionTokensBackfill(): void {
  const stale = db.prepare("SELECT id, resource_id, first_page, last_page FROM sections WHERE tokens IS NULL").all() as { id: string; resource_id: string; first_page: number; last_page: number }[];
  if (!stale.length) return;
  const set = db.prepare("UPDATE sections SET tokens = ? WHERE id = ?");
  const countIn = db.prepare("SELECT COUNT(*) n FROM sections WHERE resource_id = ?");
  const tok = db.prepare("SELECT tokens FROM resources WHERE id = ?");
  const pt = db.prepare("SELECT page_text FROM resource_blobs WHERE resource_id = ?");
  for (const s of stale) {
    const r = tok.get(s.resource_id) as { tokens: number | null } | undefined;
    if (!r) { set.run(0, s.id); continue; }
    const many = ((countIn.get(s.resource_id) as { n: number }).n) > 1;
    let pages: string[] = [];
    const raw = many ? (pt.get(s.resource_id) as { page_text: string | null } | undefined)?.page_text : null;
    if (raw) { try { pages = JSON.parse(raw) as string[]; } catch { pages = []; } }
    if (!many || !pages.length) { set.run(r.tokens ?? 0, s.id); continue; }
    const last = s.last_page === SECTION_TO_END ? pages.length : Math.min(s.last_page, pages.length);
    const chars = pages.slice(Math.max(0, s.first_page - 1), last).reduce((a, t) => a + t.length + 12, 0);
    set.run(Math.ceil(chars / 4), s.id);
  }
  console.log(`  sections: costed ${stale.length}`);
}

function treesBySection(): void {
  const cols = db.prepare("PRAGMA table_info(trees)").all() as { name: string }[];
  if (!cols.length || cols.some((c) => c.name === "section_id")) return;
  db.exec("ALTER TABLE trees RENAME TO trees_by_resource");
  db.exec(`CREATE TABLE trees (
    section_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, board_id TEXT NOT NULL,
    title TEXT, question TEXT, json TEXT, ascii TEXT,
    status TEXT NOT NULL DEFAULT 'pending', error TEXT,
    cards INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  )`);
  db.exec(`INSERT OR IGNORE INTO trees (section_id,resource_id,board_id,title,question,json,ascii,status,error,cards,updated_at)
           SELECT s.id, t.resource_id, t.board_id, t.title, t.question, t.json, t.ascii, t.status, t.error, t.cards, t.updated_at
           FROM trees_by_resource t JOIN sections s ON s.resource_id = t.resource_id`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_trees_resource ON trees(resource_id)");
  db.exec("DROP TABLE trees_by_resource");
  console.log("  trees: re-keyed from source to section");
}

// Migrations run before ensureEventsTable, so on a DB from before usage logging this creates it empty.
function boardTouched(): void {
  if (tableColumns("boards").includes("touched_at")) return;
  addColumn("boards", "touched_at", "INTEGER");
  ensureEventsTable(db);
  db.exec(`UPDATE boards SET touched_at = COALESCE(
    (SELECT MAX(e.ts) FROM events e WHERE json_extract(e.props,'$.board') = boards.id),
    (SELECT MAX(m.created_at) FROM messages m WHERE m.board_id = boards.id),
    created_at)`);
  console.log("  boards: touched_at backfilled from the usage log");
}

// Stored generated decks are not re-imported at boot, so flatten their retired card types once.
function simpleFlashcards(): void {
  if ((db.prepare("SELECT value FROM settings WHERE key = 'simple-flashcards'").get() as { value: string } | undefined)) return;
  let n = 0;
  for (const table of ["cards", "card_drops"]) {
    const rows = db.prepare(`SELECT id, type, payload FROM ${table} WHERE type != 'flashcard'`).all() as { id: string; type: string; payload: string }[];
    const put = db.prepare(`UPDATE ${table} SET type = 'flashcard', payload = ? WHERE id = ?`);
    for (const r of rows) {
      let p: Record<string, unknown>;
      try { p = JSON.parse(r.payload) as Record<string, unknown>; } catch { continue; }
      put.run(JSON.stringify(asFlashcard(r.type, p)), r.id);
      n++;
    }
  }
  db.prepare("INSERT INTO settings (key,value) VALUES ('simple-flashcards','1')").run();
  if (n) console.log(`  cards: flattened ${n} stored card${n === 1 ? "" : "s"} to question/answer`);
}

// Dashboard bodies in the four parts the inbox edits: what was there becomes Context, with the words
// it came from; where it came from and its links become Sources. A body already in parts is left alone.
const PARTED = /^## (Context|Done when|Research|Open questions|Sources)\s*$/m;
interface DashFrom { source?: string; url?: string; quote?: string }
interface DashLink { kind?: string; ref?: string; title?: string; url?: string }
function partedBody(body: string, from: DashFrom | null, links: DashLink[]): string {
  const context = [body.trim(), from?.quote ? `> “${from.quote.trim()}”` : ""].filter(Boolean).join("\n\n");
  const sources = [
    from?.source && from.source !== "You" && from.source !== "Added by you" ? `- ${from.source}${from.url ? ` <${from.url}>` : ""}` : "",
    ...links.map((l) => `- ${l.kind}: ${[l.ref, l.title].filter(Boolean).join(" · ")}${l.url && l.url !== from?.url ? ` <${l.url}>` : ""}`),
  ].filter(Boolean);
  return [context ? `## Context\n${context}` : "", sources.length ? `## Sources\n${sources.join("\n")}` : ""].filter(Boolean).join("\n\n");
}
const parse = <T,>(s: string | null, fb: T): T => { try { return s ? JSON.parse(s) as T : fb; } catch { return fb; } };
function dashboardParts(): void {
  const set = db.prepare("UPDATE dashboard_tasks SET body = ? WHERE id = ?");
  for (const t of db.prepare("SELECT id, body, created_from, links FROM dashboard_tasks").all() as { id: string; body: string; created_from: string | null; links: string }[]) {
    if (PARTED.test(t.body)) continue;
    const next = partedBody(t.body, parse<DashFrom | null>(t.created_from, null), parse<DashLink[]>(t.links, []));
    if (next !== t.body) set.run(next, t.id);
  }
  const setItem = db.prepare("UPDATE dashboard_inbox SET item = ? WHERE id = ?");
  for (const r of db.prepare("SELECT id, item FROM dashboard_inbox WHERE handled_at IS NULL AND kind IN ('task','subtask')").all() as { id: string; item: string }[]) {
    const it = parse<Record<string, unknown>>(r.item, {});
    const body = String(it.body ?? "");
    if (PARTED.test(body)) continue;
    setItem.run(JSON.stringify({ ...it, body: partedBody(body, (it.from ?? null) as DashFrom | null, (it.links ?? []) as DashLink[]) }), r.id);
  }
}

const MIGRATIONS: [name: string, run: () => void][] = [
  ["resource-columns", resourceColumns],
  ["bytes-move-out", bytesMoveOut],
  ["later-columns", laterColumns],
  ["sections-backfill", sectionsBackfill],
  ["section-tokens", sectionTokensBackfill],
  ["trees-by-section", treesBySection],
  ["board-touched", boardTouched],
  ["simple-flashcards", simpleFlashcards],
  ["chat-by-resource", () => addColumn("messages", "resource_id", "TEXT")],
  ["resource-done", () => addColumn("resources", "done_at", "INTEGER")],
  // Cover home/list reads without visiting table pages that hold large prose documents.
  ["resource-metadata-index", () => db.exec(`CREATE INDEX IF NOT EXISTS resources_metadata
    ON resources(board_id,created_at,id,filename,mime,tokens,included,kind,origin_url,bytes_len,done_at)`) ],
  ["resource-generation", () => addColumn("resources", "generation", "INTEGER NOT NULL DEFAULT 0")],
  ["messages-page-index", () => db.exec("CREATE INDEX IF NOT EXISTS messages_page ON messages(board_id,archived,idx)")],
  ["durable-imports", () => ensureImports(db)],
  ["board-goal", () => { if (!tableColumns("boards").includes("purpose")) addColumn("boards", "goal", "TEXT"); }],
  // Covering indexes: a tree row's claim tree sits before the status columns, so status reads skip it.
  ["trees-status-indexes", () => {
    db.exec("CREATE INDEX IF NOT EXISTS trees_board_status ON trees(board_id,section_id,resource_id,status,cards,error,updated_at,title)");
    db.exec("CREATE INDEX IF NOT EXISTS trees_resource_status ON trees(resource_id,status)");
  }],
  ["revisions", () => {
    addColumn("boards", "rev", "INTEGER NOT NULL DEFAULT 0");
    addColumn("boards", "plan_rev", "INTEGER NOT NULL DEFAULT 0");
    addColumn("courses", "rev", "INTEGER NOT NULL DEFAULT 0");
    for (const t of ["board_notes", "trees", "cards", "card_drops", "minted"]) addColumn(t, "rev", "INTEGER NOT NULL DEFAULT 0");
    db.exec(`CREATE TABLE IF NOT EXISTS room_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
             INSERT OR IGNORE INTO room_rev VALUES (1, 0);`);
    ensureRevisionTriggers(db);
  }],
  ["request-receipts", () => ensureReceipts(db)],
  ["drop-kept-at", () => addColumn("card_drops", "kept_at", "INTEGER")],
  // An agent names a board by a short handle, and an upload carries its hash and where it came from.
  ["agent-surface", () => {
    addColumn("boards", "handle", "TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS boards_handle ON boards(handle) WHERE handle IS NOT NULL");
    for (const [col, ddl] of [["auto", "INTEGER NOT NULL DEFAULT 0"], ["origin", "TEXT"], ["origin_ref", "TEXT"], ["sha256", "TEXT"]]) addColumn("imports", col, ddl);
    db.exec("CREATE INDEX IF NOT EXISTS imports_sha256 ON imports(board_id,sha256) WHERE sha256 IS NOT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS imports_origin_ref ON imports(board_id,origin_ref) WHERE origin_ref IS NOT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS review_receipts_course_at ON review_receipts(course,at)");
    db.exec("CREATE INDEX IF NOT EXISTS review_receipts_card_at ON review_receipts(card,at)");
  }],
  // Whether an upload is carded on arrival; a source not studied has trees marked 'unstudied'.
  ["import-study", () => addColumn("imports", "study", "INTEGER NOT NULL DEFAULT 1")],
  // The board's source list reads generation now, so the covering index carries it.
  ["resource-metadata-generation", () => {
    if ((db.prepare("PRAGMA index_info(resources_metadata)").all() as { name: string }[]).some((c) => c.name === "generation")) return;
    db.exec(`DROP INDEX IF EXISTS resources_metadata;
      CREATE INDEX resources_metadata ON resources(board_id,created_at,id,filename,mime,tokens,included,kind,origin_url,bytes_len,done_at,generation)`);
  }],
  // A source's split is one document (its sections' revs); the outline is what a new split is chosen over.
  ["section-split", () => {
    addColumn("sections", "rev", "INTEGER NOT NULL DEFAULT 0");
    addColumn("resource_blobs", "outline", "TEXT");
  }],
  // RENAME COLUMN re-parses triggers, and the boards update trigger already names purpose: drop it, the boot sync remakes it.
  ["board-purpose", () => {
    if (!tableColumns("boards").includes("goal")) return;
    db.exec("DROP TRIGGER IF EXISTS rev1_boards_update; ALTER TABLE boards RENAME COLUMN goal TO purpose");
  }],
  // Today pins and the archive; the sources and pad tables come from SCHEMA.
  ["dashboard-today-archive", () => {
    addColumn("dashboard_tasks", "pinned_at", "INTEGER");
    addColumn("dashboard_tasks", "cleared_at", "INTEGER");
  }],
  ["dashboard-parts", dashboardParts],
  // Work or personal, guessed once from where a task came from; the reader moves any it got wrong.
  ["dashboard-area", () => {
    addColumn("dashboard_tasks", "area", "TEXT");
    const work = /slack|linear|github|engineering|1:1|streaming|worker|design review|standup|sync\b|#/i;
    const set = db.prepare("UPDATE dashboard_tasks SET area = ? WHERE id = ?");
    for (const t of db.prepare("SELECT id, created_from FROM dashboard_tasks WHERE area IS NULL").all() as { id: string; created_from: string | null }[]) {
      set.run(work.test(parse<DashFrom | null>(t.created_from, null)?.source ?? "") ? "work" : "personal", t.id);
    }
  }],
  // A note can sit on a page's labelled box (data-strata-id) rather than on words.
  ["marks-box", () => addColumn("marks", "box", "TEXT")],
  ["comments-to-notes", commentsToNotes],
  // A question asked at words names them; a turn asked without any keeps null.
  ["messages-ask", () => addColumn("messages", "ask_id", "TEXT")],
];

// A comment thread is now a note with replies: the reader's first words are the note, everything after a reply.
// Drafts are sent as written, and the threads' tables go in the same savepoint, so this runs once.
function commentsToNotes(): void {
  if (!tableColumns("comments").length) return;
  const hasMessages = tableColumns("comment_messages").length > 0;
  type Thread = { id: string; board_id: string; resource_id: string; anchor: string; quote: string; start_off: number; end_off: number; box: string | null; created_at: number; updated_at: number };
  type Message = { id: string; author: string; text: string; created_at: number };
  const threads = db.prepare("SELECT id,board_id,resource_id,anchor,quote,start_off,end_off,box,created_at,updated_at FROM comments").all() as Thread[];
  const said = hasMessages ? db.prepare("SELECT id,author,text,created_at FROM comment_messages WHERE board_id = ? AND comment_id = ? ORDER BY created_at, id") : null;
  const mark = db.prepare("INSERT OR IGNORE INTO marks (id,board_id,resource_id,page,start_off,end_off,quote,note,rects,box,created_at,updated_at) VALUES (?,?,?,NULL,?,?,?,?,NULL,?,?,?)");
  const reply = db.prepare("INSERT OR IGNORE INTO mark_replies (id,board_id,mark_id,resource_id,author,text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
  db.exec("SAVEPOINT comments_to_notes");
  try {
    for (const t of threads) {
      const ms = (said?.all(t.board_id, t.id) ?? []) as Message[];
      const first = ms.findIndex((m) => m.author !== "agent");
      const mid = noteOfThread(t.id), box = t.anchor === "box" ? t.box : null;
      mark.run(mid, t.board_id, t.resource_id, t.start_off, t.end_off, t.quote || (box ? `[${box}]` : ""), first >= 0 ? ms[first].text : null, box, t.created_at, t.updated_at);
      ms.forEach((m, i) => { if (i !== first) reply.run(replyOfMessage(m.id), t.board_id, mid, t.resource_id, m.author === "agent" ? "agent" : "you", m.text, m.created_at, m.created_at); });
    }
    db.exec("DROP TABLE IF EXISTS comment_messages; DROP TABLE IF EXISTS comments;");
    db.exec("RELEASE comments_to_notes");
  } catch (e) { db.exec("ROLLBACK TO comments_to_notes; RELEASE comments_to_notes"); throw e; }
}

export function migrate(on: DatabaseSync): void {
  db = on;
  db.exec(SCHEMA);
  for (const [name, run] of MIGRATIONS) {
    try { run(); }
    catch (e) {
      console.error(`  migration ${name} failed:`, e instanceof Error ? e.message : e);
      throw e;
    }
  }
  // sync again: a migration that added a column changes a stamped table's UPDATE OF list
  ensureRevisionTriggers(db);
  ensureEventsTable(db);
  ensureRequestLog(db);
  ensurePerfSamples(db);
  ensureProjections(db);
}
