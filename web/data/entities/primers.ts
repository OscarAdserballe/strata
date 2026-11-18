import { fetched } from "../api.ts";
import { sameData, store as roomStore, type Fetcher, type Store } from "../store.ts";
import { mutator, type Mutator, type Op } from "../mutate.ts";

// A source's primer: whether one is asked for, written or out of date. Its page is served live and never held here.

export type PrimerStatus = "none" | "requested" | "ready" | "stale";
export interface PrimerEntity { status: PrimerStatus; requestedAt: number | null; builtAt: number | null }

export const primerKey = (rid: string) => `primer:${rid}`;
export const primerLane = (rid: string) => `primer:${rid}`;
const pathOf = (board: string, rid: string) => `/api/boards/${board}/resources/${rid}/primer`;

const STATUSES: readonly PrimerStatus[] = ["none", "requested", "ready", "stale"];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const asPrimer = (v: unknown): PrimerEntity => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { status: STATUSES.includes(o.status as PrimerStatus) ? o.status as PrimerStatus : "none", requestedAt: num(o.requestedAt), builtAt: num(o.builtAt) };
};

export const primerRead = (board: string, rid: string): Fetcher<PrimerEntity> => () =>
  fetched<unknown>(pathOf(board, rid)).then((f) => ({ ...f, value: asPrimer(f.value) }));

export const primerOps = {
  request(board: string, rid: string, s: Store = roomStore): Op<unknown> {
    const key = primerKey(rid);
    return {
      label: "ask for a primer",
      lanes: [primerLane(rid)],
      method: "POST",
      path: pathOf(board, rid),
      body: {},
      optimistic: [{ key, apply: (held: PrimerEntity | undefined) => ({ requestedAt: Date.now(), builtAt: null, ...held, status: "requested" }) }],
      confirm: (res, meta) => { s.apply<PrimerEntity>(key, meta.rev, asPrimer(res), "wire", { epoch: meta.epoch, stamp: meta.rev }); },
    };
  },
};

export const primers = {
  request: (board: string, rid: string, s: Store = roomStore, m: Mutator = mutator) => m.mutate(primerOps.request(board, rid, s)),
  /** Read again; when nothing changed the view keeps its identity, so nothing renders. */
  async reread(board: string, rid: string, s: Store = roomStore): Promise<PrimerEntity | undefined> {
    const f = await primerRead(board, rid)();
    s.apply<PrimerEntity>(primerKey(rid), f.rev, f.value, f.origin, { epoch: f.epoch, stamp: f.stamp, equal: sameData });
    return s.get<PrimerEntity>(primerKey(rid));
  },
};
