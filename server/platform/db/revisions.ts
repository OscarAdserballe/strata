/* Revision triggers.
   - One room counter (room_rev): every write to a revisioned table takes the next value as its stamp.
   - The stamp is copied into the row's scopes: boards.rev, boards.plan_rev, courses.rev or the row's own rev.
   - Triggers, not a helper: every writer is covered, and the stamp commits or rolls back with the write.
   - The stamp must not recurse: UPDATE OF lists every column except rev, plan_rev and touched_at.
   - The trigger set is generated from the live schema and synced to sqlite_master at every boot. */

import type { DatabaseSync } from "node:sqlite";

export const TRIGGER_PREFIX = "rev1";

// board: boards.rev; plan: boards.rev and plan_rev; deck: courses.rev; row: the table's own rev too.
interface Revisioned { table: string; key: "board_id" | "course"; scope: "board" | "plan" | "deck"; row?: true }

export const REVISIONED: readonly Revisioned[] = [
  { table: "messages", key: "board_id", scope: "board" },
  { table: "board_prefs", key: "board_id", scope: "board" },
  { table: "pairs", key: "board_id", scope: "board" },
  { table: "sections", key: "board_id", scope: "board", row: true },
  { table: "board_notes", key: "board_id", scope: "board", row: true },
  { table: "page_states", key: "board_id", scope: "board", row: true },
  { table: "resources", key: "board_id", scope: "board" },
  { table: "trees", key: "board_id", scope: "board", row: true },
  { table: "source_trees", key: "board_id", scope: "board" },
  { table: "marks", key: "board_id", scope: "board" },
  { table: "mark_replies", key: "board_id", scope: "board" },
  { table: "asks", key: "board_id", scope: "board" },
  { table: "minted", key: "board_id", scope: "board", row: true },
  { table: "board_groups", key: "board_id", scope: "plan" },
  { table: "board_milestones", key: "board_id", scope: "plan" },
  { table: "board_places", key: "board_id", scope: "plan" },
  { table: "cards", key: "course", scope: "deck", row: true },
  { table: "card_drops", key: "course", scope: "deck", row: true },
  { table: "card_edits", key: "course", scope: "deck" },
  { table: "card_keeps", key: "course", scope: "deck" },
];

// Not revisioned, on purpose. A new table with a board_id or course column must be listed here or above.
export const NOT_REVISIONED: readonly string[] = [
  "events", "activity_meta", "activity_read", "activity_views", "activity_cards", "activity_bench",
  "review_dirty", "review_schedule", "request_log", "perf_samples", "feedback", "review_receipts",
  "request_receipts", "settings", "thread_revisions", "imports", "import_chunks", "resource_blobs",
  "card_messages",
];

// Room-only: these move room_rev so stale library reads are dropped, but stamp no board or deck.
export const ROOM_ONLY: readonly { table: string; verb: "insert" | "update" | "delete"; event: string }[] = [
  { table: "review_receipts", verb: "insert", event: "INSERT" },
  { table: "imports", verb: "insert", event: "INSERT" },
  { table: "imports", verb: "update", event: "UPDATE OF stage" },
  { table: "imports", verb: "delete", event: "DELETE" },
  { table: "boards", verb: "delete", event: "DELETE" },
  { table: "courses", verb: "delete", event: "DELETE" },
  { table: "agent_tokens", verb: "insert", event: "INSERT" },
  { table: "agent_tokens", verb: "update", event: "UPDATE OF revoked_at" },
];

export const STAMP_COLUMNS: ReadonlySet<string> = new Set(["rev", "plan_rev", "touched_at"]);

const STAMP = "(SELECT rev FROM room_rev WHERE id = 1)";
const BUMP = "UPDATE room_rev SET rev = rev + 1 WHERE id = 1;";
const OURS = /^rev\d+_/;

function scopeStamp(t: Revisioned, rows: ("OLD" | "NEW")[]): string {
  const keys = rows.map((r) => `${r}.${t.key}`);
  const where = keys.length > 1 ? `IN (${keys.join(", ")})` : `= ${keys[0]}`;
  if (t.scope === "deck") return `UPDATE courses SET rev = ${STAMP} WHERE slug ${where};`;
  if (t.scope === "plan") return `UPDATE boards SET rev = ${STAMP}, plan_rev = ${STAMP} WHERE id ${where};`;
  return `UPDATE boards SET rev = ${STAMP} WHERE id ${where};`;
}

function updateOf(db: DatabaseSync, table: string): string {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name).filter((c) => !STAMP_COLUMNS.has(c));
  return `UPDATE OF ${cols.join(", ")}`;
}

/** name -> SQL exactly as sqlite_master stores it (no IF NOT EXISTS, no trailing semicolon) */
export function revisionTriggers(db: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  const trigger = (name: string, table: string, event: string, body: string): void => {
    out.set(name, `CREATE TRIGGER ${name} AFTER ${event} ON ${table} BEGIN ${BUMP}${body ? ` ${body}` : ""} END`);
  };
  for (const t of REVISIONED) {
    const name = (verb: string): string => `${TRIGGER_PREFIX}_${t.table}_${verb}`;
    const row = t.row ? ` UPDATE ${t.table} SET rev = ${STAMP} WHERE rowid = NEW.rowid;` : "";
    trigger(name("insert"), t.table, "INSERT", scopeStamp(t, ["NEW"]) + row);
    trigger(name("update"), t.table, t.row ? updateOf(db, t.table) : "UPDATE", scopeStamp(t, ["OLD", "NEW"]) + row);
    trigger(name("delete"), t.table, "DELETE", scopeStamp(t, ["OLD"]));
  }
  // the board's purpose is also the plan's, so changing it moves plan_rev
  trigger(`${TRIGGER_PREFIX}_boards_insert`, "boards", "INSERT", `UPDATE boards SET rev = ${STAMP} WHERE id = NEW.id;`);
  trigger(`${TRIGGER_PREFIX}_boards_update`, "boards", updateOf(db, "boards"), `UPDATE boards SET rev = ${STAMP},`
    + ` plan_rev = CASE WHEN OLD.purpose IS NOT NEW.purpose THEN ${STAMP} ELSE plan_rev END WHERE id = NEW.id;`);
  trigger(`${TRIGGER_PREFIX}_courses_insert`, "courses", "INSERT", `UPDATE courses SET rev = ${STAMP} WHERE slug = NEW.slug;`);
  trigger(`${TRIGGER_PREFIX}_courses_update`, "courses", updateOf(db, "courses"), `UPDATE courses SET rev = ${STAMP} WHERE slug = NEW.slug;`);
  for (const r of ROOM_ONLY) trigger(`${TRIGGER_PREFIX}_room_${r.table}_${r.verb}`, r.table, r.event, "");
  return out;
}

export function ensureRevisionTriggers(db: DatabaseSync): number {
  const want = revisionTriggers(db);
  const have = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { name: string; sql: string }[])
    .filter((t) => OURS.test(t.name));
  const drop = new Set(have.filter((t) => want.get(t.name) !== t.sql).map((t) => t.name));
  const kept = new Set(have.map((t) => t.name).filter((n) => !drop.has(n)));
  const create = [...want].filter(([name]) => !kept.has(name)).map(([, sql]) => sql);
  if (!drop.size && !create.length) return 0;
  db.exec("SAVEPOINT revision_triggers");
  try {
    for (const name of drop) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    for (const sql of create) db.exec(sql);
    db.exec("RELEASE revision_triggers");
  } catch (e) { db.exec("ROLLBACK TO revision_triggers; RELEASE revision_triggers"); throw e; }
  return create.length;
}
