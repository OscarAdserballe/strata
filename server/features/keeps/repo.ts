import { stmt, activity } from "../../platform/db/sql.ts";

export const keepsRepo = {
  insKeep: stmt("INSERT OR IGNORE INTO card_keeps (id,course,deck,created_at) VALUES (?,?,?,?)"),
  delKeep: stmt("DELETE FROM card_keeps WHERE id = ?"),
  keep: stmt<{ id: string; course: string; created_at: number }>("SELECT id, course, created_at FROM card_keeps WHERE id = ?"),
  keepsOf: stmt<{ id: string }>("SELECT id FROM card_keeps WHERE course = ? ORDER BY created_at ASC"),
  keptAll: stmt<{ id: string; created_at: number }>("SELECT id, created_at FROM card_keeps"),
  // Live keeps only (the join): a keep re-id'd away by a re-distil must not inflate the count.
  keptCounts: stmt<{ course: string; n: number }>("SELECT k.course, COUNT(*) n FROM card_keeps k JOIN cards c ON c.id = k.id GROUP BY k.course"),
  // Read from the event log: an empty kept set cannot tell never-benched from curated-to-zero.
  benchedDecks: activity<{ deck: string | null }>("SELECT deck FROM activity_bench"),
  lastKeepOf: stmt<{ deck: string | null; t: number }>("SELECT json_extract(props,'$.deck') deck, MAX(ts) t FROM events WHERE event = 'card_keep' GROUP BY 1"),
};
