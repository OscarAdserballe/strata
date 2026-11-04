import { useCallback, useRef, useSyncExternalStore } from "react";

/* Client cache of server data: one entry per key, optimistic layers folded over the confirmed base.
   - An older answer arriving late is dropped; an equal rev replaces.
   - The offline (shelf) copy never replaces a wire answer.
   - A new server epoch resets the ordering.
   - When an op confirms, its answer becomes the base and its layer goes in the same notification.
   - A write marks queries stale when it starts; answers stamped below its settled stamp are discarded. */

export type Origin = "wire" | "shelf" | "optimistic";

export interface Layer<T = unknown> {
  op: string;
  order: number;
  apply: (v: T) => T;
}

export interface Entry<T = unknown> {
  /** False while nothing confirmed is held (only layers, or only a failed read). */
  held: boolean;
  base: T | undefined;
  /** Ordering rev: the scope's rev, or X-Strata-Rev for a query; 0 when the server sent none. */
  rev: number;
  /** X-Strata-Rev of the answer the base came from. */
  stamp: number;
  epoch: string;
  origin: "wire" | "shelf";
  at: number;
  stale: boolean;
  error: unknown;
  /** Rows read in two epochs after a refusal crossed a restore; cleared when a whole value is applied. */
  mixed: boolean;
  layers: readonly Layer<T>[];
  view: T | undefined;
}

export interface ApplyMeta {
  epoch?: string;
  stamp?: number;
  /** Keeps the held base (and the view's identity) when the incoming value is the same data. */
  equal?: (held: unknown, next: unknown) => boolean;
}

export interface Fetched<T> {
  value: T;
  rev: number;
  epoch: string;
  origin: "wire" | "shelf";
  /** Never taken from `rev`: a scope's rev sits below the stamp and would discard every later read. */
  stamp: number;
}
export type Fetcher<T> = () => Promise<Fetched<T>>;

export interface StoreOptions { now?: () => number }

const EMPTY: readonly Layer[] = Object.freeze([]);

