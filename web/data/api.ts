import { PendingReads, WarmReads } from "./pending-reads.ts";
import { Wire } from "../platform/wire.ts";
import { call, mutator, type SendAnswer, type SendRequest } from "./mutate.ts";
import type { Fetched } from "./store.ts";

import type {
  BoardState, Message, DeckSummary, Touched, CardsSeen, Here,
  CaptureResponse, CaptureFinishResponse, TreeResponse, ReviewState, CardHistory, SessionMapResponse, ReviewTreeResponse, DeckKeepsResponse,
  BoardCollectionResponse, MintedEverywhere, LibraryCollectionResponse, BoardStatus,
  ThreadPage, DeckRead, DeckIgnored,
} from "../../shared/types/index.ts";

export interface ApiError extends Error { status?: number }

export function StrataPath(path: string): string {
  const base = typeof window !== "undefined" && window.STRATA_BASE ? window.STRATA_BASE : "/";
  const suffix = path.replace(/^\/+/, "");
  return base === "/" ? `/${suffix}` : `${base}${suffix}`;
}

export function StrataReason(e: unknown): string {
  const err = (e ?? {}) as ApiError;
  const msg = String(err.message ?? "").trim();
  const vague = !msg || /^HTTP \d+$/.test(msg);
  // refuseWrite's own error: status 0, thrown before fetch was called
  if (err.status === 0 || /^offline/i.test(msg)) return "you're offline, and offline is read-only";
  // fetch itself failed: no status, and a message that differs per browser
  if (err.status === undefined) {
    if (!msg) return "no reason given";
    return /failed to fetch|load failed|networkerror/i.test(msg) ? "the server didn't answer" : msg;
  }
  if (err.status === 401) return "you're signed out — reload to sign in again";
  if (err.status === 404) return vague ? "it isn't on this server any more" : msg;
  if (err.status === 503) return vague ? "no model key on this server" : msg;
  return vague ? `the server said ${err.status}` : msg;
}
export const StrataWhy = (e: unknown, said: string): string => `${said} — ${StrataReason(e)}`;

export const StrataMB = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;

// Offline is read-only: while the wire is known down, every mutating call is refused here, before fetch.
let savedAt: number | null = null;
let unknownSavedAt = false;
let serverBuild: string | null = null;
let needsReload = false;
// the build this page runs, from its own script's ?v=; the worker can open a page on an older build than the server's
const ownBuild = (() => {
  try { return new URL((document.querySelector('script[src*="dist/main.js"]') as HTMLScriptElement).src).searchParams.get("v"); } catch { return null; }
})();
let outdated = false;
const startedDown = typeof navigator !== "undefined" && !navigator.onLine;
// something came from the shelf since the wire last answered: worth a reload if the room was really down
let shelfServed = startedDown;
const wireListeners = new Set<() => void>();
const wire = new Wire({
  down: startedDown,
  probe: async () => (await probeHealth())?.ok ?? false,
  changed: (down) => {
    if (!down) { needsReload ||= shelfServed; shelfServed = false; }
    for (const fn of [...wireListeners]) fn();
    announceConnection();
  },
  hidden: () => typeof document !== "undefined" && document.hidden,
});
export const StrataConnection = () => ({ offline: wire.down, savedAt: unknownSavedAt ? null : savedAt, serverBuild, needsReload: needsReload || outdated, outdated });
function announceConnection(): void {
  try { window.dispatchEvent(new Event("strata:connection")); } catch { /* no browser in tests */ }
}
try {
  window.addEventListener("offline", () => wire.failed());
} catch { /* not a browser */ }
export const StrataWireDown = (): boolean => wire.down;
function refuseWrite(): never {
  const err: ApiError = new Error("offline — read only");
  err.status = 0;
  throw err;
}

// A shelf answer's body is remembered, so a caller can refuse to make a stale copy editable (StrataFromShelf).
const shelfCopies = new WeakSet<object>();
export const StrataFromShelf = (value: unknown): boolean => typeof value === "object" && value !== null && shelfCopies.has(value);
function announce(r: Response): void {
  const shelf = !!r.headers.get("X-Strata-Shelf");
  if (shelf) {
    const stamp = Number(r.headers.get("X-Strata-Saved-At"));
    if (stamp > 0) savedAt = savedAt === null ? stamp : Math.min(savedAt, stamp);
    else if (r.ok) unknownSavedAt = true;
    shelfServed = true;
    wire.failed();
  } else {
    savedAt = null; unknownSavedAt = false;
    if (!wire.down) shelfServed = false;
    wire.answered();
  }
  try {
    const build = shelf ? null : r.headers.get("X-Strata-Build");
    if (build) serverBuild = build;
    if (build && ownBuild && ownBuild !== "dev" && build !== ownBuild && !outdated) { outdated = true; announceConnection(); }
    if (build) window.dispatchEvent(new CustomEvent("strata:build", { detail: build }));
    window.dispatchEvent(new Event(shelf ? "strata:shelf" : "strata:wire"));
  } catch { /* announcing is never worth an error */ }
  announceConnection();
}

