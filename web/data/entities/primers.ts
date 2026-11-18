import { fetched } from "../api.ts";
import { sameData, store as roomStore, type Fetcher, type Store } from "../store.ts";
import type { Op } from "../mutate.ts";
import { revOf } from "./boards.ts";

// A source's primer: the overview page the reader's routine writes. The page itself is served sandboxed, never stored here.

export type PrimerStatus = "none" | "requested" | "ready" | "stale";
export interface PrimerEntity { status: PrimerStatus; requestedAt: number | null; builtAt: number | null; hasPage: boolean; rev: number }

export const primerKey = (rid: string) => `primer:${rid}`;
const pathOf = (board: string, rid: string) => `/api/boards/${board}/resources/${rid}/primer`;
const STATUSES: PrimerStatus[] = ["none", "requested", "ready", "stale"];

const shape = (v: Partial<PrimerEntity> | undefined): PrimerEntity => ({
  status: STATUSES.includes(v?.status as PrimerStatus) ? v!.status as PrimerStatus : "none",
  requestedAt: typeof v?.requestedAt === "number" ? v.requestedAt : null,
  builtAt: typeof v?.builtAt === "number" ? v.builtAt : null,
  hasPage: v?.hasPage === true,
  rev: revOf(v?.rev),
});

export const primerRead = (board: string, rid: string): Fetcher<PrimerEntity> => () =>
  fetched<PrimerEntity>(pathOf(board, rid), (v) => revOf(v?.rev)).then((f) => ({ ...f, value: shape(f.value) }));

/** Reads again for a poll, and touches the store only when something changed. */
export async function primerRecheck(board: string, rid: string, s: Store = roomStore): Promise<PrimerEntity | undefined> {
  const f = await primerRead(board, rid)();
  if (!sameData(f.value, s.get<PrimerEntity>(primerKey(rid)))) s.apply<PrimerEntity>(primerKey(rid), f.rev, f.value, f.origin, { epoch: f.epoch, stamp: f.stamp });
  return s.get<PrimerEntity>(primerKey(rid));
}

export const primerOps = {
  /** Asks the routine for one; what the source has shows until the new page lands. */
  request(board: string, rid: string, s: Store = roomStore): Op<PrimerEntity> {
    const key = primerKey(rid);
    return {
      label: "ask for a primer",
      lanes: [key],
      method: "POST",
      path: pathOf(board, rid),
      optimistic: [{ key, apply: (held: PrimerEntity | undefined) => ({ ...shape(held), status: "requested", requestedAt: Date.now() }) }],
      confirm: (res, meta) => {
        const v = shape(res);
        s.apply<PrimerEntity>(key, v.rev, v, "wire", { epoch: meta.epoch, stamp: meta.rev });
      },
    };
  },
};
