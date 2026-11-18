import { fetched, StrataPath } from "../api.ts";
import { store as roomStore, sameData, type Fetcher, type Store } from "../store.ts";
import { mutator as roomMutator, type Mutator, type Op } from "../mutate.ts";

// A source's primer: the page Claude writes about it, read before page 1. The page itself loads in a sandboxed frame.

export type PrimerStatus = "none" | "asked" | "ready" | "stale";
export interface Primer { status: PrimerStatus; askedAt: number | null; builtAt: number | null; page: boolean }

const NONE: Primer = { status: "none", askedAt: null, builtAt: null, page: false };
const STATUSES: readonly PrimerStatus[] = ["none", "asked", "ready", "stale"];
export const primerOf = (v: unknown): Primer => {
  const p = (v ?? {}) as Partial<Primer>;
  return {
    status: STATUSES.includes(p.status as PrimerStatus) ? p.status as PrimerStatus : "none",
    askedAt: typeof p.askedAt === "number" ? p.askedAt : null,
    builtAt: typeof p.builtAt === "number" ? p.builtAt : null,
    page: p.page === true,
  };
};

export const primerKey = (rid: string) => `primer:${rid}`;
const pathOf = (board: string, rid: string) => `/api/boards/${board}/resources/${rid}/primer`;
export const primerPageUrl = (board: string, rid: string, builtAt: number | null) =>
  StrataPath(`${pathOf(board, rid)}/page${builtAt ? `?v=${builtAt}` : ""}`);

export const primerRead = (board: string, rid: string): Fetcher<Primer> => () =>
  fetched<Primer>(pathOf(board, rid)).then((f) => ({ ...f, value: primerOf(f.value) }));

export const primerOps = {
  ask(board: string, rid: string, s: Store = roomStore, now: () => number = Date.now): Op<Primer> {
    const key = primerKey(rid);
    return {
      label: "ask for a primer",
      lanes: [`primer:${rid}`],
      method: "POST",
      path: pathOf(board, rid),
      body: {},
      optimistic: [{ key, apply: (held: Primer | undefined) => ({ ...(held ?? NONE), status: "asked", askedAt: now() }) }],
      confirm: (res, meta) => { s.apply<Primer>(key, meta.rev, primerOf(res), "wire", { epoch: meta.epoch, stamp: meta.rev }); },
    };
  },
};

export const primers = {
  ask: (board: string, rid: string, s: Store = roomStore, m: Mutator = roomMutator): Promise<Primer> => m.mutate(primerOps.ask(board, rid, s)),
  /** A poll's read: an answer with nothing new keeps the held value, so nothing re-renders. */
  async refresh(board: string, rid: string, s: Store = roomStore): Promise<void> {
    const f = await primerRead(board, rid)();
    s.apply<Primer>(primerKey(rid), f.rev, f.value, f.origin, { epoch: f.epoch, stamp: f.stamp, equal: sameData });
  },
};
