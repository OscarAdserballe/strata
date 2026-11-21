import { store as roomStore, type Store } from "./store.ts";
import { confirmByShape } from "./entities/confirm.ts";

/* The one save path: every write is an Op handed to mutate().
   - Enqueue refuses at once while the wire is known down, unless the op may wait (offline); else it paints layers and marks queries stale.
   - An op that may wait is kept in the outbox while the wire is down, so a reload resends it under the same key.
   - One that waited and is then refused is written to the outbox's conflicts list, for the person to read.
   - Lanes keep order: an op starts when it heads every lane it names; a failed head holds its lanes.
   - One key per op, minted once and reused on every retry and on the pagehide flush.
   - 2xx confirms; a lost answer, deadline, 408/425/429 or 5xx is retried with backoff, paused while offline.
   - A 409 hands its value to the store and may rebuild the op once; any other 4xx rolls back.
   - A held op paints at once and waits holdMs before it may leave, so withdraw(key) can take it back unsent. */

export interface Conflict { rev: number; value: unknown }

export interface Op<Res = unknown> {
  label: string;
  /** FIFO lanes; an op starts only when it heads every lane it names. */
  lanes: string[];
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  /** Serialized once at enqueue; every attempt resends exactly those bytes. */
  body?: unknown;
  /** A domain id naming exactly one act (never an entity id, which undo/redo reuse); else minted. */
  key?: string;
  /** Document rev for If-Match, read at send time. */
  base?: () => number | null;
  optimistic?: { key: string; apply: (v: any) => any }[];
  confirm?: (res: Res, meta: { rev: number; epoch: string }) => void;
  invalidates?: string[];
  /** Where a 409's current value is folded into the store before onConflict runs. */
  takeConflict?: { key: string; fold: (held: any, conflict: Conflict) => any; rev?: (held: any) => number | undefined };
  /** A new op to send instead, at the head of its lanes; null fails the op. */
  onConflict?: (conflict: Conflict, epoch: string) => Op<Res> | null;
  coalesce?: string;
  /** Extra statuses treated as "not yet" and retried under the same key (a 401 while signed out). */
  retryOn?: number[];
  /** resent with keepalive on pagehide while unacknowledged (body ≤ 32 KB) */
  flush?: boolean;
  /** Send with keepalive: a save made as the tab hides, which a phone may kill without a pagehide. */
  keepalive?: boolean;
  /** Painted at once, sent no sooner than this: until then withdraw(key) takes it back. A pagehide flush sends it early. */
  holdMs?: number;
  /** May wait out the wire: kept in the outbox while offline and sent on reconnect. */
  offline?: boolean;
}

/** An op as the outbox keeps it: plain data, so a reload can send it again with the same key and bytes. */
export interface SavedOp {
  key: string; label: string; lanes: string[]; method: Op["method"]; path: string;
  body?: string; base?: number | null; invalidates?: string[]; at: number;
}
/** A write that waited offline and was refused once sent: what was asked, and what the server said. */
export interface Unsynced {
  key: string; label: string; method: string; path: string; body?: string;
  status?: number; said: string; server?: unknown; at: number;
}
export interface Outbox {
  put(op: SavedOp): void;
  drop(key: string): void;
  refused(row: Unsynced): void;
}

export type PendingState = "held" | "queued" | "sending" | "retrying" | "failed";
export interface PendingOp {
  id: string; label: string; lanes: string[]; state: PendingState; attempts: number; error: unknown;
  key: string;
}

export interface Failure { id: string; label: string; error: SaveError }

export interface SaveError extends Error {
  status?: number;
  /** exhausted retries: the layers are still showing and retry(id) can send it again */
  retryable?: boolean;
  conflict?: Conflict;
  /** A refusal's X-Strata-Epoch, for a caller that orders the conflict itself. */
  epoch?: string;
  /** taken back with withdraw() inside its hold: nothing was sent */
  withdrawn?: boolean;
}

