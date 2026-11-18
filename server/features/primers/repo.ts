import { stmt } from "../../platform/db/sql.ts";

export type PrimerStatus = "requested" | "ready" | "stale";
export interface PrimerRow { resource_id: string; board_id: string; status: PrimerStatus; requested_at: number | null; built_at: number | null; rev: number; has_html: number }

// The html is read only by the page route; every other read stays clear of it.
const META = "resource_id,board_id,status,requested_at,built_at,rev,html IS NOT NULL AS has_html";
export const primersRepo = {
  primer: stmt<PrimerRow>(`SELECT ${META} FROM primers WHERE resource_id = ?`),
  primersOf: stmt<PrimerRow>(`SELECT ${META} FROM primers WHERE board_id = ? ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END, requested_at, built_at`),
  primerHtml: stmt<{ html: string | null }>("SELECT html FROM primers WHERE board_id = ? AND resource_id = ?"),
  requestPrimer: stmt(`INSERT INTO primers (resource_id, board_id, status, requested_at) VALUES (?, ?, 'requested', ?)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'requested', requested_at = excluded.requested_at`),
  putPrimer: stmt(`INSERT INTO primers (resource_id, board_id, status, html, built_at) VALUES (?, ?, 'ready', ?, ?)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'ready', html = excluded.html, built_at = excluded.built_at`),
  stalePrimer: stmt("UPDATE primers SET status = 'stale' WHERE resource_id = ? AND status = 'ready'"),
  delPrimer: stmt("DELETE FROM primers WHERE resource_id = ?"),
  delBoardPrimers: stmt("DELETE FROM primers WHERE board_id = ?"),
  setImportPrimer: stmt("UPDATE imports SET primer = 1 WHERE id = ?"),
  importPrimer: stmt<{ primer: number }>("SELECT primer FROM imports WHERE id = ?"),
};
