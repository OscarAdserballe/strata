import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Message } from "../../../shared/types/index.ts";
import { StrataAPI, StrataWhy, StrataWireDown, type ChatStreamCallbacks } from "../../data/api.ts";
import { sameData, store, useEntity } from "../../data/store.ts";
import { call } from "../../data/mutate.ts";
import { applyBoardState, boardKey } from "../../data/entities/boards.ts";
import { cleared, mergeNewest, mergeOlder, threads, type ThreadEntity } from "../../data/entities/threads.ts";
import { wireHere, type Here, type WireHere } from "../../shell/here.ts";
import { LIBRARY_BOARD, parseThread, storeKeyOf, type ParsedThread, type ThreadKey } from "./threads.ts";
// the turn in flight lives outside any component, so leaving mid-reply does not abort the stream

export { cardThreadKey, LIBRARY_BOARD, parseThread, storeKeyOf, threadFor } from "./threads.ts";
export type { ParsedThread, ThreadKey } from "./threads.ts";

const boardOf = (p: ParsedThread): { board: string; rid: string | null } | null =>
  p.kind === "library" ? { board: LIBRARY_BOARD, rid: null } : p.kind === "board" ? { board: p.board, rid: p.source } : null;

export interface TurnState {
  text: string;
  reply: string;
  sending: boolean;
  error: string;
  /** the words the turn is asked at, when it is */
  ask: string | null;
}
/** Words a question is asked at, as the chat route takes them. */
export interface AskWire { id: string; start: number; end: number; quote: string; page: number | null; rects: number[][]; box: string | null }
interface TurnRecord extends TurnState {
  ikey: string;
  /** kept so a resumed turn sends the same body (a changed body is a 422) */
  wire: unknown;
  resumable: boolean;
  controller: AbortController | null;
  askAt: AskWire | null;
}

const turns = new Map<ThreadKey, TurnRecord>();
const listeners = new Map<ThreadKey, Set<() => void>>();
const drafts = new Map<ThreadKey, string>();
const NO_TURN: TurnState = Object.freeze({ text: "", reply: "", sending: false, error: "", ask: null });

function setTurn(key: ThreadKey, next: TurnRecord | null): void {
  if (next) turns.set(key, next); else turns.delete(key);
  const set = listeners.get(key);
  if (set) for (const fn of [...set]) fn();
}
function subscribeTurn(key: ThreadKey, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, set = new Set());
  set.add(fn);
  return () => { set.delete(fn); };
}

/** The turn in flight or left over on a thread, for what draws outside React. */
export const turnOf = (key: ThreadKey): TurnState => turns.get(key) ?? NO_TURN;
export const onTurn = (key: ThreadKey, fn: () => void): (() => void) => subscribeTurn(key, fn);

export const draftOf = (key: ThreadKey | null): string => (key ? drafts.get(key) ?? "" : "");
export function setDraft(key: ThreadKey | null, text: string): void {
  if (!key) return;
  if (text) drafts.set(key, text); else drafts.delete(key);
}

function merge(sk: string, fn: (held: ThreadEntity | undefined) => ThreadEntity): void {
  const held = store.entry<ThreadEntity>(sk);
  store.apply<ThreadEntity>(sk, held?.rev ?? 0, fn(held?.base), "wire", { epoch: held?.epoch ?? "", equal: sameData });
}

export function loadThread(key: ThreadKey): Promise<void> {
  const p = parseThread(key);
  if (!p) return Promise.resolve();
  const b = boardOf(p);
  const sk = storeKeyOf(key);
  return (b ? StrataAPI.thread(b.board, b.rid) : StrataAPI.cardThread(p.kind === "card" ? p.deck : "", p.kind === "card" ? p.card : "")).then(
    (page) => merge(sk, (held) => mergeNewest(held, { messages: page.messages, before: page.before })),
    (e: { status?: number } | null) => {
      // the library's board is made on its first question; until then its thread is empty
      if (e?.status === 404 && !store.entry(sk)?.held) merge(sk, () => ({ messages: [], windowFrom: 0, before: null }));
    },
  );
}

export async function loadEarlier(key: ThreadKey): Promise<void> {
  const p = parseThread(key);
  const b = p && boardOf(p);
  const sk = storeKeyOf(key);
  const before = store.get<ThreadEntity>(sk)?.before;
  if (!b || typeof before !== "number") return;
  const page = await StrataAPI.thread(b.board, b.rid, before);
  merge(sk, (held) => mergeOlder(held, { messages: page.messages, before: page.before }));
}

const INTERRUPTED = "The reply was interrupted. Your question is back in the line to try again.";
const OFFLINE = "Offline — the model needs the wire. Your question is still in the line.";

