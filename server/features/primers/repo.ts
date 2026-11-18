import { stmt } from "../../platform/db/sql.ts";

export interface PrimerRow { resource_id: string; board_id: string; status: string; has_html: number; asked_at: number | null; built_at: number | null; rev: number }

export const primersRepo = {
  primer: stmt<PrimerRow>("SELECT resource_id,board_id,status,html IS NOT NULL AS has_html,asked_at,built_at,rev FROM primers WHERE board_id = ? AND resource_id = ?"),
  primerHtml: stmt<{ html: string | null }>("SELECT html FROM primers WHERE board_id = ? AND resource_id = ?"),
  askPrimer: stmt(`INSERT INTO primers (resource_id,board_id,status,asked_at) VALUES (?,?,'asked',?)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'asked', asked_at = excluded.asked_at`),
  setPrimer: stmt(`INSERT INTO primers (resource_id,board_id,status,html,built_at) VALUES (?,?,'ready',?,?)
    ON CONFLICT(resource_id) DO UPDATE SET status = 'ready', html = excluded.html, built_at = excluded.built_at`),
  askedOf: stmt<{ resource_id: string; asked_at: number | null }>("SELECT resource_id,asked_at FROM primers WHERE board_id = ? AND status = 'asked' ORDER BY asked_at"),
  boardHandle: stmt<{ handle: string | null }>("SELECT handle FROM boards WHERE id = ?"),
  primersOf: stmt<{ resource_id: string; status: string; built_at: number | null }>("SELECT resource_id,status,built_at FROM primers WHERE board_id = ?"),
};
