import { stmt } from "../../platform/db/sql.ts";

export interface PrimerRow { resource_id: string; board_id: string; primer_id: string | null; asked_at: number | null; built_at: number | null }

export const primersRepo = {
  primersOf: stmt<PrimerRow>("SELECT resource_id,board_id,primer_id,asked_at,built_at FROM primers WHERE board_id = ?"),
  primerOf: stmt<PrimerRow>("SELECT resource_id,board_id,primer_id,asked_at,built_at FROM primers WHERE resource_id = ?"),
  primerFor: stmt<PrimerRow>("SELECT resource_id,board_id,primer_id,asked_at,built_at FROM primers WHERE primer_id = ?"),
  askPrimer: stmt(`INSERT INTO primers (resource_id,board_id,asked_at) VALUES (?,?,?)
    ON CONFLICT(resource_id) DO UPDATE SET asked_at = excluded.asked_at`),
  setPrimer: stmt(`INSERT INTO primers (resource_id,board_id,primer_id,asked_at,built_at) VALUES (?,?,?,NULL,?)
    ON CONFLICT(resource_id) DO UPDATE SET primer_id = excluded.primer_id, asked_at = NULL, built_at = excluded.built_at`),
  delPrimersOfResource: stmt("DELETE FROM primers WHERE resource_id = ?1 OR primer_id = ?1"),
  delBoardPrimers: stmt("DELETE FROM primers WHERE board_id = ?"),
};
