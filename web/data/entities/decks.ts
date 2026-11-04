import { mutator as roomMutator, type Mutator, type Op } from "../mutate.ts";

export const deckLane = (slug: string): string => `deck:${slug}`;

export const deckOps = {
  setAside(slug: string, restore: boolean): Op<{ ok: boolean; cards: number }> {
    return {
      label: restore ? "put those cards back" : "set those cards aside",
      lanes: [deckLane(slug)],
      method: "POST",
      path: `/api/decks/${slug}/${restore ? "restore" : "ignore"}`,
      invalidates: [deckLane(slug)],
    };
  },
};

export const decks = {
  /** every card of the deck to the ignored pile (`restore`: every one back) */
  setAside: (slug: string, restore: boolean, m: Mutator = roomMutator) => m.release(deckOps.setAside(slug, restore)),
};
