import { fetched } from "../api.ts";
import { store as roomStore, type Fetcher, type Store } from "../store.ts";
import { mutator, type Mutator, type Op } from "../mutate.ts";
import { revOf } from "./boards.ts";

// What a live page kept with window.strata.save: one JSON value per source, replaced whole, last save wins.

export interface PageStateEntity { value: string | null; rev: number }
export interface PageStateAnswer { rev?: number }

export const pageStateKey = (rid: string) => `pagestate:${rid}`;
export const pageStateLane = (rid: string) => `pagestate:${rid}`;
const pathOf = (board: string, rid: string) => `/api/boards/${board}/resources/${rid}/state`;

export const pageStateRead = (board: string, rid: string): Fetcher<PageStateEntity> => () =>
  fetched<PageStateEntity>(pathOf(board, rid), (v) => revOf(v?.rev))
    .then((f) => ({ ...f, value: { value: typeof f.value?.value === "string" ? f.value.value : null, rev: revOf(f.value?.rev) } }));

export const pageStateOps = {
  save(board: string, rid: string, value: string, s: Store = roomStore): Op<PageStateAnswer | null> {
    const key = pageStateKey(rid);
    return {
      label: "save the page",
      lanes: [pageStateLane(rid)],
      method: "PUT",
      path: pathOf(board, rid),
      body: { value },
      base: () => s.entry<PageStateEntity>(key)?.base?.rev ?? null,
      optimistic: [{ key, apply: (held: PageStateEntity | undefined) => ({ rev: 0, ...held, value }) }],
      takeConflict: { key, fold: (_held, c) => ({ value: ((c.value as { value?: unknown })?.value as string | null) ?? null, rev: c.rev }) },
      // the page saves its whole state each time, so the newest save is the one to keep
      onConflict: () => pageStateOps.save(board, rid, value, s),
      coalesce: pageStateLane(rid),
      flush: true,
      confirm: (res, meta) => {
        const rev = revOf(res?.rev ?? s.entry<PageStateEntity>(key)?.base?.rev);
        s.apply<PageStateEntity>(key, rev, { value, rev }, "wire", { epoch: meta.epoch, stamp: meta.rev });
      },
    };
  },
};

export const pageState = {
  /** Reads afresh each time a page asks (another tab may have saved); a failed read falls back to what the store holds. */
  async load(board: string, rid: string, s: Store = roomStore): Promise<string | null> {
    const key = pageStateKey(rid);
    try {
      const f = await pageStateRead(board, rid)();
      s.apply<PageStateEntity>(key, f.rev, f.value, f.origin, { epoch: f.epoch, stamp: f.stamp });
    } catch (e) {
      if (!s.entry<PageStateEntity>(key)?.held) throw e;
    }
    return s.get<PageStateEntity>(key)?.value ?? null;
  },
  async save(board: string, rid: string, value: string, s: Store = roomStore, m: Mutator = mutator): Promise<void> {
    // never over a value it hasn't read: without a base the save would carry no If-Match
    if (!s.entry<PageStateEntity>(pageStateKey(rid))?.held) await pageState.load(board, rid, s);
    await m.mutate(pageStateOps.save(board, rid, value, s));
  },
};