export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export class Store {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly queries = new Map<string, { fetch: Fetcher<unknown>; tags: readonly string[] }>();
  private readonly inflight = new Map<string, { seq: number; promise: Promise<void> }>();
  /** key â†’ the stamp below which an answer predates a write this device saw settle */
  private readonly floors = new Map<string, { stamp: number; epoch: string; seq: number }>();
  private readonly staleBy = new Map<string, Set<string>>();
  /** key â†’ seq of the last op-less invalidation; a read that left before it cannot have seen the change */
  private readonly changedAt = new Map<string, number>();
  private readonly dirty = new Set<string>();
  private depth = 0;
  private seq = 0;
  private readonly now: () => number;

  constructor(o: StoreOptions = {}) { this.now = o.now ?? Date.now; }

  get<T>(key: string): T | undefined { return this.entries.get(key)?.view as T | undefined; }
  entry<T>(key: string): Entry<T> | undefined { return this.entries.get(key) as Entry<T> | undefined; }

  subscribe(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, set = new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  private watched(key: string): boolean { return (this.listeners.get(key)?.size ?? 0) > 0; }

  /** One notification per key, so an op's confirmed value and its layer's removal never render apart. */
  batch<R>(fn: () => R): R {
    this.depth++;
    try { return fn(); }
    finally {
      if (--this.depth === 0) {
        const keys = [...this.dirty];
        this.dirty.clear();
        for (const key of keys) this.emit(key);
      }
    }
  }

  private changed(key: string): void {
    if (this.depth) this.dirty.add(key);
    else this.emit(key);
  }

  private emit(key: string): void {
    const set = this.listeners.get(key);
    if (set) for (const fn of [...set]) fn();
  }

  apply<T>(key: string, rev: number, value: T, origin: "wire" | "shelf", meta?: ApplyMeta): boolean;
  apply<T>(key: string, rev: null, change: T | ((v: T) => T), origin: "optimistic", meta: { op: string; order?: number }): () => void;
  apply<T>(key: string, rev: number | null, value: unknown, origin: Origin, meta: ApplyMeta & { op?: string; order?: number } = {}): boolean | (() => void) {
    if (origin === "optimistic") return this.layer<T>(key, value as T | ((v: T) => T), meta.op ?? "", meta.order);
    const held = this.entries.get(key);
    const epoch = meta.epoch ?? "";
    const stamp = meta.stamp;
    if (!this.accepts(key, held, rev ?? 0, origin, epoch, stamp)) return false;
    if (held && held.epoch !== epoch) this.floors.delete(key);
    const pending = (this.staleBy.get(key)?.size ?? 0) > 0;
    const same = !!held?.held && !!meta.equal && meta.equal(held.base, value);
    this.write(key, {
      held: true, base: same ? held!.base : value, rev: rev ?? 0, stamp: stamp ?? rev ?? 0, epoch, origin, at: this.now(),
      // a wire answer clears the mark unless a write that made it stale is still out
      stale: pending || (origin === "shelf" ? !!held?.stale : false),
      error: undefined,
      mixed: false,
    });
    return true;
  }

  private accepts(key: string, held: Entry | undefined, rev: number, origin: "wire" | "shelf", epoch: string, stamp: number | undefined): boolean {
    // the offline copy never replaces a wire answer, of any epoch: it is old by definition
    if (origin === "shelf") return !held?.held || held.origin === "shelf";
    // an answer computed before a write this device saw settle is older than the write
    const floor = this.floors.get(key);
    if (floor && stamp !== undefined && floor.epoch === epoch && stamp < floor.stamp) return false;
    if (!held?.held || held.origin === "shelf" || held.epoch !== epoch) return true;
    return held.rev <= rev;
  }

  /** Folds a confirmed row into a list; with `ordered`, a refusal older than what is held is dropped. */
  patch<T>(key: string, rev: number, fn: (v: T) => T, meta: ApplyMeta & { ordered?: true | ((v: T) => number | undefined) } = {}): boolean {
    const held = this.entries.get(key);
    const o = meta.ordered;
    if (!held?.held) return false;
    const rows = typeof o === "function";
    if (o && held.epoch === meta.epoch && !(rows && held.mixed) && (rows ? o(held.base as T) ?? held.rev : held.rev) > rev) return false;
    const epoch = meta.epoch ?? held.epoch;
    const same = epoch === held.epoch;
    this.write(key, {
      base: fn(held.base as T),
      rev: same ? Math.max(held.rev, rev) : rev,
      stamp: same ? Math.max(held.stamp, meta.stamp ?? 0) : (meta.stamp ?? rev),
      epoch, at: this.now(),
      mixed: held.mixed || (rows && !same),
    });
    return true;
  }

  /** An optimistic change is a layer over the base, removed when its op confirms or fails. */
  private layer<T>(key: string, change: T | ((v: T) => T), op: string, order = Number.MAX_SAFE_INTEGER): () => void {
    const fn = typeof change === "function" ? change as (v: T) => T : () => change;
    const layer: Layer<T> = { op, order, apply: fn };
    const held = this.entries.get(key);
    const layers = [...(held?.layers ?? EMPTY)] as Layer<T>[];
    // stable insert by op order: a coalesced or rebuilt op keeps its place among the others
    let at = layers.length;
    while (at > 0 && layers[at - 1].order > order) at--;
    layers.splice(at, 0, layer);
    this.write(key, { layers: layers as Layer<unknown>[] });
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const now = this.entries.get(key);
      if (!now) return;
      this.write(key, { layers: now.layers.filter((l) => l !== layer) });
    };
  }

  /** The view is refolded only when the base or layers moved, so its identity is stable for useSyncExternalStore. */
  private write(key: string, next: Partial<Entry>): void {
    const was = this.entries.get(key);
    const entry: Entry = {
      held: false, base: undefined, rev: 0, stamp: 0, epoch: "", origin: "wire", at: 0,
      stale: false, error: undefined, mixed: false, layers: EMPTY, view: undefined,
      ...was, ...next,
    };
    entry.view = was && was.base === entry.base && was.layers === entry.layers
      ? was.view
      : entry.layers.reduce((v, l) => l.apply(v), entry.base);
    this.entries.set(key, entry);
    this.changed(key);
  }

  watch(key: string, listener: () => void, fetch?: Fetcher<unknown>, tags: readonly string[] = []): () => void {
    if (fetch) this.queries.set(key, { fetch, tags });
    const off = this.subscribe(key, listener);
    const held = this.entries.get(key);
    const waiting = (this.staleBy.get(key)?.size ?? 0) > 0;
    if (fetch && (!held?.held || (held.stale && !waiting))) void this.refetch(key);
    return off;
  }

  refetch(key: string): Promise<void> {
    const query = this.queries.get(key);
    if (!query) return Promise.resolve();
    const running = this.inflight.get(key);
    if (running) return running.promise;
    const seq = ++this.seq;
    const done = () => { if (this.inflight.get(key)?.seq === seq) this.inflight.delete(key); };
    const promise = query.fetch().then((res) => {
      done();
      const stamp = res.stamp;
      // a read that left before an op-less change may still be newer, but it cannot clear the stale mark
      const changed = this.changedAt.get(key) ?? 0;
      if (seq < changed) {
        this.batch(() => {
          if (this.apply(key, res.rev, res.value, res.origin, { epoch: res.epoch, stamp })) this.write(key, { stale: true });
          if (this.watched(key)) void this.refetch(key);
        });
        return;
      }
      if (changed) this.changedAt.delete(key);
      if (this.apply(key, res.rev, res.value, res.origin, { epoch: res.epoch, stamp }) || res.origin !== "wire") return;
      // left before a write settled and came back below its stamp: ask once more (no loop for later reads)
      const floor = this.floors.get(key);
      if (floor && floor.epoch === res.epoch && stamp < floor.stamp && seq < floor.seq && this.watched(key)) void this.refetch(key);
    }, (error: unknown) => {
      done();
      this.write(key, { error });
    });
    this.inflight.set(key, { seq, promise });
    return promise;
  }

  private tagged(key: string, tags: ReadonlySet<string>): boolean {
    if (tags.has(key)) return true;
    const query = this.queries.get(key);
    return !!query && query.tags.some((t) => tags.has(t));
  }

  /** Marks keys stale; with `op`, settle() decides what follows, without it watched queries refetch now. */
  invalidate(tags: readonly string[], op?: string): void {
    if (!tags.length) return;
    const wanted = new Set(tags);
    const keys = new Set([...this.entries.keys(), ...this.queries.keys(), ...wanted]);
    const seq = ++this.seq;
    this.batch(() => {
      for (const key of keys) {
        if (!this.tagged(key, wanted)) continue;
        if (op) {
          let ops = this.staleBy.get(key);
          if (!ops) this.staleBy.set(key, ops = new Set());
          ops.add(op);
        } else if (this.queries.has(key)) this.changedAt.set(key, seq);
        const held = this.entries.get(key);
        if (held && !held.stale) this.write(key, { stale: true });
        if (!op && this.watched(key)) void this.refetch(key);
      }
    });
  }

  /** Succeeded at `stamp`: older answers are discarded and stale keys refetched; `null` means nothing changed. */
  settle(op: string, stamp: number | null, epoch = ""): void {
    const seq = ++this.seq;
    this.batch(() => {
      for (const [key, ops] of [...this.staleBy]) {
        if (!ops.delete(op)) continue;
        if (!ops.size) this.staleBy.delete(key);
        if (stamp === null) continue;
        const floor = this.floors.get(key);
        if (!floor || floor.epoch !== epoch || floor.stamp < stamp) this.floors.set(key, { stamp, epoch, seq });
        const held = this.entries.get(key);
        const fresh = stamp > 0 && !!held?.held && held.origin === "wire" && held.epoch === epoch && held.stamp >= stamp;
        if (fresh) { if (!ops.size && held.stale) this.write(key, { stale: false }); }
        else if (this.watched(key)) void this.refetch(key);
      }
    });
  }
}

