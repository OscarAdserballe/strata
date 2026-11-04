import { stmt } from "../../platform/db/sql.ts";
import type { CourseRow, CardRow } from "../../platform/db/rows.ts";

export const decksRepo = {
  deckRev: stmt<{ rev: number }>("SELECT rev FROM courses WHERE slug = ?"),
  // Authored cards lead the deck, so their ord sits below everyone else's.
  minOrd: stmt<{ m: number | null }>("SELECT MIN(ord) m FROM cards WHERE course = ?"),
  courses: stmt<CourseRow>("SELECT slug,title,meta FROM courses ORDER BY title"),
  course: stmt<CourseRow>("SELECT slug,title,meta FROM courses WHERE slug = ?"),
  cardCounts: stmt<{ course: string; n: number }>("SELECT course, COUNT(*) n FROM cards GROUP BY course"),
  cardsOf: stmt<CardRow>("SELECT id,deck,type,payload,ord,rev FROM cards WHERE course = ? ORDER BY ord ASC"),
  // json_extract avoids parsing whole payloads: the library route walks every deck of every board.
  cardsCoverageOf: stmt<{ id: string; node: string | null; introduces: string | null; authored: number | null }>(
    "SELECT id, json_extract(payload,'$.node') node, json_extract(payload,'$.introduces') introduces, json_extract(payload,'$.authored') authored FROM cards WHERE course = ? ORDER BY ord ASC"),
  card: stmt<CardRow & { course: string }>("SELECT id,course,deck,type,payload,ord,rev FROM cards WHERE course = ? AND id = ?"),
  upsertCourse: stmt("INSERT INTO courses (slug,title,meta,updated_at) VALUES (?,?,?,?) ON CONFLICT(slug) DO UPDATE SET title=excluded.title, meta=excluded.meta, updated_at=excluded.updated_at"),
  delCourseCards: stmt("DELETE FROM cards WHERE course = ?"),
  // A card's id names the deck that made it; its course is where it is filed now.
  delMadeCards: stmt("DELETE FROM cards WHERE course = ?1 AND substr(id, 1, length(?1) + 1) = ?1 || '/'"),
  insCard: stmt("INSERT INTO cards (id,course,deck,type,payload,ord) VALUES (?,?,?,?,?,?)"),
  // Kept cards move deck under their own ids, so their history, edits and Ask threads follow them; keeps move last.
  refileEdits: stmt("UPDATE card_edits SET course = ?2 WHERE id IN (SELECT id FROM card_keeps WHERE course = ?1)"),
  refileThreads: stmt("UPDATE card_messages SET course = ?2 WHERE course = ?1 AND card IN (SELECT id FROM card_keeps WHERE course = ?1)"),
  refileCards: stmt("UPDATE cards SET course = ?2, deck = ?2 || substr(deck, length(?1) + 1) WHERE course = ?1 AND id IN (SELECT id FROM card_keeps WHERE course = ?1)"),
  refileKeeps: stmt("UPDATE card_keeps SET course = ?2, deck = ?2 || substr(deck, length(?1) + 1) WHERE course = ?1"),
  insDrop: stmt("INSERT OR REPLACE INTO card_drops (id,course,deck,type,payload,ord,created_at) VALUES (?,?,?,?,?,?,?)"),
  drop: stmt<CardRow & { course: string; kept_at: number | null }>("SELECT id,course,deck,type,payload,ord,rev,kept_at FROM card_drops WHERE course = ? AND id = ?"),
  setDropKeptAt: stmt("UPDATE card_drops SET kept_at = ? WHERE id = ?"),
  dropsOf: stmt<CardRow>("SELECT id,deck,type,payload,ord,rev FROM card_drops WHERE course = ? ORDER BY ord ASC"),
  dropRowsOf: stmt<CardRow & { course: string; kept_at: number | null }>("SELECT id,course,deck,type,payload,ord,kept_at FROM card_drops WHERE course = ? ORDER BY ord ASC"),
  dropCounts: stmt<{ course: string; n: number }>("SELECT course, COUNT(*) n FROM card_drops GROUP BY course"),
  delDrop: stmt("DELETE FROM card_drops WHERE id = ?"),
  delCard: stmt("DELETE FROM cards WHERE id = ?"),
  applyDrops: stmt("DELETE FROM cards WHERE id IN (SELECT id FROM card_drops)"),
  insEdit: stmt("INSERT OR REPLACE INTO card_edits (id,course,patch,updated_at) VALUES (?,?,?,?)"),
  edit: stmt<{ id: string; course: string; patch: string }>("SELECT id,course,patch FROM card_edits WHERE id = ?"),
  edits: stmt<{ id: string; course: string; patch: string }>("SELECT id,course,patch FROM card_edits"),
  cardAny: stmt<CardRow & { course: string }>("SELECT id,course,deck,type,payload,ord,rev FROM cards WHERE id = ?"),
  setCardPayload: stmt("UPDATE cards SET payload = ? WHERE id = ?"),
  setDropPayload: stmt("UPDATE card_drops SET payload = ? WHERE id = ?"),
  setSetting: stmt("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  delSetting: stmt("DELETE FROM settings WHERE key = ?"),
  delCourse: stmt("DELETE FROM courses WHERE slug = ?"),
};

export const deckRev = (slug: string): number => decksRepo.deckRev.get(slug)?.rev ?? 0;
