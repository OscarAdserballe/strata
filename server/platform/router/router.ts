/* The route table and the write path.
   - Routes match in table order and the first match wins, so order is part of the contract.
   - A write commits through ctx.commit: its rows and its receipt commit in one transaction.
   - A commit is synchronous: a transaction held across an await would take in other requests' writes.
   - ctx.ifMatch is the first statement inside the commit; a mismatch throws, so nothing is written.
   - An Idempotency-Key is honoured only on routes that state "atomic" or "stream".
   - Receipts reference board states; they are built after the commit, and again on every replay. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { bodyTooBig, httpError, readBody, sendJson } from "../http/http.ts";
import { db } from "../db/db.ts";
import { tx } from "../db/tx.ts";
import { roomRev } from "../db/sql.ts";
import { RECEIPT_KEY, receiptStore, type Receipt } from "../db/receipts.ts";
import type { Synchronous } from "../db/transaction.ts";
import { Conflict, checkIfMatch } from "./if-match.ts";

export interface Committed { status: number; body: unknown }

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ssn: string | null;
  params: string[];
  body<T = Record<string, unknown>>(maxBytes?: number): Promise<T>;
  // Runs fn with the receipt in one transaction, then sends fn's answer; fn must not await.
  commit<R extends Committed>(fn: () => Synchronous<R>): R;
  // Two-phase write for a route that awaits between writes: open leaves the receipt 'open', close finishes it.
  phase: Phase;
  open<R extends Committed>(fn: () => Synchronous<R>): R;
  close<R extends Committed>(fn: () => Synchronous<R>): Committed;
  // First statement inside commit; outside one it throws, since an earlier check could be stale.
  ifMatch(rev: number, value: () => unknown): void;
}

export type Phase =
  | { at: "new" }
  // phase 1 committed and phase 2 never did: resume with the body phase 1 stored
  | { at: "open"; body: unknown }
  | { at: "done"; status: number; body: unknown };

export type Handler = (ctx: Ctx) => Promise<void> | void;

// atomic: ctx.commit; stream: ctx.open/close; none: a read-only POST; exempt: no key is honoured.
export type ReceiptMode = "atomic" | "stream" | "none" | "exempt";

export interface RouteOptions {
  receipt?: ReceiptMode;
  maxBody?: number;
}

export interface Route extends RouteOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pattern: string | RegExp;
  handler: Handler;
}

export const route = (method: Route["method"], pattern: Route["pattern"], handler: Handler, options: RouteOptions = {}): Route =>
  ({ method, pattern, handler, ...options });

export const receiptModeOf = (r: Route): ReceiptMode => r.receipt ?? (r.method === "GET" ? "none" : "atomic");

export interface BoardStateRef { $boardState: string; thread: string | null }
export const stateOf = (boardId: string, thread: string | null = null): BoardStateRef => ({ $boardState: boardId, thread });
let buildState: ((boardId: string, thread: string | null) => unknown) | null = null;
export const buildStatesWith = (fn: (boardId: string, thread: string | null) => unknown): void => { buildState = fn; };
const isStateRef = (v: object): v is BoardStateRef => typeof (v as Partial<BoardStateRef>).$boardState === "string";
function rehydrate(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  // only arrays and plain objects are walked, so a Date or toJSON value keeps JSON.stringify's shape
  const proto: unknown = Object.getPrototypeOf(v);
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
  if (isStateRef(v)) {
    if (!buildState) throw new Error("a reply names a board state but no builder was given (features/boards/state.ts buildStatesWith)");
    return buildState(v.$boardState, v.thread ?? null);
  }
  if (Array.isArray(v)) return v.map(rehydrate);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = rehydrate(x);
  return out;
}

// keys in flight in this process; node:sqlite is single-threaded, so check-then-set cannot race
const inflight = new Map<string, Promise<void>>();
const DIFFERENT = "this Idempotency-Key was already used for a different request";

let store: ReturnType<typeof receiptStore> | null = null;
const receipts = () => (store ??= receiptStore(db));

// another process stored this key first: the rollback undoes this one, answered with that receipt
class KeyTaken extends Error {}
// ends the handler after a replay so it skips the work after its commit; dispatch swallows it
class Answered extends Error {}

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v !== null && (typeof v === "object" || typeof v === "function") && typeof (v as PromiseLike<unknown>).then === "function";

function replay(res: ServerResponse, had: Receipt, method: string, path: string, hash: string): void {
  if (had.method !== method || had.path !== path || had.body_hash !== hash) { sendJson(res, 422, { error: DIFFERENT }); return; }
  if (had.state !== "done") { sendJson(res, 409, { error: "that request is still being answered" }); return; }
  res.setHeader("Idempotent-Replay", "true");
  sendJson(res, had.status, rehydrate(had.body == null ? null : JSON.parse(had.body)));
}

const parse = <T,>(raw: string): T => {
  const text = raw.trim();
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; }
  catch (e) { throw httpError(400, `that request wasn't valid JSON — ${(e as Error).message}`); }
};

// ifMatch is callable only while a commit's block runs, so the check and the write share a transaction.
function preconditions(req: IncomingMessage) {
  let open = false;
  return {
    ifMatch(rev: number, value: () => unknown): void {
      if (!open) throw new Error("ctx.ifMatch belongs inside ctx.commit, as its first statement: checked outside it, the document can move before the write");
      checkIfMatch(req, rev, value);
    },
    within<T>(fn: () => T): T {
      open = true;
      try { return fn(); } finally { open = false; }
    },
  };
}
function answerConflict(res: ServerResponse, e: unknown): never {
  if (!(e instanceof Conflict)) throw e;
  sendJson(res, 409, e.body);
  throw new Answered();
}

export async function dispatch(routes: Route[], base: Base): Promise<boolean> {
  const path = base.url.pathname;
  for (const r of routes) {
    if (r.method !== base.req.method) continue;
    let params: string[] | null = null;
    if (typeof r.pattern === "string") { if (r.pattern === path) params = []; }
    else { const m = path.match(r.pattern); if (m) params = m.slice(1); }
    if (!params) continue;
    const key = base.req.headers["idempotency-key"];
    if (key !== undefined && r.receipt === "atomic") await receipted(r, base, params, String(key));
    else if (key !== undefined && r.receipt === "stream") await streamed(r, base, params, String(key));
    else {
      try { await r.handler(plain(base, params)); }
      catch (e) { if (!(e instanceof Answered)) throw e; }
    }
    return true;
  }
  return false;
}

export type Base = Omit<Ctx, "params" | "body" | "commit" | "phase" | "open" | "close" | "ifMatch">;

function held<R>(fn: () => Synchronous<R>): R {
  return tx(() => {
    const r: unknown = fn();
    if (isThenable(r)) { r.then(undefined, () => {}); throw new Error("a commit cannot await: do the awaiting first, then write in one synchronous block"); }
    return r as Synchronous<R>;
  }) as R;
}

const unkept = {
  phase: { at: "new" } as Phase,
  open: <R extends Committed>(fn: () => Synchronous<R>): R => held(fn),
  close: <R extends Committed>(fn: () => Synchronous<R>): Committed => {
    const out = held(fn);
    return { status: out.status, body: rehydrate(out.body) };
  },
};

function plain(base: Base, params: string[]): Ctx {
  const pre = preconditions(base.req);
  return {
    ...base, params, ...unkept,
    ifMatch: pre.ifMatch,
    body: async <T,>(maxBytes?: number) => parse<T>(await readBody(base.req, maxBytes)),
    commit: <R extends Committed>(fn: () => Synchronous<R>): R => {
      let out: R;
      try { out = held(() => pre.within(fn)); }
      catch (e) { answerConflict(base.res, e); }
      sendJson(base.res, out.status, rehydrate(out.body));
      return out;
    },
  };
}

// A handler that answers or throws without committing stores nothing, so a retry runs afresh.
async function receipted(r: Route, base: Base, params: string[], key: string): Promise<void> {
  const { req, res, url } = base;
  if (!RECEIPT_KEY.test(key)) { sendJson(res, 400, { error: "an Idempotency-Key is 8 to 80 letters, digits and dashes" }); return; }
  const raw = await readBody(req, r.maxBody);
  const hash = raw ? createHash("sha256").update(raw).digest("hex") : "";
  const method = req.method ?? "POST", path = url.pathname + url.search;
  for (;;) {
    const running = inflight.get(key);
    if (running) { await running; continue; }
    const had = receipts().find(key);
    if (had) { replay(res, had, method, path, hash); return; }
    break;
  }
  let finished!: () => void;
  inflight.set(key, new Promise<void>((resolve) => { finished = resolve; }));
  const bytes = Buffer.byteLength(raw);
  const pre = preconditions(req);
  try {
    await r.handler({
      ...base, params, ...unkept,
      ifMatch: pre.ifMatch,
      body: async <T,>(maxBytes?: number) => {
        if (maxBytes !== undefined && bytes > maxBytes) throw bodyTooBig(maxBytes);
        return parse<T>(raw);
      },
      commit: <R extends Committed>(fn: () => Synchronous<R>): R => {
        let out: R;
        try {
          out = tx(() => {
            const r: unknown = pre.within(fn);
            if (isThenable(r)) { r.then(undefined, () => {}); throw new Error("a commit cannot await: do the awaiting first, then write in one synchronous block"); }
            const c = r as R;
            const stored = receipts().put({
              key, method, path, body_hash: hash, status: c.status,
              body: c.body === undefined ? null : JSON.stringify(c.body), rev: roomRev(), created_at: Date.now(),
            });
            if (!stored) throw new KeyTaken();
            return c as Synchronous<R>;
          }) as R;
        } catch (e) {
          // a stale If-Match rolled back before the receipt was written: 409, nothing stored
          if (!(e instanceof KeyTaken)) answerConflict(res, e);
          const had = receipts().find(key);
          if (had) replay(res, had, method, path, hash); else sendJson(res, 409, { error: "that request is still being answered" });
          throw new Answered();
        }
        sendJson(res, out.status, rehydrate(out.body));
        return out;
      },
    });
  } catch (e) {
    if (!(e instanceof Answered)) throw e;
  } finally {
    inflight.delete(key);
    finished();
  }
}

// A handler that throws before close leaves the receipt open, so the same key resumes.
async function streamed(r: Route, base: Base, params: string[], key: string): Promise<void> {
  const { req, res, url } = base;
  if (!RECEIPT_KEY.test(key)) { sendJson(res, 400, { error: "an Idempotency-Key is 8 to 80 letters, digits and dashes" }); return; }
  const raw = await readBody(req, r.maxBody);
  const hash = raw ? createHash("sha256").update(raw).digest("hex") : "";
  const method = req.method ?? "POST", path = url.pathname + url.search;
  let had: Receipt | undefined;
  for (;;) {
    const running = inflight.get(key);
    if (running) { await running; continue; }
    had = receipts().find(key);
    break;
  }
  if (had && (had.method !== method || had.path !== path || had.body_hash !== hash)) { sendJson(res, 422, { error: DIFFERENT }); return; }
  const stored: unknown = had?.body == null ? null : JSON.parse(had.body);
  const phase: Phase = !had ? { at: "new" }
    : had.state === "open" ? { at: "open", body: stored }
    : { at: "done", status: had.status, body: rehydrate(stored) };
  if (phase.at === "done") res.setHeader("Idempotent-Replay", "true");
  let opened = phase.at !== "new";
  let finished!: () => void;
  inflight.set(key, new Promise<void>((resolve) => { finished = resolve; }));
  const bytes = Buffer.byteLength(raw);
  const json = (body: unknown) => body === undefined ? null : JSON.stringify(body);
  const pre = preconditions(req);
  try {
    await r.handler({
      ...base, params, phase,
      ifMatch: pre.ifMatch,
      body: async <T,>(maxBytes?: number) => {
        if (maxBytes !== undefined && bytes > maxBytes) throw bodyTooBig(maxBytes);
        return parse<T>(raw);
      },
      commit: <R extends Committed>(fn: () => Synchronous<R>): R => {
        let out: R;
        try { out = held(() => pre.within(fn)); }
        catch (e) { answerConflict(res, e); }
        sendJson(res, out.status, rehydrate(out.body));
        return out;
      },
      open: <R extends Committed>(fn: () => Synchronous<R>): R => {
        const out = held<R>(() => {
          const c = fn();
          const put = opened || receipts().put({
            key, method, path, body_hash: hash, state: "open", status: (c as R).status,
            body: json((c as R).body), rev: roomRev(), created_at: Date.now(),
          });
          // another process opened this key between our look and this commit: answer nothing twice
          if (!put) throw httpError(409, "that request is still being answered");
          return c;
        });
        opened = true;
        return out;
      },
      close: <R extends Committed>(fn: () => Synchronous<R>): Committed => {
        const out = held<R>(() => {
          const c = fn();
          if (opened) receipts().finish(key, (c as R).status, json((c as R).body), roomRev());
          return c;
        });
        return { status: out.status, body: rehydrate(out.body) };
      },
    });
  } finally {
    inflight.delete(key);
    finished();
  }
}
