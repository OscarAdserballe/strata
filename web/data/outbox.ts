// What this device owes the server: writes made offline wait here under their receipts, and the ones that met a newer text wait as clashes.
import { mintKey, mutator as roomMutator, type Mutator, type Op, type SaveError } from "./mutate.ts";

/** Where unconfirmed writes wait, so a tab closed on the plane still owes them on the next open. */
export interface Shelf { put(id: string, value: string): void; drop(id: string): void; all(): string[] }

export function localShelf(prefix: string): Shelf {
  return {
    put: (id, value) => { try { localStorage.setItem(prefix + id, value); } catch { /* private window or full: the write still rides the tab */ } },
    drop: (id) => { try { localStorage.removeItem(prefix + id); } catch { /* no storage */ } },
    all: () => {
      const out: string[] = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(prefix)) out.push(localStorage.getItem(k) ?? ""); } }
      catch { /* no storage */ }
      return out;
    },
  };
}
export const noShelf: Shelf = { put: () => {}, drop: () => {}, all: () => [] };
const hasStorage = typeof localStorage !== "undefined";

export interface Where { board: string; title?: string; source: string | null; passage: string | null }
export interface Clash { id: string; kind: string; where: Where; mine: string; theirs: string; rev: number; at: number; args: unknown }
export type ClashDraft = Omit<Clash, "id" | "kind" | "at">;

export interface Kind<A> {
  /** The op again, from what was shelved: a reopened tab replays it under the same receipt. */
  build(args: A): Op<any>;
  /** A whole-document write: only the newest shelved entry per this key is replayed. */
  collapse?(args: A): string;
  /** A write that waited offline and was refused: two versions of one text, or null when it is not one. */
  clash?(e: SaveError, args: A): ClashDraft | null;
  /** Keep mine: what to send over the newer revision. */
  over?(clash: Clash): A;
  /** The receipt it is sent under, when the act names its own (a second press of one draft is the same write); else minted. */
  key?(args: A): string | undefined;
  /** Out of retries, its lanes are released (Mutator.release) rather than held. */
  release?: boolean;
}

interface Entry { kind: string; key: string; at: number; n: number; args: unknown; offline: boolean }
export interface OutboxState { waiting: number; synced: number; clashes: readonly Clash[] }
/** A screen that holds the clashed text itself settles it there; false leaves it to the outbox. */
export type Resolver = (clash: Clash, how: "mine" | "theirs") => boolean;

const parse = <T>(raw: string): T | null => { try { return JSON.parse(raw) as T; } catch { return null; } };
const shelfId = (e: { kind: string; key: string }) => `${e.kind}.${e.key}`;

export class Outbox {
  private readonly kinds = new Map<string, Kind<any>>();
  private readonly resolvers = new Map<string, Resolver>();
  private readonly live = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private clashList: Clash[] | null = null;
  private synced = 0;
  private n = 0;
  private state: OutboxState;
  private readonly m: Mutator;
  private readonly shelf: Shelf;
  private readonly clashShelf: Shelf;
  private readonly now: () => number;

  constructor(m: Mutator = roomMutator, shelf: Shelf = hasStorage ? localShelf("strata.outbox.") : noShelf,
    clashShelf: Shelf = hasStorage ? localShelf("strata.clash.") : noShelf, now: () => number = Date.now) {
    this.m = m; this.shelf = shelf; this.clashShelf = clashShelf; this.now = now;
    this.state = { waiting: 0, synced: 0, clashes: this.clashes() };
  }

  kind<A>(name: string, spec: Kind<A>): void { this.kinds.set(name, spec); }
  resolver(kind: string, fn: Resolver): void { this.resolvers.set(kind, fn); }

  /** Shelves the write under a fresh receipt and sends it; `op` is this tab's own, `args` what a reopen rebuilds it from. */
  send<Res>(kind: string, args: unknown, op?: Op<Res>): Promise<Res> {
    const spec = this.spec(kind);
    const entry: Entry = { kind, key: spec.key?.(args) ?? mintKey(), at: this.now(), n: ++this.n, args, offline: this.m.offline() };
    this.shelf.put(shelfId(entry), JSON.stringify(entry));
    return this.run(entry, (op ?? spec.build(args)) as Op<unknown>) as Promise<Res>;
  }

