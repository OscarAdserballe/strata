import { stmt } from "../../platform/db/sql.ts";
import type { TreeRow, TreeStatusRow, SourceTreeRow } from "../../platform/db/rows.ts";

export const distilRepo = {

  tree: stmt<TreeRow>("SELECT * FROM trees WHERE section_id = ?"),
  treesOf: stmt<TreeStatusRow>("SELECT section_id,resource_id,status,cards,error,updated_at,title FROM trees WHERE board_id = ?"),
  treesOfResource: stmt<TreeRow>("SELECT * FROM trees WHERE resource_id = ? ORDER BY rowid ASC"),
  upsertTree: stmt(`INSERT INTO trees (section_id,resource_id,board_id,title,question,json,ascii,status,error,cards,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(section_id) DO UPDATE SET resource_id=excluded.resource_id, board_id=excluded.board_id,
      title=excluded.title, question=excluded.question,
      json=excluded.json, ascii=excluded.ascii, status=excluded.status, error=excluded.error,
      cards=excluded.cards, updated_at=excluded.updated_at`),
  setTreeStatus: stmt("UPDATE trees SET status = ?, error = ?, updated_at = ? WHERE section_id = ?"),
  // Compare-and-set stages: zero rows changed means another runner has the section, or it moved on.
  claimTree: stmt(`UPDATE trees SET resource_id = ?, board_id = ?, title = ?, question = '', json = ?, ascii = NULL,
    status = 'running', error = NULL, cards = 0, updated_at = ? WHERE section_id = ? AND status IN ('queued','preparing')`),
  advanceTree: stmt(`UPDATE trees SET title = ?, question = ?, json = ?, ascii = ?, status = ?, error = NULL, cards = ?, updated_at = ?
    WHERE section_id = ? AND status = ?`),
  failTree: stmt("UPDATE trees SET status = 'error', error = ?, updated_at = ? WHERE section_id = ? AND status IN ('running','carding')"),
  delTree: stmt("DELETE FROM trees WHERE section_id = ?"),
  // a forced re-distil drops the saved tree, so the run builds it again instead of resuming it
  clearTreeDraft: stmt("UPDATE trees SET json = NULL, ascii = NULL WHERE section_id = ?"),
  delTreesOfResource: stmt("DELETE FROM trees WHERE resource_id = ?"),
  undistilled: stmt<{ id: string; resource_id: string; board_id: string }>(`SELECT s.id, s.resource_id, s.board_id FROM sections s
    LEFT JOIN trees t ON t.section_id = s.id
    WHERE t.section_id IS NULL OR t.status IN ('queued','disabled')
    ORDER BY s.resource_id, s.ord ASC`),
  // Boot only: nothing is running yet, so any in-flight row is an orphan of the last process.
  resetOrphanTrees: stmt("UPDATE trees SET status = 'queued' WHERE status IN ('preparing','running','carding')"),
  delBoardTrees: stmt("DELETE FROM trees WHERE board_id = ?"),
  sourceTree: stmt<SourceTreeRow>("SELECT * FROM source_trees WHERE resource_id = ?"),
  upsertSourceTree: stmt(`INSERT INTO source_trees (resource_id,board_id,title,question,json,ascii,status,error,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(resource_id) DO UPDATE SET board_id=excluded.board_id, title=excluded.title, question=excluded.question,
      json=excluded.json, ascii=excluded.ascii, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at`),
  delSourceTree: stmt("DELETE FROM source_trees WHERE resource_id = ?"),
  delBoardSourceTrees: stmt("DELETE FROM source_trees WHERE board_id = ?"),
};
