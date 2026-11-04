import type { Minted } from "../../../shared/types/index.ts";
import { parseJson } from "../../platform/db/sql.ts";
import type { MintedRow } from "../../platform/db/rows.ts";

export const mintedOut = (m: MintedRow): Minted => ({
  id: m.id, pairId: m.pair_id, variant: m.variant, state: m.state,
  front: m.front, back: m.back, source: m.source ?? "", deck: m.deck ?? null,
  meta: parseJson<Record<string, unknown>>(m.meta, {}), opensAt: m.opens_at, createdAt: m.created_at,
  cardId: m.card_id ?? null,
  rev: m.rev ?? 0,
});
