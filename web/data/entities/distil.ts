import type { BoardState, DistilFace, DistilMeta } from "../../../shared/types/index.ts";
import { mutator as roomMutator, type Mutator, type Op } from "../mutate.ts";
import { authoredKey } from "./boards.ts";
import { keepsKey } from "./keeps.ts";

export interface DistilKeep { idea: string; title: string; deck: string; cards: DistilFace[]; from: string[]; drafted: DistilMeta["drafted"] }

const decksOf = (refs: string[]): string[] => Array.from(new Set(refs.filter((r) => r.startsWith("k:")).map((r) => r.slice(2).split("/")[0])));

export const distilOps = {
  keep(board: string, k: DistilKeep): Op<{ idea: string; cards: string[]; retired: string[]; state: BoardState }> {
    return {
      label: "keep the distilled card",
      lanes: [`distil:${board}`],
      method: "POST",
      path: `/api/boards/${board}/distil/keep`,
      body: k,
      invalidates: [authoredKey(board), keepsKey(k.deck), ...decksOf(k.from).map(keepsKey)],
    };
  },
  undo(board: string, idea: string, from: string[], deck: string): Op<{ idea: string; restored: string[]; state: BoardState }> {
    return {
      label: "undo the distilled card",
      lanes: [`distil:${board}`],
      method: "POST",
      path: `/api/boards/${board}/distil/${idea}/undo`,
      body: {},
      invalidates: [authoredKey(board), keepsKey(deck), ...decksOf(from).map(keepsKey)],
    };
  },
};

export const distil = {
  keep: (board: string, k: DistilKeep, m: Mutator = roomMutator) => m.release(distilOps.keep(board, k)),
  undo: (board: string, idea: string, from: string[], deck: string, m: Mutator = roomMutator) => m.release(distilOps.undo(board, idea, from, deck)),
};