  /** Puts back on their lanes, in the order they were made, the writes an earlier tab never heard confirmed. */
  restore(): number {
    const entries = this.shelf.all().map((raw) => parse<Entry>(raw))
      .filter((e): e is Entry => !!e && typeof e.key === "string" && typeof e.kind === "string" && this.kinds.has(e.kind) && !this.live.has(e.key))
      .sort((a, b) => a.at - b.at || a.n - b.n);
    const newest = new Map<string, Entry>();
    for (const e of entries) { const c = this.kinds.get(e.kind)!.collapse?.(e.args as never); if (c !== undefined) newest.set(`${e.kind}|${c}`, e); }
    let restored = 0;
    for (const e of entries) {
      const c = this.kinds.get(e.kind)!.collapse?.(e.args as never);
      if (c !== undefined && newest.get(`${e.kind}|${c}`) !== e) { this.shelf.drop(shelfId(e)); continue; }
      // it waited out a closed tab, so a newer text met on replay is a clash, not a typo of the last minute
      void this.run({ ...e, offline: true }, this.kinds.get(e.kind)!.build(e.args)).catch(() => {});
      restored++;
    }
    return restored;
  }

  /** Keep mine sends my text over theirs through the save path; keep theirs drops mine. */
  resolve(id: string, how: "mine" | "theirs"): Promise<unknown> {
    const clash = this.clashes().find((c) => c.id === id);
    if (!clash) return Promise.resolve(null);
    this.forget(id);
    if (this.resolvers.get(clash.kind)?.(clash, how)) return Promise.resolve(null);
    const over = this.kinds.get(clash.kind)?.over;
    if (how === "theirs" || !over) return Promise.resolve(null);
    return this.send(clash.kind, over(clash));
  }

  clashes(): readonly Clash[] {
    this.clashList ??= this.clashShelf.all().map((raw) => parse<Clash>(raw)).filter((c): c is Clash => !!c && typeof c.id === "string")
      .sort((a, b) => a.at - b.at);
    return this.clashList;
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = (): OutboxState => this.state;

  private spec(kind: string): Kind<unknown> {
    const spec = this.kinds.get(kind);
    if (!spec) throw new Error(`no outbox kind "${kind}"`);
    return spec;
  }

  private run(entry: Entry, built: Op<unknown>): Promise<unknown> {
    const spec = this.spec(entry.kind);
    const op: Op<unknown> = { ...built, key: entry.key, waitsOffline: true };
    this.live.set(entry.key, entry);
    this.changed();
    const sent = spec.release ? this.m.release(op) : this.m.mutate(op);
    return sent.then((res) => {
      this.live.delete(entry.key);
      this.shelf.drop(shelfId(entry));
      if (entry.offline) this.synced++;
      this.changed();
      return res;
    }, (e: SaveError) => {
      this.live.delete(entry.key);
      // out of retries, or never on the wire: the next open sends it again under the same receipt
      if (!e?.retryable && e?.status !== 0) this.shelf.drop(shelfId(entry));
      const draft = entry.offline && e?.conflict ? spec.clash?.(e, entry.args) ?? null : null;
      if (draft) {
        this.add({ ...draft, id: entry.key, kind: entry.kind, at: this.now() });
        Object.assign(e, { clashed: true });
      }
      this.changed();
      throw e;
    });
  }

  private add(clash: Clash): void {
    this.clashShelf.put(clash.id, JSON.stringify(clash));
    this.clashList = [...this.clashes().filter((c) => c.id !== clash.id), clash];
  }

  private forget(id: string): void {
    this.clashShelf.drop(id);
    this.clashList = this.clashes().filter((c) => c.id !== id);
    this.changed();
  }

  private changed(): void {
    const next = { waiting: this.live.size, synced: this.synced, clashes: this.clashes() };
    if (next.waiting === this.state.waiting && next.synced === this.state.synced && next.clashes === this.state.clashes) return;
    this.state = next;
    for (const fn of [...this.listeners]) fn();
  }
}

export const outbox = new Outbox();