/** Resolves for every HTTP status; rejects only when no answer came back at all. */
export interface SendRequest {
  method: string;
  path: string;
  body?: string;
  headers: Record<string, string>;
  keepalive?: boolean;
  signal?: AbortSignal;
}
export interface SendAnswer {
  status: number;
  body: unknown;
  rev: number;
  epoch: string;
  replay?: boolean;
}
export type Transport = (req: SendRequest) => Promise<SendAnswer>;

export interface WireState {
  down(): boolean;
  subscribe(changed: () => void): () => void;
}

export interface MutateDeps {
  transport?: Transport;
  store?: Store;
  wire?: WireState;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
  now?(): number;
  clearReads?(): void;
  surface?(failure: Failure): void;
  outbox?: Outbox;
}

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 16000];
/** Past this an attempt is a lost answer, not a slow one. */
export const ATTEMPT_DEADLINE_MS = 20_000;
export const FLUSH_MAX_BODY = 32 * 1024;
export const KEEPALIVE_BUDGET = 64 * 1024;
export const KEEPALIVE_MAX_BODY = 60_000;

/** Not randomUUID, which insecure (plain-http) contexts lack. */
export function mintKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function saveError(message: string, extra: Partial<SaveError> = {}): SaveError {
  return Object.assign(new Error(message), extra);
}
const offline = () => saveError("offline — read only", { status: 0 });
const bytes = (s: string | undefined) => (s === undefined ? 0 : new TextEncoder().encode(s).length);
const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

interface Waiter { resolve(v: unknown): void; reject(e: unknown): void }
interface Item {
  id: string;
  seq: number;
  op: Op<unknown>;
  key: string;
  body: string | undefined;
  state: PendingState;
  attempts: number;
  /** Has left at least once, so it can no longer be coalesced away. */
  sent: boolean;
  error: unknown;
  removers: (() => void)[];
  waiters: Waiter[];
  timer: unknown;
  due: number | null;
  /** A retry's wait left over while the wire is down (paused, not spent). */
  remaining: number | null;
  conflicts: number;
  /** Keepalive requests out now; they outlive the page, so a flush leaves the op be. */
  carrying: number;
  /** Still inside its hold: painted, not yet allowed on the wire. */
  holding: boolean;
  holdTimer: unknown;
  /** The key the outbox holds it under; set once it has waited on the wire. */
  saved: string | null;
}

export class Mutator {
  private items: Item[] = [];
  /** Writers owing text outside the save path; the unsaved prompt asks them too. */
  private readonly holders = new Set<() => boolean>();
  private rearm: () => void = () => {};
  private readonly lanes = new Map<string, Item[]>();
  private readonly listeners = new Set<() => void>();
  private snapshot: PendingOp[] = [];
  private idle: (() => void)[] = [];
  private seq = 0;
  /** Strictly rising, so ops kept in the same millisecond resume in the order they were made. */
  private keptAt = 0;
  /** Bytes of keepalive requests in flight; the browser's 64 KB budget is shared by all of them. */
  private aliveBytes = 0;
  private readonly leaving = new Set<() => void>();
  private d!: Required<Omit<MutateDeps, "transport" | "surface" | "clearReads" | "outbox">> & Pick<MutateDeps, "transport" | "surface" | "clearReads" | "outbox">;
  private offWire: (() => void) | null = null;

  constructor(deps: MutateDeps = {}) { this.configure(deps); }

