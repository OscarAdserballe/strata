import type { DeckKeepMintedResponse, DeckKeepsResponse } from "../../../shared/types/index.ts";
import { StrataAnswer } from "../api.ts";
import { store as roomStore, type Store } from "../store.ts";
import { mutator as roomMutator, type Mutator, type Op } from "../mutate.ts";
import { revOf } from "./boards.ts";

// One op per card changed (never the whole set), so an earlier toggle's answer never undoes a later guess.

export interface KeptSet { ids: string[] }
export const keepsKey = (slug: string): string => `keeps:${slug}`;

const kept = (id: string, keep: boolean) => (v: KeptSet | undefined): KeptSet => {
  const ids = (v?.ids ?? []).filter((x) => x !== id);
  return { ids: keep ? [...ids, id] : ids };
};

export const keepOps = {
  toggle(slug: string, id: string, keep: boolean): Op<DeckKeepsResponse> {
    return {
      label: keep ? "keep that card" : "let that card go",
      lanes: [keepsKey(slug)],
      method: "POST",
      path: `/api/decks/${slug}/keeps`,
      body: keep ? { add: [id] } : { remove: [id] },
      optimistic: [{ key: keepsKey(slug), apply: kept(id, keep) }],
    };
  },
  /** one of your questions becomes a card of this deck and a keep, in one act */
  keepQuestion(slug: string, board: string, mint: string): Op<DeckKeepMintedResponse> {
    return {
      label: "keep that question",
      lanes: [keepsKey(slug), `authored:${mint}`],
      method: "POST",
      path: `/api/decks/${slug}/keeps/minted`,
      body: { board, mint },
    };
  },
};

export function holdKeeps(slug: string, read: DeckKeepsResponse, s: Store = roomStore): void {
  const meta = StrataAnswer(read);
  s.apply<KeptSet>(keepsKey(slug), revOf(read.rev), { ids: read.ids ?? [] }, meta?.origin ?? "wire", { epoch: meta?.epoch ?? "", stamp: meta?.stamp });
}

/** Ops that run out of retries release their lanes with their guess removed. */
export const keeps = {
  toggle: (slug: string, id: string, keep: boolean, m: Mutator = roomMutator) => m.release(keepOps.toggle(slug, id, keep)),
  keepQuestion: (slug: string, board: string, mint: string, m: Mutator = roomMutator) => m.release(keepOps.keepQuestion(slug, board, mint)),
};