async function probeHealth(): Promise<Response | null> {
  try {
    const r = await fetch(StrataPath("/api/health"), { cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (r.ok) announce(r);
    return r;
  } catch { return null; }
}
export async function StrataCheckConnection(): Promise<void> {
  const r = await probeHealth();
  if (!r?.ok) wire.failed();
}

const pendingReads = new PendingReads();
// prefetch keeps an answer for the next read of its path once, while young; any write drops them all.
const warmed = new WarmReads(30_000);
export function prefetch(path: string): Promise<unknown> {
  if (wire.down) return Promise.resolve(null);
  return warmed.start(path, () => pendingReads.run(path, () => apiRequest(path)));
}
export function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const method = String(opts?.method || "GET").toUpperCase();
  // an abortable read is its own, shared with no other caller, but it still drops no warm answers
  if (method === "GET" && opts?.signal) return apiRequest<T>(path, opts);
  if (method === "GET") {
    // a prefetch that failed is not an answer: ask again, as if it had never been made
    const kept = warmed.take<T>(path);
    if (kept) return kept.catch(() => apiRequest<T>(path, opts));
    return pendingReads.run(path,()=>apiRequest<T>(path,opts));
  }
  pendingReads.invalidate(); warmed.clear();
  return apiRequest<T>(path,opts).finally(()=>{ pendingReads.invalidate(); warmed.clear(); });
}
// Requests in flight, for the browser suites' settled(); counters on window, never React state, so no render.
let out = 0, sent = 0;
function count(d: number): void {
  try {
    out += d; if (d > 0) sent++;
    window.__strataPending = out; window.__strataSent = sent;
    if (!out) setTimeout(() => { if (!out) window.dispatchEvent(new Event("strata:settled")); });
  } catch { /* no browser in tests */ }
  wireMoved();
}

// Background work waits for a quiet wire, so it never takes the browser's six connections from a journey.
const QUIET_MS = 250;
let bare = 0;
let quietTimer: ReturnType<typeof setTimeout> | undefined;
const quietWaiters = new Set<() => void>();
function wireMoved(): void {
  clearTimeout(quietTimer); quietTimer = undefined;
  if (out > 0 || bare > 0 || !quietWaiters.size) return;
  quietTimer = setTimeout(() => {
    quietTimer = undefined;
    const due = [...quietWaiters]; quietWaiters.clear();
    for (const fn of due) { try { fn(); } catch { /* one waiter's failure is not another's */ } }
  }, QUIET_MS);
}
export const wireQuiet = (): boolean => out === 0 && bare === 0;
export function whenQuiet(fn: () => void): () => void {
  quietWaiters.add(fn);
  wireMoved();
  return () => { quietWaiters.delete(fn); if (!quietWaiters.size) { clearTimeout(quietTimer); quietTimer = undefined; } };
}
function onWire(p: Promise<Response>): Promise<Response> {
  bare++; wireMoved();
  const back = () => { bare--; wireMoved(); };
  p.then(back, back);
  return p;
}
function wired<T>(p: Promise<T>): Promise<T> {
  count(1);
  return p.finally(() => count(-1));
}
function apiRequest<T>(path: string, opts?: RequestInit): Promise<T> { return wired(request<T>(path, opts)); }
// While the room calls the wire down, reads say so, and the service worker answers from the shelf at once.
async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const read = String((opts && opts.method) || "GET").toUpperCase() === "GET";
  if (wire.down && !read) refuseWrite();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...((opts?.headers as Record<string, string> | undefined) ?? {}) };
  if (wire.down && read) headers["X-Strata-Wire"] = "down";
  let r: Response;
  try { r = await fetch(StrataPath(path), { ...(opts || {}), headers }); }
  catch (e) {
    // a caller that gave up (an aborted signal) says nothing about the wire
    if ((e as Error)?.name !== "AbortError") wire.failed();
    throw e;
  }
  // a snapshot is the worker's last saved answer, not news from the wire: it says nothing about build or health
  if (!r.headers.get("X-Strata-Snapshot")) announce(r);
  // carry the status on the error: callers must tell 404 ("nothing here yet") from a failure
  if (!r.ok) {
    let m: string | undefined;
    try { m = ((await r.json()) as { error?: string }).error; } catch { /* non-JSON */ }
    const err: ApiError = new Error(m || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  if (r.status === 204) return null as T;
  const body = await r.json();
  if (body && typeof body === "object" && r.headers.get("X-Strata-Shelf")) shelfCopies.add(body);
  remember(body, r);
  return body as T;
}

export interface AnswerMeta { stamp: number; epoch: string; origin: "wire" | "shelf" }
const answers = new WeakMap<object, AnswerMeta>();
function metaOf(r: Response): AnswerMeta {
  return {
    stamp: Number(r.headers.get("X-Strata-Rev")) || 0,
    epoch: r.headers.get("X-Strata-Epoch") || "",
    origin: r.headers.get("X-Strata-Shelf") ? "shelf" : "wire",
  };
}
function remember(body: unknown, r: Response): void {
  if (!body || typeof body !== "object") return;
  const meta = metaOf(r);
  answers.set(body, meta);
  for (const part of ["state", "destState"]) {
    const inner = (body as Record<string, unknown>)[part];
    if (inner && typeof inner === "object") answers.set(inner, meta);
  }
}
/** The stamp, epoch and origin of a body api() returned; undefined for a value built on the page. */
export const StrataAnswer = (value: unknown): AnswerMeta | undefined =>
  value && typeof value === "object" ? answers.get(value) : undefined;
/** A boot read may take the worker's saved answer at once; the live one follows and re-reads if it differs. */
export const SNAPSHOT_OK: RequestInit = { headers: { "X-Strata-Snapshot": "ok" } };
/** A read shaped for the store; its rev is the body's own (revOf), else the stamp. */
export async function fetched<T>(path: string, revOf?: (v: T) => number, opts?: { boot?: boolean }): Promise<Fetched<T>> {
  const value = await api<T>(path, opts?.boot ? SNAPSHOT_OK : undefined);
  const meta = StrataAnswer(value) ?? { stamp: 0, epoch: "", origin: "wire" as const };
  return { value, rev: revOf ? revOf(value) : meta.stamp, epoch: meta.epoch, origin: meta.origin, stamp: meta.stamp };
}

async function send(req: SendRequest): Promise<SendAnswer> {
  let r: Response;
  try {
    r = await fetch(StrataPath(req.path), { method: req.method, headers: req.headers, body: req.body, keepalive: req.keepalive, signal: req.signal });
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") wire.failed();
    throw e;
  }
  announce(r);
  let body: unknown = null;
  if (r.status !== 204) { try { body = await r.json(); } catch { /* an empty or non-JSON answer */ } }
  remember(body, r);
  const meta = metaOf(r);
  return { status: r.status, body, rev: meta.stamp, epoch: meta.epoch, replay: r.headers.get("Idempotent-Replay") === "true" };
}
const clearReads = () => { pendingReads.invalidate(); warmed.clear(); };
mutator.configure({
  transport: (req) => wired(send(req)).finally(clearReads),
  wire: {
    down: () => wire.down,
    subscribe: (fn) => { wireListeners.add(fn); return () => { wireListeners.delete(fn); }; },
  },
  clearReads,
});
// a save waiting out a retry has nothing on the wire, but the room is not settled: count it as one request
let saving = false;
mutator.subscribePending(() => {
  const now = mutator.pending().length > 0;
  if (now === saving) return;
  saving = now;
  count(now ? 1 : -1);
});

function logEvent(event: string, props?: Record<string, unknown>): void {
  if (wire.down) return;   // offline is read-only: no queue, no console noise
  try { fetch(StrataPath("/api/log"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, props: props || {} }) }).catch(() => {}); } catch { /* ignore */ }
}

