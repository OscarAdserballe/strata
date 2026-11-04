import type { DatabaseSync } from "node:sqlite";

/** Call inside a transaction so a key collision cannot leave a partial move. */
export function fileSource(db: DatabaseSync, resourceId: string, to: string): void {
  if (!db.prepare("SELECT id FROM boards WHERE id = ?").get(to)) throw new Error("No destination board");
  if (!db.prepare("SELECT id FROM resources WHERE id = ?").get(resourceId)) throw new Error("No source");
  const pairs = db.prepare("SELECT id, board_id FROM pairs WHERE resource_id = ? ORDER BY ord, rowid")
    .all(resourceId) as { id: string; board_id: string }[];
  let ord = Number(db.prepare("SELECT COALESCE(MAX(ord)+1,0) n FROM pairs WHERE board_id = ?").get(to)!.n);
  for (const p of pairs) {
    // Authored cards retain their identity, edits, keeps and grade history when filed.
    const minted = db.prepare("SELECT id, card_id FROM minted WHERE board_id = ? AND pair_id = ?")
      .all(p.board_id, p.id) as { id: string; card_id: string | null }[];
    for (const m of minted) {
      if (m.card_id) for (const table of ["cards", "card_drops"]) {
        db.prepare(`UPDATE ${table} SET payload = json_set(payload, '$.board', ?) WHERE id = ?`).run(to, m.card_id);
      }
      db.prepare("UPDATE minted SET board_id = ? WHERE board_id = ? AND id = ?").run(to, p.board_id, m.id);
    }
    if (p.board_id !== to) db.prepare("UPDATE pairs SET board_id = ?, ord = ? WHERE board_id = ? AND id = ?")
      .run(to, ord++, p.board_id, p.id);
  }
  // The try covers older DBs without board_places.
  try {
    db.prepare("DELETE FROM board_places WHERE board_id != ? AND (item = ? OR item IN (SELECT id FROM pairs WHERE resource_id = ?))")
      .run(to, resourceId, resourceId);
  } catch { /* no board_places yet */ }
  let idx = Number(db.prepare("SELECT COALESCE(MAX(idx)+1,0) n FROM messages WHERE board_id = ?").get(to)!.n);
  const messages = db.prepare("SELECT id FROM messages WHERE resource_id = ? AND board_id != ? ORDER BY idx, id").all(resourceId, to);
  for (const m of messages) db.prepare("UPDATE messages SET board_id = ?, idx = ? WHERE id = ?").run(to, idx++, m.id);
  for (const table of ["sections", "trees", "source_trees", "marks", "mark_replies", "asks", "page_states"]) {
    db.prepare(`UPDATE ${table} SET board_id = ? WHERE resource_id = ?`).run(to, resourceId);
  }
  db.prepare("UPDATE resources SET board_id = ?, generation = generation + 1 WHERE id = ?").run(to, resourceId);
  db.prepare("UPDATE trees SET status = 'queued', error = NULL WHERE resource_id = ? AND status IN ('running','carding')").run(resourceId);
  db.prepare("UPDATE source_trees SET status = 'pending', error = NULL WHERE resource_id = ? AND status = 'running'").run(resourceId);
}

/** Read-only preflight for historical split ownership; never guesses away missing data. */
export function sourceOwnershipIssues(db: DatabaseSync): { table: string; resource: string; board: string; expected: string | null; count: number }[] {
  return ["pairs", "sections", "trees", "source_trees", "marks", "mark_replies", "asks", "messages", "page_states"].flatMap(table =>
    db.prepare(`SELECT d.resource_id AS resource, d.board_id AS board, r.board_id AS expected, COUNT(*) AS count
      FROM ${table} d LEFT JOIN resources r ON r.id = d.resource_id
      WHERE d.resource_id IS NOT NULL AND (r.id IS NULL OR d.board_id != r.board_id)
      GROUP BY d.resource_id, d.board_id`).all().map(row => ({ table, ...row })) as ReturnType<typeof sourceOwnershipIssues>);
}
