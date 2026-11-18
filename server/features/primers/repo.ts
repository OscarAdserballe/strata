import { stmt } from "../../platform/db/sql.ts";

export interface PrimerRow { resource_id: string; board_id: string; status: string; requested_at: number | null; built_at: number | null; rev: number }

// Never the html column, except where the page itself is served: status reads stay narrow.
const COLS = "resource_id,board_id,status,requested_at,built_at,rev";
export const primersRepo = {
  primer: stmt<PrimerRow>(`SELECT ${COLS} FROM primers WHERE resource_id = ?`),
  primerHtml: stmt<{ html: string | null }>("SELECT html FROM primers WHERE board_id = ? AND resource_id = ?"),
  primersOf: stmt<PrimerRow>(`SELECT ${COLS} FROM primers WHERE board_id = ? ORDER BY requested_at`),
  waitingByBoard: stmt<{ board_id: string; n: number }>("SELECT board_id, COUNT(*) n FROM primers WHERE status = 'requested' GROUP BY board_id"),
  // a source with no primer, or one whose source changed under it, oldest first
  lacking: stmt<{ id: string; filename: string | null }>(`SELECT r.id, r.filename FROM resources r LEFT JOIN primers p ON p.resource_id = r.id
    WHERE r.board_id = ? AND (p.resource_id IS NULL OR p.status = 'stale') ORDER BY r.created_at, r.id LIMIT ?`),
  request: stmt(`INSERT INTO primers (resource_id, board_id, status, requested_at) VALUES (?, ?, 'requested', ?)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'requested', requested_at = excluded.requested_at WHERE primers.status = 'stale'`),
  setReady: stmt(`INSERT INTO primers (resource_id, board_id, status, html, built_at) VALUES (?, ?, 'ready', ?, ?)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'ready', html = excluded.html, built_at = excluded.built_at`),
  markStale: stmt("UPDATE primers SET status = 'stale' WHERE resource_id = ? AND status = 'ready'"),
  delPrimer: stmt("DELETE FROM primers WHERE resource_id = ?"),
  delBoardPrimers: stmt("DELETE FROM primers WHERE board_id = ?"),
  boardHandle: stmt<{ handle: string | null }>("SELECT handle FROM boards WHERE id = ?"),
  sourceOn: stmt<{ id: string; filename: string | null }>("SELECT id, filename FROM resources WHERE board_id = ? AND id = ?"),
};