// sendBeacon survives a tab close; it can't set X-Session, so the session rides in props.
function logBeacon(event: string, props?: Record<string, unknown>): void {
  if (wire.down) return;
  try {
    const sid = sessionStorage.getItem("__session");
    beacon("/api/log", JSON.stringify({ event, props: { ...(props || {}), session: sid } }));
  } catch { /* ignore */ }
}

// The only client module that may reach /api: every other kind of request lives below.

/** sendBeacon survives a tab closing; fetch keepalive covers browsers that refuse the beacon. */
export function beacon(path: string, body: string): void {
  const url = StrataPath(path);
  try { if (navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return; } catch { /* fall through to fetch */ }
  try { void fetch(url, { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } }).catch(() => {}); } catch { /* never worth an error */ }
}

/** Wraps the global fetch so every request, pdf.js's included, carries X-Session and counts for whenQuiet. */
export function stampSession(): void {
  let session: string | null = null;
  try {
    let sid = sessionStorage.getItem("__session");
    if (!sid) {
      sid = (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, "").slice(0, 16);
      sessionStorage.setItem("__session", sid);
    }
    session = sid;
  } catch { /* logging is never worth an error */ }
  try {
    const orig = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      init = init || {};
      if (session) {
        const h = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
        if (!h.has("X-Session")) h.set("X-Session", session);
        init.headers = h;
      }
      return onWire(orig(input, init));
    };
  } catch { /* no fetch to wrap */ }
}

