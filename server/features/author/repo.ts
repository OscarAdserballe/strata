import { stmt } from "../../platform/db/sql.ts";
import type { MintedRow } from "../../platform/db/rows.ts";

export const authorRepo = {
  mintedOf: stmt<MintedRow>("SELECT id,pair_id,variant,state,front,back,source,meta,opens_at,created_at,deck,card_id,rev FROM minted WHERE board_id = ? ORDER BY created_at ASC"),
  minted: stmt<MintedRow>("SELECT id,pair_id,variant,state,front,back,source,meta,opens_at,created_at,deck,card_id,rev FROM minted WHERE board_id = ? AND id = ?"),
  mintedAll: stmt<MintedRow>("SELECT m.id,m.board_id,m.pair_id,m.variant,m.state,m.front,m.back,m.source,m.meta,m.opens_at,m.created_at,m.deck,m.card_id,m.rev, b.title board_title FROM minted m JOIN boards b ON b.id = m.board_id ORDER BY m.created_at ASC"),
  setMintedDeck: stmt("UPDATE minted SET deck = ?, updated_at = ? WHERE board_id = ? AND id = ?"),
  setMintedCard: stmt("UPDATE minted SET card_id = ?, updated_at = ? WHERE board_id = ? AND id = ?"),
  mintedMaterialized: stmt<MintedRow & { board_id: string }>("SELECT id,board_id,pair_id,variant,state,front,back,source,meta,opens_at,created_at,deck,card_id FROM minted WHERE card_id IS NOT NULL"),
  insMinted: stmt("INSERT INTO minted (id,board_id,pair_id,variant,state,front,back,source,meta,opens_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"),
  updMinted: stmt("UPDATE minted SET state = ?, front = ?, back = ?, meta = ?, opens_at = ?, updated_at = ? WHERE board_id = ? AND id = ?"),
  setMintedSource: stmt("UPDATE minted SET source = ?, updated_at = ? WHERE board_id = ? AND id = ?"),
  delMinted: stmt("DELETE FROM minted WHERE board_id = ? AND id = ?"),
  delBoardMinted: stmt("DELETE FROM minted WHERE board_id = ?"),
  openMinted: stmt<{ n: number }>("SELECT COUNT(*) n FROM minted WHERE board_id = ? AND state = 'open'"),
};