export const store = new Store();

function useView<T, S>(s: Store, key: string, subscribe: (cb: () => void) => () => void, select?: (v: T | undefined) => S): S {
  const memo = useRef<{ key: string; view: unknown; out: S } | null>(null);
  const read = (): S => {
    const view = s.get<T>(key);
    if (!select) return view as S;
    const m = memo.current;
    if (m && m.key === key && m.view === view) return m.out;
    const out = select(view);
    memo.current = { key, view, out };
    return out;
  };
  return useSyncExternalStore(subscribe, read, read);
}

/** One key's visible value, or `select` of it; `select` must depend on the view alone. */
export function useEntity<T, S = T | undefined>(key: string, select?: (v: T | undefined) => S, s: Store = store): S {
  const subscribe = useCallback((cb: () => void) => s.subscribe(key, cb), [s, key]);
  return useView(s, key, subscribe, select);
}

/** A query's value, asked for when first watched or when a settled write left it stale. */
export function useQuery<T, S = T | undefined>(key: string, fetch: Fetcher<T>, opts: { tags?: readonly string[]; select?: (v: T | undefined) => S } = {}, s: Store = store): S {
  const latest = useRef(fetch);
  latest.current = fetch;
  const tags = (opts.tags ?? []).join("\n");
  const subscribe = useCallback(
    (cb: () => void) => s.watch(key, cb, () => latest.current(), tags ? tags.split("\n") : []),
    [s, key, tags],
  );
  return useView(s, key, subscribe, opts.select);
}

/** The entry itself (origin, `at`, `stale`, `error`); a new object on every change to the key. */
export function useEntry<T>(key: string, s: Store = store): Entry<T> | undefined {
  const subscribe = useCallback((cb: () => void) => s.subscribe(key, cb), [s, key]);
  const read = () => s.entry<T>(key);
  return useSyncExternalStore(subscribe, read, read);
}