/** A source's bytes as text; not counted in settled, since a source loading is not a save landing. */
export const StrataSourceText = (board: string, rid: string, gen?: number): Promise<string> =>
  fetch(StrataPath(`/api/boards/${board}/resources/${rid}/raw${gen ? `?v=${gen}` : ""}`)).then((r) => r.text());

/** The gateway's own /api/session, outside this room's mount point (so not under StrataPath). */
export async function StrataGatewaySession(signal?: AbortSignal): Promise<{ adminPath?: string } | null> {
  const r = await fetch("/api/session", { cache: "no-store", redirect: "error", signal });
  return r.ok ? r.json() : null;
}

/** A response for the offline shelf, fetched past every cache. */
export const StrataFetchForShelf = (target: URL): Promise<Response> =>
  fetch(target, { credentials: "same-origin", cache: "no-store" });

export interface ChatStreamCallbacks {
  /** Where the server stored the question; the local echo takes it so the thread shows it once. */
  onStart?(d: { userIdx?: number; replyIdx: number }): void;
  onDelta?(t: string): void;
  onDone?(d: { state?: BoardState; replyIdx: number; messages?: Message[] }): void;
  /** resumable: resending the same question with the same key resumes the turn rather than asking twice. */
  onError?(message: string, resumable: boolean): void;
}

const keyed = (body: unknown, key?: string): RequestInit =>
  ({ method: "POST", headers: { "Content-Type": "application/json", ...(key && { "Idempotency-Key": key }) }, body: JSON.stringify(body) });

// getRandomValues, not randomUUID: the room is also reached over plain http.
function turnKey(): string {
  return "turn-" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const chatStream = (id: string, message: string, cb: ChatStreamCallbacks = {}, here?: Here, signal?: AbortSignal, key?: string, ask?: unknown): Promise<void> =>
  streamTurn(`/api/boards/${id}/chat`, { message, here: here || {}, ...(ask ? { ask } : {}) }, cb, signal, key);

export interface CardTurnBody { card: string; course: string; message: string; rung?: number | null; picked?: number | null }
const cardChatStream = (body: CardTurnBody, cb: ChatStreamCallbacks = {}, signal?: AbortSignal, key?: string): Promise<void> =>
  streamTurn("/api/review/chat", body, cb, signal, key);

async function streamTurn(path: string, body: unknown, cb: ChatStreamCallbacks, signal?: AbortSignal, key?: string): Promise<void> {
  if (wire.down) throw new Error("offline — the model needs the wire");
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (key) headers["Idempotency-Key"] = key;
  const r = await fetch(StrataPath(path), { method: "POST", signal, headers, body: JSON.stringify(body) });
  if (!r.ok || !r.body) {
    let m: string | undefined;
    try { m = ((await r.json()) as { error?: string }).error; } catch { /* non-JSON */ }
    // `status`: the server answered, so the key this turn went under is spent
    throw Object.assign(new Error(m || `HTTP ${r.status}`), { status: r.status });
  }
  await pumpSSE(r, (ev, d) => {
    if (ev === "start") cb.onStart?.(d as { userIdx?: number; replyIdx: number });
    else if (ev === "delta") cb.onDelta?.((d as { t: string }).t);
    else if (ev === "done") cb.onDone?.(d as { state?: BoardState; replyIdx: number; messages?: Message[] });
    else if (ev === "error") cb.onError?.((d as { error?: string }).error || "stream error", (d as { resumable?: boolean }).resumable === true);
  });
}

// a frame that arrives half-written waits for the rest of its bytes rather than throwing
async function pumpSSE(r: Response, dispatch: (ev: string, d: unknown) => void): Promise<void> {
  const reader = r.body!.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, sep); buf = buf.slice(sep + 2);
      let ev = "message", data = "";
      for (const line of frame.split("\n")) { if (line.indexOf("event:") === 0) ev = line.slice(6).trim(); else if (line.indexOf("data:") === 0) data += line.slice(5).trim(); }
      if (!data) continue;
      try { dispatch(ev, JSON.parse(data)); } catch { /* partial frame */ }
    }
  }
}



