import type { Card, CardEditAnswer } from "../../../shared/types/index.ts";
import { mutator as roomMutator, type Conflict, type Mutator, type Op, type SaveError } from "../../data/mutate.ts";
import { outbox as roomOutbox, type Clash, type ClashDraft } from "../../data/outbox.ts";
import { store as roomStore, sameData, type Store } from "../../data/store.ts";
import { authored, rowOf } from "../../data/entities/authored.ts";

export const cardKey = (id: string): string => `card:${id}`;
export const deckOf = (card: { deck?: string | null }): string => String(card.deck || "").split("/")[0];
export type CardRef = Pick<Card, "id"> & { deck?: string | null };

type Faces = Record<string, unknown>;
const revOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");

export function baseOf(card: Card, s: Store = roomStore): number | null {
  const held = revOf(s.get<Card>(cardKey(card.id))?.rev);
  const listed = revOf(card.rev);
  if (held === null) return listed;
  return listed === null ? held : Math.max(held, listed);
}

export class CardConflict extends Error {
  readonly status = 409;
  readonly theirs: Card | null;
  readonly mine: Faces;
  constructor(theirs: Card | null, mine: Faces) {
    super(theirs ? "this card was changed elsewhere while you were writing" : "this card is no longer in its deck");
    this.theirs = theirs;
    this.mine = mine;
  }
}

export function cardEditOp(card: Card, patch: Faces, s: Store = roomStore): Op<CardEditAnswer> {
  const slug = deckOf(card);
  return {
    label: "save the card",
    lanes: [cardKey(card.id)],
    method: "PATCH",
    path: `/api/decks/${slug}/cards/${card.id}`,
    body: patch,
    base: () => baseOf(card, s),
    confirm: (res, meta) => {
      if (res?.card?.id) s.apply(cardKey(res.card.id), revOf(res.card.rev) ?? meta.rev, res.card, "wire", { epoch: meta.epoch, stamp: meta.rev });
    },
    onConflict: (c: Conflict, epoch: string) => {
      if (!c.value) return null;
      const now = takeRefused(card, c, epoch, s);
      const untouched = Object.keys(patch).every((k) => same((now as unknown as Faces)[k], (card as unknown as Faces)[k]));
      return untouched ? cardEditOp(now, patch, s) : null;
    },
  };
}

/** An edit as shelved: offline it waits on the device, and meeting a newer card on reconnect it is a clash, not a write over it. */
export interface CardEditAct { card: Card; patch: Faces }

const faceText = (v: unknown): string => (Array.isArray(v) ? v.map((x, i) => `${i + 1}. ${String(x)}`).join("\n") : String(v ?? ""));
export const facesText = (faces: Faces, keys: string[]): string => keys.map((k) => `${k}: ${faceText(faces[k])}`).join("\n\n");

export function cardEditKind(s: Store) {
  return {
    build: (a: CardEditAct) => cardEditOp(a.card, a.patch, s),
    release: true,
    clash: (e: SaveError, a: CardEditAct): ClashDraft | null => {
      const theirs = e.conflict?.value as Faces | null | undefined;
      const keys = Object.keys(a.patch);
      // a lost edit that landed comes back as theirs: nothing changed elsewhere
      if (!theirs || keys.every((k) => same(theirs[k], a.patch[k]))) return null;
      const board = typeof a.card.project === "string" ? a.card.project : "";
      const title = typeof a.card.courseTitle === "string" ? a.card.courseTitle : deckOf(a.card);
      return { where: { board, title, source: null, passage: String(a.card.front ?? "").slice(0, 200) || null },
        mine: facesText(a.patch, keys), theirs: facesText(theirs, keys), rev: revOf(e.conflict?.rev) ?? 0, args: a };
    },
    over: (c: Clash): CardEditAct => { const a = c.args as CardEditAct; return { card: { ...a.card, rev: c.rev }, patch: a.patch }; },
  };
}
roomOutbox.kind<CardEditAct>("card-edit", cardEditKind(roomStore));

export async function saveCard(card: Card, patch: Faces, m: Mutator = roomMutator, s: Store = roomStore): Promise<Card> {
  if (!deckOf(card)) throw new Error("this card has no deck to write to");
  try {
    const op = cardEditOp(card, patch, s);
    const res = m === roomMutator && s === roomStore ? await roomOutbox.send<CardEditAnswer>("card-edit", { card, patch } satisfies CardEditAct, op) : await m.mutate(op);
    return res.card;
  } catch (e) {
    if ((e as { clashed?: boolean } | null)?.clashed) throw e;
    giveUp(e, card, m);
    const { conflict, epoch } = (e ?? {}) as SaveError;
    if (conflict) throw new CardConflict(conflict.value ? takeRefused(card, conflict, epoch ?? "", s) : null, patch);
    throw e;
  }
}

function takeRefused(card: Card, c: Conflict, epoch: string, s: Store): Card {
  s.apply(cardKey(card.id), c.rev, { ...card, ...(c.value as Card), rev: c.rev }, "wire", { epoch, equal: sameData });
  return s.get<Card>(cardKey(card.id)) ?? { ...card, ...(c.value as Card), rev: c.rev };
}

/** out of retries: take it off the card's lanes, or the next save queues behind it forever */
function giveUp(e: unknown, card: CardRef, m: Mutator): void {
  if ((e as { retryable?: boolean } | null)?.retryable) m.discardFailed(cardKey(card.id));
}

export function dropCardOp(card: CardRef): Op<{ ok: boolean; total: number }> {
  return {
    label: "delete the card",
    lanes: [cardKey(card.id), `deck:${deckOf(card)}`],
    method: "DELETE",
    path: `/api/decks/${deckOf(card)}/cards/${card.id}`,
    confirm: () => {},
  };
}
export function restoreCardOp(card: CardRef): Op<{ ok: boolean }> {
  return {
    label: "put the card back",
    lanes: [cardKey(card.id), `deck:${deckOf(card)}`],
    method: "POST",
    path: `/api/decks/${deckOf(card)}/cards/${card.id}/restore`,
    confirm: () => {},
  };
}
export async function dropCard(card: CardRef, m: Mutator = roomMutator): Promise<void> {
  if (!deckOf(card)) throw new Error("this card has no deck to delete from");
  try { await m.mutate(dropCardOp(card)); } catch (e) { giveUp(e, card, m); throw e; }
}
export async function restoreCard(card: CardRef, m: Mutator = roomMutator): Promise<void> {
  if (!deckOf(card)) throw new Error("this card has no deck to go back to");
  try { await m.mutate(restoreCardOp(card)); } catch (e) { giveUp(e, card, m); throw e; }
}

export async function saveAuthored(board: string, mintId: string, patch: Faces, m: Mutator = roomMutator, s: Store = roomStore): Promise<{ state?: unknown }> {
  try {
    return await authored.update(board, mintId, patch, m, s);
  } catch (e) {
    if ((e as { clashed?: boolean } | null)?.clashed) throw e;
    const conflict = (e as { conflict?: Conflict } | null)?.conflict;
    if (!conflict) throw e;
    const row = (conflict.value && (rowOf(board, mintId, s) ?? conflict.value)) as { front?: unknown; back?: unknown } | null;
    // faces only: the row's id and rev are the question's, not the card's
    throw new CardConflict(row ? ({ front: row.front ?? "", back: row.back ?? "" } as unknown as Card) : null, patch);
  }
}
