import { mintKey, mutator as roomMutator, type Mutator, type Op, type PendingOp, type SaveError } from "../mutate.ts";

export type GradeRequest = {
  requestId: string; course: string; card: string; got: boolean; ms?: number;
  surface?: "review" | "drill"; board?: string; pass?: number; passes?: number; solo?: boolean; pos?: number;
};
export const GRADES_LANE = "grades";
export const RETRY_AFTER_MS = 16_000;
/** getRandomValues hex, which works over plain http */
export const newGradeId = (): string => mintKey();

export function gradeOp(request: GradeRequest): Op<{ saved: true; at: number }> {
  return {
    label: "save that grade",
    lanes: [GRADES_LANE],
    method: "POST",
    path: "/api/review/grade",
    body: request,
    key: request.requestId,
    // a 401 is not a refusal: keep the grade and retry it under its receipt
    retryOn: [401],
    // often the last act before the tab closes, so every attempt rides keepalive
    keepalive: true,
    flush: true,
    confirm: () => {},
  };
}

export interface DrillCard { id: string; deck?: string | null; mintId?: string | null }
export interface DrillContext {
  board: string | null;
  pass?: number; passes?: number;
  solo?: boolean;
  pos?: number;
  ms?: number;
}
const count = (n: number | undefined): n is number => Number.isInteger(n) && (n as number) >= 0;

export function drillGradeRequest(card: DrillCard, got: boolean, ctx: DrillContext, requestId: string = newGradeId()): GradeRequest | null {
  if (!ctx.board || String(card.id).startsWith("mint:") || !card.deck) return null;
  return {
    requestId, course: String(card.deck).split("/")[0], card: card.id, got,
    surface: "drill", board: ctx.board, solo: !!ctx.solo,
    ...(count(ctx.pass) ? { pass: ctx.pass } : {}),
    ...(count(ctx.passes) ? { passes: ctx.passes } : {}),
    ...(count(ctx.pos) ? { pos: ctx.pos } : {}),
    ...(Number.isFinite(ctx.ms) ? { ms: Math.max(0, Math.round(ctx.ms!)) } : {}),
  };
}

export function reviewGradeRequest(card: { id: string; course: string }, got: boolean, ms: number, requestId: string = newGradeId()): GradeRequest {
  return { requestId, course: card.course, card: card.id, got, ms: Math.max(0, Math.round(ms)) };
}

export interface GradeState {
  pending: number;
  error: unknown;
}

export interface Timers { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const realTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();      // never keep a test process alive
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const mine = (ops: PendingOp[]) => ops.filter((p) => p.lanes.includes(GRADES_LANE));

export class Grades {
  private state: GradeState = { pending: 0, error: null };
  private readonly listeners = new Set<() => void>();
  private readonly cards = new Map<string, string>();
  private readonly droppedSaid = new Set<string>();
  private timer: unknown = null;
  private readonly m: Mutator;
  private readonly timers: Timers;

  constructor(m: Mutator = roomMutator, timers: Timers = realTimers) {
    this.m = m;
    this.timers = timers;
    m.subscribePending(() => this.recompute());
  }

  grade(request: GradeRequest, dropped: (error: SaveError) => void = () => {}): void {
    this.cards.set(request.requestId, request.card);
    const who = request.surface ?? "review";
    this.m.mutate(gradeOp(request)).then(
      () => { this.droppedSaid.delete(who); },
      (e: SaveError) => {
        if (e?.retryable) return;
        this.cards.delete(request.requestId);
        if (!this.droppedSaid.has(who)) { this.droppedSaid.add(who); dropped(e); }
      },
    );
    this.recompute();
  }

  retry(): void {
    this.cancelRetry();
    for (const p of mine(this.m.pending())) this.m.retry(p.id);
  }

  hasCard(card: string): boolean {
    return mine(this.m.pending()).some((p) => this.cards.get(p.key) === card);
  }

  private recompute(): void {
    const ops = mine(this.m.pending());
    const keys = new Set(ops.map((p) => p.key));
    for (const k of [...this.cards.keys()]) if (!keys.has(k)) this.cards.delete(k);
    const failed = ops.find((p) => p.state === "failed");
    const error = ops.find((p) => (p.state === "retrying" || p.state === "failed") && p.error != null)?.error ?? null;
    if (failed) this.scheduleRetry(); else this.cancelRetry();
    if (ops.length === this.state.pending && error === this.state.error) return;
    this.state = { pending: ops.length, error };
    for (const fn of [...this.listeners]) fn();
  }

  private scheduleRetry(): void {
    if (this.timer !== null) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      for (const p of mine(this.m.pending())) if (p.state === "failed") this.m.retry(p.id);
    }, RETRY_AFTER_MS);
  }
  private cancelRetry(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = (): GradeState => this.state;
}

export const grades = new Grades();