export const StrataAPI = {
  log: logEvent,
  logBeacon,
  chatStream: (...a: Parameters<typeof chatStream>) => wired(chatStream(...a)),
  turnKey,
  cardChatStream: (...a: Parameters<typeof cardChatStream>) => wired(cardChatStream(...a)),
  cardThread: (course: string, card: string) =>
    api<ThreadPage>(`/api/review/chat?${new URLSearchParams({ course, card })}`),
  logout: () => call<{ ok: boolean }>("POST", "/api/logout", {}),
  touched: (id: string) => api<{ touched: Touched }>(`/api/boards/${id}/touched`),
  seen: (id: string) => api<CardsSeen>(`/api/boards/${id}/seen`),
  getBoard: (id: string) => api<BoardState>(`/api/boards/${id}`),
  resourceRawUrl: (id: string, rid: string) => StrataPath(`/api/boards/${id}/resources/${rid}/raw`),
  resourceLiveUrl: (id: string, rid: string, gen?: number) => StrataPath(`/api/boards/${id}/resources/${rid}/live${gen ? `?v=${gen}` : ""}`),
  resourcePreview: (id: string, rid: string) => api<{lines:string[]}>(`/api/boards/${id}/resources/${rid}/preview`),
  // empty for prose sources and for rows older than extraction
  pageText: (id: string, rid: string) => api<{ pages: string[] }>(`/api/boards/${id}/resources/${rid}/pagetext`).then((j) => j.pages || []),
  capture: (id: string, url: string, key?: string) => api<CaptureResponse>(`/api/boards/${id}/capture`, keyed({ url }, key)),
  captureFinish: (id: string, payload: Record<string, unknown>, key?: string) => api<CaptureFinishResponse>(`/api/boards/${id}/capture/finish`, keyed(payload, key)),
  library: () => api<{ messages: { role: string; text: string; idx: number }[]; cards: { id: string; front: string; back: string; source: string }[]; before: number | null }>("/api/library"),

  cardHistory: (course: string, card: string) => api<CardHistory>(`/api/review/history?course=${encodeURIComponent(course)}&card=${encodeURIComponent(card)}`),
  review: (boot = false) => api<ReviewState>("/api/review", boot ? SNAPSHOT_OK : undefined),
  thread: (board: string, resource: string | null, before?: number) => api<ThreadPage>(
    `/api/boards/${board}/messages?${new URLSearchParams({ ...(resource ? {resource} : {}), ...(before === undefined ? {} : {before:String(before)}) })}`),
  questions: () => api<{ questions: MintedEverywhere[] }>("/api/library/questions"),
  boardStatus: (id: string) => api<BoardStatus>(`/api/boards/${id}/status`),
  // `since` is the reader's local midnight: only the browser knows the timezone
  reviewSession: (since: number) => api<SessionMapResponse>(`/api/review/session?since=${since}`),
  reviewTree: (course: string) => api<ReviewTreeResponse>(`/api/review/tree?course=${encodeURIComponent(course)}`),
  decks: () => api<{ decks: DeckSummary[] }>("/api/decks").then((j) => j.decks || []),
  deck: (slug: string) => api<DeckRead>(`/api/decks/${slug}`),
  warmBoard: (id: string) => prefetch(`/api/boards/${id}`) as Promise<BoardState | null>,
  warmSeen: (id: string) => prefetch(`/api/boards/${id}/seen`),
  warmDeck: (slug: string) => prefetch(`/api/decks/${slug}`),
  deckIgnored: (slug: string) => api<DeckIgnored>(`/api/decks/${slug}/ignored`),
  tidyCard: (b: { type?: string; faces: Record<string, unknown> }) =>
    call<{ faces: Record<string, unknown> }>("POST", "/api/cards/tidy", b),
  deckKeeps: (slug: string) => api<DeckKeepsResponse>(`/api/decks/${slug}/keeps`),
  boardCollection: (id: string) => api<BoardCollectionResponse>(`/api/boards/${id}/collection`),
  libraryCollection: () => api<LibraryCollectionResponse>("/api/collection"),

  // 404 means "not distilled": a state, not an error
  tree: (id: string, rid: string, sid?: string | null) => api<TreeResponse>(`/api/boards/${id}/resources/${rid}/tree${sid ? `?section=${encodeURIComponent(sid)}` : ""}`),
};

