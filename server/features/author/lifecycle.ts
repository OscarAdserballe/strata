import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { now, parseJson, slugify } from "../../platform/db/sql.ts";
import type { MintedRow } from "../../platform/db/rows.ts";

export function insertMaterializedQuestion(m: { id: string; front: string; back: string | null; source: string | null }, cid: string, slug: string, boardId: string): void {
  const payload = {
    front: m.front, back: m.back ?? "", source: m.source || "asked in the thread",
    authored: true, mintId: m.id, board: boardId, id: cid,
  };
  const lead = ((q.minOrd.get(slug)?.m ?? 0) as number) - 1;
  q.insCard.run(cid, slug, `${slug}/yours`, "flashcard", JSON.stringify(payload), lead);
  const prev = q.edit.get(cid);
  if (prev) q.setCardPayload.run(JSON.stringify({ ...payload, ...parseJson<Record<string, unknown>>(prev.patch, {}) }), cid);
}

export function materializeQuestion(m: { id: string; front: string; back: string | null; source: string | null }, slug: string, boardId: string): string {
  // A personal draft gets its own id so old tombstones, edits or review history cannot attach to it.
  let cid = `${slug}/yours/${m.id.startsWith("m-personal-") ? m.id : slugify(m.front) || m.id}`;
  // Suffix the id on a clash: a live card under a dropped id would be deleted by the next applyDrops.
  if (q.cardAny.get(cid) || q.drop.get(slug, cid)) cid = `${cid}-${m.id.replace(/^m-/, "")}`;
  insertMaterializedQuestion(m, cid, slug, boardId);
  q.setMintedCard.run(cid, now(), boardId, m.id);
  return cid;
}

export function enrollQuestion(
  m: { id: string; front: string; back: string | null; source: string | null; card_id?: string | null },
  slug: string,
  boardId: string,
  ssn?: string | null,
): string {
  let home = m.card_id ? q.cardAny.get(m.card_id) : null;
  // Lift the tombstone rather than minting beside it: applyDrops would delete a live card under a dropped id.
  if (!home && m.card_id && q.drop.get(slug, m.card_id)) {
    q.delDrop.run(m.card_id);
    insertMaterializedQuestion(m, m.card_id, slug, boardId);
    logEvent(db, APP, "card_restore", { deck: slug, card: m.card_id, kept: true }, ssn ?? undefined);
    home = q.cardAny.get(m.card_id);
  }
  const cid = home ? home.id : materializeQuestion(m, slug, boardId);
  if (!home) logEvent(db, APP, "mint_materialize", { deck: slug, mint: m.id, card: cid }, ssn ?? undefined);
  if (!q.keep.get(cid)) {
    q.insKeep.run(cid, slug, `${slug}/yours`, now());
    logEvent(db, APP, "card_keep", { deck: slug, card: cid }, ssn ?? undefined);
  }
  return cid;
}

export function deMaterializeQuestion(cardId: string, boardId: string, mintId: string, ssn?: string | null): void {
  q.delKeep.run(cardId);
  q.delCard.run(cardId);
  q.setMintedCard.run(null, now(), boardId, mintId);
  logEvent(db, APP, "mint_return", { deck: String(cardId).split("/")[0], mint: mintId, card: cardId }, ssn ?? undefined);
}

export function syncMaterializedQuestion(m: MintedRow, boardId: string): void {
  const c = m.card_id ? q.cardAny.get(m.card_id) : null;
  if (!c) return;
  const payload = {
    front: m.front, back: m.back ?? "", source: m.source || "asked in the thread",
    authored: true, mintId: m.id, board: boardId, id: c.id,
  };
  const prev = q.edit.get(c.id);
  const merged = prev ? { ...payload, ...parseJson<Record<string, unknown>>(prev.patch, {}) } : payload;
  q.setCardPayload.run(JSON.stringify(merged), c.id);
}

// Replayed in keep order: each insert takes MIN(ord)-1, so the lead sequence must match the live one.
export function applyKeptQuestions(): void {
  const live = new Set((q.courses.all() as { slug: string }[]).map((c) => c.slug));
  const keptAt = new Map(q.keptAll.all().map((r) => [r.id, r.created_at]));
  const rows = (q.mintedMaterialized.all() as MintedRow[]).filter((m) => m.card_id);
  rows.sort((a, b) => (keptAt.get(a.card_id as string) ?? Infinity) - (keptAt.get(b.card_id as string) ?? Infinity));
  for (const m of rows) {
    const cid = m.card_id as string;
    if (q.cardAny.get(cid)) continue;
    const slug = String(cid).split("/")[0];
    if (!live.has(slug)) continue;
    if (q.drop.get(slug, cid)) continue;
    insertMaterializedQuestion(m, cid, slug, m.board_id as string);
  }
}
