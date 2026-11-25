import { stmt } from "../../platform/db/sql.ts";
import type { MintedRow } from "../../platform/db/rows.ts";

export const consolidateRepo = {
  boardDecks: stmt<{ deck: string; resource_id: string | null; id: string }>("SELECT id, deck, resource_id FROM pairs WHERE board_id = ? AND deck IS NOT NULL ORDER BY ord"),
  keptIn: stmt<{ id: string; course: string; deck: string; type: string; payload: string }>(
    "SELECT c.id, k.course, k.deck, c.type, c.payload FROM card_keeps k JOIN cards c ON c.id = k.id WHERE k.course = ? ORDER BY k.created_at"),
  notesOf: stmt<{ id: string; resource_id: string; quote: string; note: string }>(
    "SELECT id, resource_id, quote, note FROM marks WHERE board_id = ? AND note IS NOT NULL AND trim(note) <> '' ORDER BY created_at"),
  openOf: stmt<{ id: string; pair_id: string | null; front: string; source: string | null }>(
    "SELECT id, pair_id, front, source FROM minted WHERE board_id = ? AND state = 'open' ORDER BY created_at"),
  distilledOf: stmt<MintedRow>("SELECT * FROM minted WHERE board_id = ? AND json_extract(meta, '$.distil.idea') IS NOT NULL ORDER BY created_at"),
  filenameOf: stmt<{ filename: string | null }>("SELECT filename FROM resources WHERE id = ?"),
};
