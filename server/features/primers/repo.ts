import { stmt } from "../../platform/db/sql.ts";

export interface PrimerRow { resource_id: string; board_id: string; status: "requested" | "ready" | "stale"; bytes: number; requested_at: number | null; built_at: number | null }

// Never html here: these run on every board read; only primerPage reads the page itself.
const COLS = "resource_id,board_id,status,bytes,requested_at,built_at";
export const primersRepo = {
  primersOf: stmt<PrimerRow>(`SELECT ${COLS} FROM primers WHERE board_id = ?`),
  primerOf: stmt<PrimerRow>(`SELECT ${COLS} FROM primers WHERE resource_id = ?`),
  primerPage: stmt<{ html: string | null }>("SELECT html FROM primers WHERE board_id = ? AND resource_id = ?"),
  requestedByBoard: stmt<{ board_id: string; n: number }>("SELECT board_id, COUNT(*) AS n FROM primers WHERE status = 'requested' GROUP BY board_id"),
  // a press while one is already asked for changes nothing, so a second press is not a second request
  request: stmt(`INSERT INTO primers (resource_id,board_id,status,requested_at) VALUES (?,?,'requested',?)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'requested', requested_at = excluded.requested_at, board_id = excluded.board_id
    WHERE primers.status <> 'requested'`),
  put: stmt(`INSERT INTO primers (resource_id,board_id,status,html,bytes,built_at) VALUES (?,?,'ready',?,?,?)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'ready', html = excluded.html, bytes = excluded.bytes, built_at = excluded.built_at, board_id = excluded.board_id`),
  stale: stmt("UPDATE primers SET status = 'stale' WHERE resource_id = ? AND status = 'ready'"),
  unprimed: stmt<{ id: string; filename: string | null }>(`SELECT r.id, r.filename FROM resources r
    WHERE r.board_id = ? AND NOT EXISTS (SELECT 1 FROM primers p WHERE p.resource_id = r.id) ORDER BY r.created_at, r.id LIMIT ?`),
  unprimedCount: stmt<{ n: number }>("SELECT COUNT(*) AS n FROM resources r WHERE r.board_id = ? AND NOT EXISTS (SELECT 1 FROM primers p WHERE p.resource_id = r.id)"),
  del: stmt("DELETE FROM primers WHERE resource_id = ?"),
  delBoard: stmt("DELETE FROM primers WHERE board_id = ?"),
};
