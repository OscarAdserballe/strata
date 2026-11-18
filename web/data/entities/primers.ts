import { fetched } from "../api.ts";
import { store as roomStore, type Fetcher, type Store } from "../store.ts";
import { mutator, type Mutator, type Op } from "../mutate.ts";
import { revOf } from "./boards.ts";

// A source's primer: a page an agent draws to read before page 1. Asking for one wakes the reader's routine.

export type PrimerStatus = "none" | "asked" | "ready";
export interface PrimerEntity { status: PrimerStatus; hasPage: boolean; builtAt: number | null; rev: number }

export const primerKey = (rid: string) => `primer:${rid}`;
const pathOf = (board: string, rid: string) => `/api/boards/${board}/resources/${rid}/primer`;
export const primerPageUrl = (board: string, rid: string, builtAt: number | null) => `${pathOf(board, rid)}/page?v=${builtAt ?? 0}`;

const shape = (v: Partial<PrimerEntity> | undefined): PrimerEntity => ({
  status: v?.status === "asked" || v?.status === "ready" ? v.status : "none",
  hasPage: !!v?.hasPage, builtAt: typeof v?.builtAt === "number" ? v.builtAt : null, rev: revOf(v?.rev),
});

export const primerRead = (board: string, rid: string): Fetcher<PrimerEntity> => () =>
  fetched<PrimerEntity>(pathOf(board, rid), (v) => revOf(v?.rev)).then((f) => ({ ...f, value: shape(f.value) }));

export const primerOps = {
  ask(board: string, rid: string, s: Store = roomStore): Op<PrimerEntity> {
    const key = primerKey(rid);
    return {
      label: "ask for a primer",
      lanes: [key],
      method: "POST",
      path: pathOf(board, rid),
      body: {},
      optimistic: [{ key, apply: (held: PrimerEntity | undefined) => ({ ...shape(held), status: "asked" as const }) }],
      confirm: (res, meta) => { const v = shape(res); s.apply<PrimerEntity>(key, v.rev, v, "wire", { epoch: meta.epoch, stamp: meta.rev }); },
    };
  },
};

export const primers = {
  ask: (board: string, rid: string, s: Store = roomStore, m: Mutator = mutator) => m.mutate(primerOps.ask(board, rid, s)),
};
