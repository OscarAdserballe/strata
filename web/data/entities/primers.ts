import { fetched } from "../api.ts";
import { store as roomStore, type Fetcher, type Store } from "../store.ts";
import { mutator, type Mutator, type Op } from "../mutate.ts";
import { revOf } from "./boards.ts";

// A source's primer: whether one is asked for, written or stale. Its page is served on its own, never through the store.

export type PrimerStatus = "none" | "requested" | "ready" | "stale";
export interface PrimerEntity { status: PrimerStatus; requestedAt: number | null; builtAt: number | null; rev: number; dispatch?: boolean }
export interface PrimerAnswer { primer: PrimerEntity }
export interface BoardPrimersAnswer { queued: string[] }

export const primerKey = (rid: string) => `primer:${rid}`;
/** Every primer on a board: the board's press marks them all stale at once. */
export const primersTag = (board: string) => `primers:${board}`;
export const primerPath = (board: string, rid: string) => `/api/boards/${board}/resources/${rid}/primer`;

export const primerRead = (board: string, rid: string): Fetcher<PrimerEntity> => () =>
  fetched<{ primer: PrimerEntity; dispatch?: boolean }>(primerPath(board, rid), (v) => revOf(v?.primer?.rev))
    .then((f) => ({ ...f, value: { ...f.value.primer, dispatch: !!f.value.dispatch } }));

export const primerOps = {
  request(board: string, rid: string, s: Store = roomStore): Op<PrimerAnswer> {
    const key = primerKey(rid);
    return {
      label: "ask for a primer",
      lanes: [key],
      method: "POST",
      path: primerPath(board, rid),
      body: {},
      // the routine may write the page before the answer lands, so the answer is never the last word
      invalidates: [key],
      optimistic: [{ key, apply: (held: PrimerEntity | undefined) => ({ requestedAt: null, builtAt: null, rev: 0, ...held, status: "requested" }) }],
      confirm: (res, meta) => {
        const p = res?.primer;
        if (p) s.apply<PrimerEntity>(key, revOf(p.rev), { ...s.get<PrimerEntity>(key), ...p }, "wire", { epoch: meta.epoch, stamp: meta.rev });
      },
    };
  },
  requestBoard(board: string): Op<BoardPrimersAnswer> {
    return { label: "ask for this board's primers", lanes: [primersTag(board)], method: "POST", path: `/api/boards/${board}/primers`, body: {}, invalidates: [primersTag(board)] };
  },
};

export const primers = {
  request: (board: string, rid: string, m: Mutator = mutator) => m.mutate(primerOps.request(board, rid)),
  requestBoard: (board: string, m: Mutator = mutator) => m.mutate(primerOps.requestBoard(board)),
};