  configure(deps: MutateDeps): void {
    const was = this.d ?? {
      store: roomStore,
      wire: { down: () => false, subscribe: () => () => {} },
      setTimer: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimer: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>),
      now: Date.now,
    };
    const first = !this.d;
    this.d = { ...was, ...deps };
    if (first || deps.wire) {
      this.offWire?.();
      this.offWire = this.d.wire.subscribe(() => this.wireChanged());
    }
  }

  mutate<Res>(op: Op<Res>): Promise<Res> {
    if (this.d.wire.down() && !op.offline) return Promise.reject(offline());
    if (!this.d.transport) return Promise.reject(saveError("the save path is not wired to data/api.ts yet"));
    return this.enqueue(op, null);
  }

  /** Sends again what a closed tab left in the outbox, under the same keys; one already queued here is skipped. */
  resume(saved: SavedOp[]): void {
    for (const s of [...saved].sort((a, b) => a.at - b.at)) {
      if (this.items.some((i) => i.key === s.key || i.saved === s.key)) continue;
      const op: Op = {
        label: s.label, lanes: s.lanes, method: s.method, path: s.path, key: s.key, offline: true, flush: true,
        ...(s.body === undefined ? {} : { body: JSON.parse(s.body) }),
        ...(typeof s.base === "number" ? { base: () => s.base as number } : {}),
        ...(s.invalidates ? { invalidates: s.invalidates } : {}),
      };
      // nobody is waiting on these: a refusal goes to the conflicts list, not to a caller
      this.enqueue(op, s.key).catch(() => {});
    }
  }

  private enqueue<Res>(op: Op<Res>, saved: string | null): Promise<Res> {
    return new Promise<Res>((resolve, reject) => {
      const waiter = { resolve: resolve as (v: unknown) => void, reject };
      const was = op.coalesce ? this.items.find((i) => i.op.coalesce === op.coalesce && i.state === "queued" && !i.sent) : undefined;
      if (was) {
        this.rebuild(was, op as Op<unknown>, false);
        was.waiters.push(waiter);
      } else {
        const item: Item = {
          id: `op${++this.seq}`, seq: this.seq, op: op as Op<unknown>, key: op.key ?? mintKey(), body: undefined,
          state: "queued", attempts: 0, sent: false, error: null, removers: [], waiters: [waiter],
          timer: null, due: null, remaining: null, conflicts: 0, carrying: 0, holding: false, holdTimer: null, saved,
        };
        if (op.holdMs && op.holdMs > 0) {
          item.holding = true;
          item.holdTimer = this.d.setTimer(() => { item.holding = false; item.holdTimer = null; this.changed(); this.pump(); }, op.holdMs);
        }
        item.body = op.body === undefined ? undefined : JSON.stringify(op.body);
        this.paint(item);
        this.items.push(item);
        if (this.d.wire.down()) this.keep(item);
        for (const lane of op.lanes) {
          let queue = this.lanes.get(lane);
          if (!queue) this.lanes.set(lane, queue = []);
          queue.push(item);
        }
      }
      this.changed();
      this.pump();
    });
  }

  /** Read-only POSTs: no lane, no key, no retry, no registry. */
  async call<Res>(method: string, path: string, body?: unknown): Promise<Res> {
    if (this.d.wire.down()) throw offline();
    if (!this.d.transport) throw saveError("the save path is not wired to data/api.ts yet");
    const text = body === undefined ? undefined : JSON.stringify(body);
    const answer = await this.d.transport({ method, path, body: text, headers: text === undefined ? {} : { "Content-Type": "application/json" } });
    if (answer.status >= 200 && answer.status < 300) return answer.body as Res;
    throw this.refusal(answer);
  }

  private paint(item: Item): void {
    const { store } = this.d;
    store.batch(() => {
      item.removers = (item.op.optimistic ?? []).map((l) => store.apply(l.key, null, l.apply, "optimistic", { op: item.id, order: item.seq }));
      store.invalidate(item.op.invalidates ?? [], item.id);
    });
    this.d.clearReads?.();
  }

  private unpaint(item: Item): void {
    const removers = item.removers;
    item.removers = [];
    this.d.store.batch(() => { for (const remove of removers) remove(); });
  }

  /** Replaces the item's op (coalesced, or rebuilt after a 409): a new request, so a new key. */
  private rebuild(item: Item, op: Op<unknown>, toHead: boolean): void {
    this.unpaint(item);
    const lanesMoved = toHead || op.lanes.join("\n") !== item.op.lanes.join("\n");
    if (lanesMoved) this.leaveLanes(item);
    item.op = op;
    item.key = op.key ?? mintKey();
    item.body = op.body === undefined ? undefined : JSON.stringify(op.body);
    item.attempts = 0;
    item.sent = false;
    item.state = "queued";
    item.error = null;
    if (lanesMoved) for (const lane of op.lanes) {
      let queue = this.lanes.get(lane);
      if (!queue) this.lanes.set(lane, queue = []);
      if (toHead) queue.unshift(item); else queue.push(item);
    }
    this.paint(item);
  }

  private leaveLanes(item: Item): void {
    for (const lane of item.op.lanes) {
      const queue = this.lanes.get(lane);
      if (!queue) continue;
      const at = queue.indexOf(item);
      if (at >= 0) queue.splice(at, 1);
      if (!queue.length) this.lanes.delete(lane);
    }
  }

  private pump(): void {
    if (this.d.wire.down()) return;
    for (const item of [...this.items]) {
      if (item.state !== "queued" || item.holding) continue;
      if (!item.op.lanes.every((lane) => this.lanes.get(lane)?.[0] === item)) continue;
      void this.send(item);
    }
  }

  private request(item: Item, extra: Partial<SendRequest> = {}, ifMatch = true): SendRequest {
    const headers: Record<string, string> = { "Idempotency-Key": item.key };
    if (item.body !== undefined) headers["Content-Type"] = "application/json";
    const base = ifMatch ? item.op.base?.() : null;
    if (typeof base === "number") headers["If-Match"] = `"${base}"`;
    return { method: item.op.method, path: item.op.path, body: item.body, headers, ...extra };
  }

  private behind(item: Item): Item[] {
    const out = new Set<Item>();
    for (const lane of item.op.lanes) {
      const queue = this.lanes.get(lane) ?? [];
      for (const other of queue.slice(queue.indexOf(item) + 1)) out.add(other);
    }
    return [...out].sort((a, b) => a.seq - b.seq);
  }

  private queuedBehindAnother(item: Item): boolean {
    return item.op.lanes.some((lane) => (this.lanes.get(lane)?.indexOf(item) ?? 0) > 0);
  }

  private async send(item: Item): Promise<void> {
    const transport = this.d.transport!;
    item.state = "sending";
    item.attempts++;
    item.sent = true;
    this.changed();
    const controller = new AbortController();
    let timer: unknown = null;
    const LATE = Symbol("late");
    const deadline = new Promise<typeof LATE>((resolve) => {
      timer = this.d.setTimer(() => { resolve(LATE); controller.abort(); }, ATTEMPT_DEADLINE_MS);
    });
    let answer: SendAnswer | typeof LATE | null = null;
    let thrown: unknown = null;
    const size = bytes(item.body);
    const alive = !!item.op.keepalive && size <= KEEPALIVE_MAX_BODY && size <= KEEPALIVE_BUDGET - this.aliveBytes;
    const done = alive ? this.carry(item, size) : () => {};
    try { answer = await Promise.race([transport(this.request(item, { signal: controller.signal, ...(alive ? { keepalive: true } : {}) })), deadline]); }
    catch (e) { thrown = e; }
    finally { this.d.clearTimer(timer); done(); }
    if (!this.items.includes(item)) return;          // discarded meanwhile: nothing to apply

    // our own deadline, however the transport settled on its abort (a fetch rejects at once)
    if (answer === LATE || (!answer && controller.signal.aborted)) {
      return this.later(item, saveError(`${item.op.label} didn't come back after ${ATTEMPT_DEADLINE_MS / 1000}s`));
    }
    if (!answer) {
      // an abort nobody here asked for (the page going away) is not a lost answer to retry
      if ((thrown as Error)?.name === "AbortError") return this.exhaust(item, thrown);
      return this.later(item, thrown);
    }
    if (answer.status >= 200 && answer.status < 300) return this.confirmed(item, answer);
    if (retryableStatus(answer.status) || item.op.retryOn?.includes(answer.status)) return this.later(item, this.refusal(answer));
    const conflict = (answer.body as { conflict?: Conflict } | null)?.conflict;
    if (answer.status === 409 && conflict) return this.conflicted(item, answer, conflict);
    this.fail(item, this.refusal(answer));
  }

  private carry(item: Item, size: number): () => void {
    this.aliveBytes += size;
    item.carrying++;
    let once = false;
    return () => {
      if (once) return;
      once = true;
      this.aliveBytes -= size;
      item.carrying--;
    };
  }

  private refusal(answer: SendAnswer): SaveError {
    const body = answer.body as { error?: string; conflict?: Conflict } | null;
    return saveError(body?.error || `HTTP ${answer.status}`, { status: answer.status, ...(body?.conflict ? { conflict: body.conflict, epoch: answer.epoch } : {}) });
  }

  private confirmed(item: Item, answer: SendAnswer): void {
    const { store } = this.d;
    const meta = { rev: answer.rev, epoch: answer.epoch };
    store.batch(() => {
      try {
        if (item.op.confirm) item.op.confirm(answer.body, meta);
        else confirmByShape(item.op, answer.body, meta, store);
      } catch (e) { console.error("[strata] confirming", item.op.label, e); }
      const removers = item.removers;
      item.removers = [];
      for (const remove of removers) remove();
      store.settle(item.id, answer.rev, answer.epoch);
    });
    // the caller hears first, then settled(): a suite that wakes on it finds the answer applied
    for (const w of item.waiters) w.resolve(answer.body);
    this.finish(item);
  }

  private later(item: Item, error: unknown): void {
    item.error = error;
    if (item.attempts > RETRY_DELAYS_MS.length) return this.exhaust(item, error);
    item.state = "retrying";
    this.changed();
    this.wait(item, RETRY_DELAYS_MS[item.attempts - 1]);
  }

  private wait(item: Item, ms: number): void {
    if (this.d.wire.down()) { item.remaining = ms; return; }
    item.remaining = null;
    item.due = this.d.now() + ms;
    item.timer = this.d.setTimer(() => {
      item.timer = null; item.due = null;
      if (!this.items.includes(item)) return;
      if (this.d.wire.down()) { item.remaining = 0; return; }
      void this.send(item);
    }, ms);
  }

  /** Into the outbox, once: from here a reload can send it again. */
  private keep(item: Item): void {
    if (!item.op.offline || item.saved || !this.d.outbox) return;
    item.saved = item.key;
    const base = item.op.base?.();
    this.keptAt = Math.max(this.d.now(), this.keptAt + 1);
    try {
      this.d.outbox.put({
        key: item.key, label: item.op.label, lanes: item.op.lanes, method: item.op.method, path: item.op.path, at: this.keptAt,
        ...(item.body === undefined ? {} : { body: item.body }),
        ...(typeof base === "number" ? { base } : {}),
        ...(item.op.invalidates?.length ? { invalidates: item.op.invalidates } : {}),
      });
    } catch (e) { console.error("[strata] outbox", e); }
  }

  private wireChanged(): void {
    const down = this.d.wire.down();
    if (down) for (const item of this.items) this.keep(item);
    for (const item of this.items) {
      if (down && item.timer !== null) {
        this.d.clearTimer(item.timer);
        item.timer = null;
        item.remaining = Math.max(0, (item.due ?? this.d.now()) - this.d.now());
        item.due = null;
      } else if (!down && item.remaining !== null) this.wait(item, item.remaining);
    }
    if (!down) this.pump();
  }

  /** Out of retries: layers stay and lanes stay held until retry(id) or discard(id). */
  private exhaust(item: Item, error: unknown): void {
    const e = error instanceof Error ? error as SaveError : saveError(String(error ?? "not saved"));
    e.retryable = true;
    item.state = "failed";
    item.error = e;
    const waiters = item.waiters;
    item.waiters = [];
    this.changed();
    for (const w of waiters) w.reject(e);
  }

  /** 409: the store takes the current value; whole-document ops queued behind fail rather than overwrite it. */
  private conflicted(item: Item, answer: SendAnswer, conflict: Conflict): void {
    const take = item.op.takeConflict;
    if (take) this.d.store.patch(take.key, conflict.rev, (held) => take.fold(held, conflict), { epoch: answer.epoch, ordered: take.rev ?? true });
    for (const stale of this.behind(item)) if (stale.op.base) this.fail(stale, this.refusal(answer));
    const next = ++item.conflicts < 2 ? item.op.onConflict?.(conflict, answer.epoch) ?? null : null;
    if (!next) return this.fail(item, this.refusal(answer));
    this.rebuild(item, next as Op<unknown>, true);
    this.changed();
    this.pump();
  }

  private fail(item: Item, error: SaveError): void {
    if (item.saved) try {
      this.d.outbox?.refused({
        key: item.saved, label: item.op.label, method: item.op.method, path: item.op.path, at: this.d.now(),
        ...(item.body === undefined ? {} : { body: item.body }),
        ...(error.status ? { status: error.status } : {}),
        said: error.message, ...(error.conflict ? { server: error.conflict.value } : {}),
      });
    } catch (e) { console.error("[strata] outbox", e); }
    this.unpaint(item);
    this.d.store.settle(item.id, null);
    for (const w of item.waiters) w.reject(error);
    this.finish(item);
    this.d.surface?.({ id: item.id, label: item.op.label, error });
  }

  private finish(item: Item): void {
    if (item.timer !== null) this.d.clearTimer(item.timer);
    item.timer = null;
    if (item.holdTimer !== null) this.d.clearTimer(item.holdTimer);
    item.holdTimer = null;
    item.holding = false;
    if (item.saved) try { this.d.outbox?.drop(item.saved); } catch (e) { console.error("[strata] outbox", e); }
    this.leaveLanes(item);
    this.items = this.items.filter((i) => i !== item);
    this.changed();
    this.pump();
  }

  /** A stable array, new only when something in it changed (for useSyncExternalStore). */
  pending(): PendingOp[] { return this.snapshot; }

  subscribePending(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  settled(): Promise<void> {
    if (!this.items.length) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  /** Sends a failed op again with the same key and bytes; one waiting out a retry gap goes now. */
  retry(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (item?.state === "retrying") {
      if (item.timer !== null) this.d.clearTimer(item.timer);
      item.timer = null; item.due = null; item.remaining = null;
      if (this.d.wire.down()) { item.remaining = 0; return; }
      void this.send(item);
      return;
    }
    if (!item || item.state !== "failed") return;
    item.state = "queued";
    item.attempts = 0;
    item.error = null;
    this.changed();
    this.pump();
  }

  discard(id: string): void {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.state === "sending") return;
    this.unpaint(item);
    this.d.store.settle(item.id, null);
    this.finish(item);
    const e = saveError(`${item.op.label} — discarded`);
    for (const w of item.waiters) w.reject(e);
  }

  /** Takes back a held op that has not left: its layers go and it is never sent. False once it is on its way. */
  withdraw(key: string): boolean {
    const item = this.items.find((i) => i.key === key);
    if (!item || !item.holding || item.sent) return false;
    this.unpaint(item);
    this.d.store.settle(item.id, null);
    this.finish(item);
    const e = saveError(`${item.op.label} — taken back`, { withdrawn: true });
    for (const w of item.waiters) w.reject(e);
    return true;
  }

  /** Drops a lane's failed ops so they no longer wedge every later write behind them. */
  discardFailed(lane: string): void {
    for (const item of [...this.items]) if (item.state === "failed" && item.op.lanes.includes(lane)) this.discard(item.id);
  }

  /** mutate(op), but running out of retries releases its lanes so the next save is not queued behind it. */
  release<Res>(op: Op<Res>): Promise<Res> {
    return this.mutate(op).catch((e: SaveError) => {
      if (e?.retryable) for (const lane of op.lanes) this.discardFailed(lane);
      throw e;
    });
  }

  private changed(): void {
    this.snapshot = this.items.map((i) => ({ id: i.id, label: i.op.label, lanes: i.op.lanes, state: i.holding && i.state === "queued" ? "held" : i.state, attempts: i.attempts, error: i.error, key: i.key }));
    for (const cb of [...this.listeners]) cb();
    if (!this.items.length && this.idle.length) {
      const idle = this.idle;
      this.idle = [];
      for (const resolve of idle) resolve();
    }
  }

  // Resent with keepalive, same key and bytes; the browser's 64 KB in-flight budget is shared by all.
  // An op behind an unacknowledged one goes without If-Match, else the pair would refuse each other.
  flush(): void {
    const transport = this.d.transport;
    if (!transport) return;
    const picked = new Set<Item>();
    for (const queue of this.lanes.values()) if (queue[0]) picked.add(queue[0]);
    for (const item of this.items) if (!item.op.lanes.length || (item.op.coalesce && item.state === "queued")) picked.add(item);
    const fits = [...picked]
      .map((item) => ({ item, size: bytes(item.body) }))
      .filter(({ item, size }) => item.op.flush && size <= FLUSH_MAX_BODY);
    const newest = new Map<string, Item>();
    for (const { item } of fits) {
      const c = item.op.coalesce;
      if (c && (newest.get(c)?.seq ?? -1) < item.seq) newest.set(c, item);
    }
    const eligible = fits
      .filter(({ item }) => !item.op.coalesce || newest.get(item.op.coalesce) === item)
      .filter(({ item }) => !item.carrying)
      .sort((a, b) => a.size - b.size || a.item.seq - b.item.seq);
    for (const { item, size } of eligible) {
      if (size > KEEPALIVE_BUDGET - this.aliveBytes) continue;
      const req = this.request(item, { keepalive: true }, !this.queuedBehindAnother(item));
      item.sent = true;
      const done = this.carry(item, size);
      try { void transport(req).catch(() => {}).finally(done); }
      catch { done(); /* the page is going away either way */ }
    }
  }

  /** Runs on pagehide before the flush, so writers holding their own text hand it over first. */
  onLeave(fn: () => void): () => void {
    this.leaving.add(fn);
    return () => { this.leaving.delete(fn); };
  }

  /** Keeps the unsaved prompt armed while a writer owes text the save path cannot see. */
  holds(owes: () => boolean, changes: (fn: () => void) => () => void): () => void {
    this.holders.add(owes);
    const off = changes(() => this.rearm());
    this.rearm();
    return () => { off(); this.holders.delete(owes); this.rearm(); };
  }

  unload(): void {
    for (const fn of [...this.leaving]) {
      try { fn(); } catch (e) { console.error("[strata] leaving", e); }
    }
    this.flush();
  }

  install(win: Pick<Window, "addEventListener" | "removeEventListener"> & { __strataSettled?: () => Promise<void> }): void {
    win.__strataSettled = () => this.settled();
    win.addEventListener("pagehide", () => this.unload());
    const guard = (e: Event) => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ""; };
    let armed = false;
    this.rearm = () => {
      // a held op goes out with the pagehide flush, so its undo window alone is no reason to ask
      const want = this.items.some((i) => !i.holding) || [...this.holders].some((owes) => owes());
      if (want === armed) return;
      armed = want;
      if (want) win.addEventListener("beforeunload", guard);
      else win.removeEventListener("beforeunload", guard);
    };
    this.subscribePending(() => this.rearm());
    this.rearm();
  }
}

// Refuses every mutate() with a reason until main.tsx configures it.
export const mutator = new Mutator();
if (typeof window !== "undefined") mutator.install(window);

export const mutate = <Res>(op: Op<Res>): Promise<Res> => mutator.mutate(op);
export const call = <Res>(method: string, path: string, body?: unknown): Promise<Res> => mutator.call<Res>(method, path, body);
export const pending = (): PendingOp[] => mutator.pending();
export const subscribePending = (cb: () => void): (() => void) => mutator.subscribePending(cb);
export const settled = (): Promise<void> => mutator.settled();
export const retry = (id: string): void => mutator.retry(id);
export const discard = (id: string): void => mutator.discard(id);
export const withdraw = (key: string): boolean => mutator.withdraw(key);
export const discardFailed = (lane: string): void => mutator.discardFailed(lane);
export const release = <Res>(op: Op<Res>): Promise<Res> => mutator.release(op);