export async function sendTurn(key: ThreadKey, text: string, h: Here, askAt: AskWire | null = null): Promise<void> {
  const p = parseThread(key);
  const q = text.trim();
  const was = turns.get(key);
  if (!p || !q || was?.sending) return;
  if (StrataWireDown()) {
    setDraft(key, text);
    // a new body under a known idempotency key is a 422, so only the same question reuses it
    const same = was && was.text === q && was.ask === (askAt?.id ?? null) ? was : null;
    setTurn(key, { ikey: same?.ikey ?? "", wire: same?.wire ?? null, resumable: !!same?.resumable, controller: null, text: q, reply: "", sending: false, error: OFFLINE, ask: askAt?.id ?? null, askAt });
    return;
  }
  setDraft(key, "");
  const b = boardOf(p);
  const again = !!was && was.resumable && was.text === q && was.ask === (askAt?.id ?? null);
  const ikey = again ? was.ikey : StrataAPI.turnKey();
  const c = h.card;
  const wire = again && was.wire ? was.wire
    : b ? { ...wireHere(h), thread: b.rid } : { rung: c?.rung ?? null, picked: c?.picked ?? null };
  const controller = new AbortController();
  setTurn(key, { text: q, reply: "", sending: true, error: "", ikey, wire, resumable: false, controller, ask: askAt?.id ?? null, askAt });
  const mine = () => turns.get(key)?.ikey === ikey;
  const update = (patch: Partial<TurnRecord>) => { const cur = turns.get(key); if (cur && cur.ikey === ikey) setTurn(key, { ...cur, ...patch }); };

  // the echo takes idx `start` so a mid-reply read merges with it instead of showing it twice
  const sk = storeKeyOf(key);
  const echo = (idx: number) => store.apply<ThreadEntity>(sk, null, (v) => {
    const base: ThreadEntity = v ?? { messages: [], windowFrom: 0, before: null };
    if (base.messages.some((m) => m.idx === idx)) return base;
    return { ...base, messages: [...base.messages, { role: "user", text: q, idx, resourceId: b?.rid ?? null, ask: askAt?.id ?? null, local: true } as Message] };
  }, "optimistic", { op: ikey });
  let unecho = echo(Number.MAX_SAFE_INTEGER);

  let acc = "", done = false, over = false, error = "", aborted = false;
  try {
    const cb: ChatStreamCallbacks = {
      onStart: (d) => { if (typeof d.userIdx === "number") { const off = unecho; unecho = echo(d.userIdx); off(); } },
      onDelta: (t) => { acc += t; update({ reply: acc.replace(/^\s+/, "") }); },
      onDone: (d) => {
        done = over = true;
        // one notification, so the thread never shows both the answer and the echo
        store.batch(() => {
          // SSE frames carry no epoch: read under the held one, or the store takes it for a new boot
          if (d.state && b) applyBoardState(d.state, { thread: b.rid, epoch: store.entry(boardKey(d.state.board.id))?.epoch ?? "" });
          if (d.messages) merge(sk, (held) => mergeNewest(held, { messages: d.messages!, before: null }));
          unecho();
        });
        // a replayed turn from an older server carries neither: re-read the thread
        if (!d.messages && !(d.state && b)) void loadThread(key).catch(() => {});
      },
      onError: (m, resumable) => { over = !resumable; error = "Couldn't reach the model — " + m; },
    };
    if (p.kind === "card") await StrataAPI.cardChatStream({ card: p.card, course: p.deck, message: q, ...(wire as object) }, cb, controller.signal, ikey);
    else await StrataAPI.chatStream(p.kind === "library" ? (await call<{ id: string }>("POST", "/api/register/inbox", {})).id : b!.board, q, cb, wire as WireHere, controller.signal, ikey, askAt);
  } catch (e) {
    if ((e as Error | null)?.name === "AbortError") aborted = true;
    // the server answered (a refusal): that key is spent
    else { if ((e as { status?: number } | null)?.status) over = true; error = StrataWhy(e, "Couldn't reach the model"); }
  } finally {
    unecho();
    if (!mine()) { /* cleared, or another turn took the thread */ }
    else if (done || aborted) setTurn(key, null);
    else {
      if (!draftOf(key)) setDraft(key, q);
      setTurn(key, { text: q, reply: acc.replace(/^\s+/, ""), sending: false, error: error || INTERRUPTED, ikey, wire, resumable: !over, controller: null, ask: askAt?.id ?? null, askAt });
      void loadThread(key).catch(() => {});
    }
  }
}

export async function clearThread(key: ThreadKey): Promise<void> {
  const p = parseThread(key);
  if (!p) return;
  const sk = storeKeyOf(key);
  const was = store.get<ThreadEntity>(sk);
  const b = boardOf(p);
  if (b) await threads.clear({ board: b.board, rid: b.rid }, sk);
  else if (p.kind === "card") await threads.clear({ deck: p.deck, card: p.card }, sk);
  turns.get(key)?.controller?.abort();
  setTurn(key, null);
  // empty, and closed to any read that left before the clear
  merge(sk, () => cleared(was));
}

export interface Thread {
  messages: Message[];
  windowFrom: number;
  canLoadEarlier: boolean;
  turn: TurnState;
}

const shown = (m: Message) => m.idx > 0 || m.role === "user";

export function useThread(key: ThreadKey | null, wanted = true): Thread {
  const entity = useEntity<ThreadEntity, ThreadEntity | undefined>(storeKeyOf(key));
  const subscribe = useCallback((fn: () => void) => (key ? subscribeTurn(key, fn) : () => {}), [key]);
  const read = () => (key ? turns.get(key) ?? NO_TURN : NO_TURN);
  const turn = useSyncExternalStore(subscribe, read, read);
  useEffect(() => { if (key && wanted) void loadThread(key).catch(() => {}); }, [key, wanted]);
  const messages = useMemo(() => entity?.messages.filter(shown) ?? [], [entity]);
  return { messages, windowFrom: entity?.windowFrom ?? 0, canLoadEarlier: typeof entity?.before === "number", turn };
}
