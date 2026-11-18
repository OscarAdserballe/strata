import { stmt } from "../../platform/db/sql.ts";

export interface PrimerMeta { status: string; asked_at: number | null; built_at: number | null; has_page: number }
export interface PrimerListRow extends PrimerMeta { resource_id: string; filename: string | null }

export const primersRepo = {
  primer: stmt<PrimerMeta>("SELECT status,asked_at,built_at,html IS NOT NULL AS has_page FROM primers WHERE board_id = ? AND resource_id = ?"),
  primerPage: stmt<{ html: string | null }>("SELECT html FROM primers WHERE board_id = ? AND resource_id = ?"),
  primerSource: stmt<{ filename: string | null; handle: string | null }>(
    "SELECT r.filename, b.handle FROM resources r JOIN boards b ON b.id = r.board_id WHERE r.board_id = ? AND r.id = ?"),
  primersOf: stmt<PrimerListRow>(`SELECT p.resource_id,p.status,p.asked_at,p.built_at,p.html IS NOT NULL AS has_page,r.filename
    FROM primers p JOIN resources r ON r.board_id = p.board_id AND r.id = p.resource_id WHERE p.board_id = ?
    ORDER BY CASE p.status WHEN 'asked' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END, COALESCE(p.asked_at, p.built_at)`),
  askPrimer: stmt(`INSERT INTO primers (board_id,resource_id,html,status,asked_at,built_at) VALUES (?,?,NULL,'asked',?,NULL)
    ON CONFLICT(board_id,resource_id) DO UPDATE SET status = 'asked', asked_at = excluded.asked_at`),
  setPrimer: stmt(`INSERT INTO primers (board_id,resource_id,html,status,asked_at,built_at) VALUES (?,?,?,'ready',NULL,?)
    ON CONFLICT(board_id,resource_id) DO UPDATE SET html = excluded.html, status = 'ready', built_at = excluded.built_at`),
  stalePrimer: stmt("UPDATE primers SET status = 'stale' WHERE board_id = ? AND resource_id = ? AND status = 'ready'"),
  delPrimer: stmt("DELETE FROM primers WHERE board_id = ? AND resource_id = ?"),
  delBoardPrimers: stmt("DELETE FROM primers WHERE board_id = ?"),
};
