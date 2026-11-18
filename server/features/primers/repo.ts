import { stmt } from "../../platform/db/sql.ts";

export type PrimerStatus = "requested" | "ready" | "stale";
export interface PrimerRow { resource_id: string; board_id: string; status: PrimerStatus; requested_at: number | null; built_at: number | null; bytes: number }

// html is read only by the live route and an agent's listing of one source: every other read leaves it out
const META = "resource_id,board_id,status,requested_at,built_at,COALESCE(length(CAST(html AS BLOB)),0) AS bytes";

export const primersRepo = {
  primer: stmt<PrimerRow>(`SELECT ${META} FROM primers WHERE resource_id = ?`),
  primerHtml: stmt<{ html: string | null; built_at: number | null }>("SELECT html,built_at FROM primers WHERE board_id = ? AND resource_id = ?"),
  primersOfBoard: stmt<PrimerRow>(`SELECT ${META} FROM primers WHERE board_id = ? ORDER BY COALESCE(requested_at, built_at) DESC`),
  primersWanted: stmt<{ n: number }>("SELECT COUNT(*) AS n FROM primers WHERE board_id = ? AND status IN ('requested','stale')"),
  primerSource: stmt<{ id: string; filename: string | null }>("SELECT id,filename FROM resources WHERE board_id = ? AND id = ?"),
  // a second request while one is out changes nothing, so a resent press can't move requested_at
  requestPrimer: stmt(`INSERT INTO primers (resource_id,board_id,html,status,requested_at,built_at) VALUES (?,?,NULL,'requested',?,NULL)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'requested', requested_at = excluded.requested_at WHERE primers.status <> 'requested'`),
  setPrimer: stmt(`INSERT INTO primers (resource_id,board_id,html,status,requested_at,built_at) VALUES (?,?,?,'ready',NULL,?)
    ON CONFLICT(resource_id) DO UPDATE SET board_id = excluded.board_id, html = excluded.html, status = 'ready', built_at = excluded.built_at`),
  stalePrimer: stmt("UPDATE primers SET status = 'stale' WHERE resource_id = ? AND status = 'ready'"),
  delPrimer: stmt("DELETE FROM primers WHERE resource_id = ?"),
  delBoardPrimers: stmt("DELETE FROM primers WHERE board_id = ?"),
};
