import { stmt } from "../../platform/db/sql.ts";
import type { PairRow, BoardRow } from "../../platform/db/rows.ts";

export const boardsRepo = {
  // Excluded in SQL: boards[0] is the launcher's resume target, and the always-fresh inbox would steal it.
  boards: stmt<BoardRow>("SELECT id,title,type,touched_at FROM boards WHERE (type IS NULL OR type != 'eval') AND type != 'inbox' ORDER BY COALESCE(touched_at, created_at) DESC, created_at DESC"),
  board: stmt<BoardRow>("SELECT id,title,type FROM boards WHERE id = ?"),
  insBoard: stmt("INSERT INTO boards (id,title,type,created_at,touched_at) VALUES (?,?,?,?,?)"),
  touchBoard: stmt("UPDATE boards SET touched_at = ? WHERE id = ?"),
  boardRev: stmt<{ rev: number }>("SELECT rev FROM boards WHERE id = ?"),
  renBoard: stmt("UPDATE boards SET title = ? WHERE id = ?"),
  delBoard: stmt("DELETE FROM boards WHERE id = ?"),
  prefs: stmt<{ deck: string | null }>("SELECT deck FROM board_prefs WHERE board_id = ?"),
  setPrefs: stmt("INSERT INTO board_prefs (board_id, deck) VALUES (?, ?) ON CONFLICT(board_id) DO UPDATE SET deck = excluded.deck"),
  delPrefs: stmt("DELETE FROM board_prefs WHERE board_id = ?"),
  notes: stmt<{ text: string; rev: number }>("SELECT text,rev FROM board_notes WHERE board_id = ?"),
  // Stamp only, so a save's answer does not copy the whole log back.
  notesRev: stmt<{ rev: number }>("SELECT rev FROM board_notes WHERE board_id = ?"),
  setNotes: stmt("INSERT INTO board_notes (board_id, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(board_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at"),
  delNotes: stmt("DELETE FROM board_notes WHERE board_id = ?"),
  pairsOf: stmt<PairRow>("SELECT id,label,resource_id,deck,ord,section_id FROM pairs WHERE board_id = ? ORDER BY ord ASC, rowid ASC"),
  pair: stmt<PairRow>("SELECT id,label,resource_id,deck,ord,section_id FROM pairs WHERE board_id = ? AND id = ?"),
  insPair: stmt("INSERT INTO pairs (id,board_id,label,resource_id,deck,ord,section_id) VALUES (?,?,?,?,?,?,?)"),
  updPair: stmt("UPDATE pairs SET label = ?, resource_id = ?, deck = ? WHERE board_id = ? AND id = ?"),
  delPair: stmt("DELETE FROM pairs WHERE board_id = ? AND id = ?"),
  setPairOrd: stmt("UPDATE pairs SET ord = ? WHERE board_id = ? AND id = ?"),
  // The `= <old>` guard leaves a name you chose yourself alone.
  relabelSectionPair: stmt("UPDATE pairs SET label = ? WHERE board_id = ? AND section_id = ? AND label = ?"),
  delBoardPairs: stmt("DELETE FROM pairs WHERE board_id = ?"),
  nextOrd: stmt<{ n: number }>("SELECT COALESCE(MAX(ord), -1) + 1 n FROM pairs WHERE board_id = ?"),
  clearPairResource: stmt("UPDATE pairs SET resource_id = NULL WHERE board_id = ? AND resource_id = ?"),
  delPairsOfResource: stmt("DELETE FROM pairs WHERE board_id = ? AND resource_id = ?"),
  // Any board's, deliberately: a deck used anywhere is not this pair's to delete.
  pairsUsingDeck: stmt<{ n: number }>("SELECT COUNT(*) n FROM pairs WHERE deck = ?"),
  movePair: stmt("UPDATE pairs SET board_id = ?, ord = ? WHERE board_id = ? AND id = ?"),
  pairsWithDeck: stmt<{ id: string; deck: string; label: string | null; board_id: string; section_id: string | null; resource_id: string | null }>(
    "SELECT id,deck,label,board_id,section_id,resource_id FROM pairs WHERE deck IS NOT NULL ORDER BY rowid ASC"),
};

export const boardRev = (id: string): number => boardsRepo.boardRev.get(id)?.rev ?? 0;
