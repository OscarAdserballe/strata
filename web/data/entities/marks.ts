import type { Mark, MarkReply } from "../../../shared/types/index.ts";
import { store as roomStore, type Store } from "../store.ts";
import { discard, mintKey, mutator as roomMutator, pending, type Mutator, type Op, type SaveError } from "../mutate.ts";
import { conflicts as roomConflicts, type Conflicts } from "../conflicts.ts";
import { marksKey, revOf } from "./boards.ts";

// A mark's id is its identity, never the op's key: a redo of an undone create is a new act with a new key.

export interface MarkAnswer { id: string; mark: Mark; rev?: number }

/** getRandomValues, not randomUUID: the room is also reached over plain http. */
export const newMarkId = (): string =>
  "mk-" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
export const markLane = (id: string) => `mark:${id}`;
export const newReplyId = (): string =>
  "mr-" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

export type MarkDraft = Omit<Mark, "id" | "note" | "createdAt"> & { id?: string; note?: string | null };

const without = (id: string) => (list: Mark[] | undefined) => (list ?? []).filter((m) => m.id !== id);

export const markOps = {
  create(board: string, draft: MarkDraft, now: () => number = Date.now): Op<MarkAnswer> {
    const id = draft.id ?? newMarkId();
    const mark: Mark = { ...draft, id, note: draft.note ?? null, createdAt: now() };
    return {
      label: "keep that highlight",
      lanes: [markLane(id)],
      method: "POST",
      path: `/api/boards/${board}/marks`,
      body: { ...draft, id },
      optimistic: [{ key: marksKey(board), apply: (list: Mark[] | undefined) => [...without(id)(list), mark] }],
      flush: true,
      waitsOffline: true,
    };
  },

  /** `was`: the note this one was written over; the server refuses it if the note has changed since */
  note(board: string, id: string, note: string | null, was?: string | null): Op<{ mark: Mark; rev?: number }> {
    return {
      label: "save that note",
      lanes: [markLane(id)],
      method: "PATCH",
      path: `/api/boards/${board}/marks/${id}`,
      body: was === undefined ? { note } : { note, was },
      optimistic: [{ key: marksKey(board), apply: (list: Mark[] | undefined) => (list ?? []).map((m) => (m.id === id ? { ...m, note } : m)) }],
      flush: true,
      waitsOffline: true,
    };
  },

  /** in the mark's lane, so a reply never reaches the server before the note it answers */
  reply(board: string, mid: string, id: string, text: string, now: () => number = Date.now, s: Store = roomStore): Op<{ reply: MarkReply; rev?: number }> {
    const reply: MarkReply = { id, author: "you", text: text.trim(), at: now() };
    const withReply = (r: MarkReply) => (list: Mark[] | undefined) => (list ?? []).map((m) => (m.id === mid ? { ...m, replies: [...(m.replies ?? []).filter((x) => x.id !== r.id), r] } : m));
    return {
      label: "send that reply",
      lanes: [markLane(mid)],
      method: "POST",
      path: `/api/boards/${board}/marks/${mid}/replies`,
      body: { id, text },
      optimistic: [{ key: marksKey(board), apply: withReply(reply) }],
      // the answer carries no mark, so the reply is written into its mark here or it would vanish with the optimistic copy
      confirm: (res, meta) => { s.patch<Mark[]>(marksKey(board), revOf(res?.rev), withReply(res?.reply ?? reply), { epoch: meta.epoch, stamp: meta.rev }); },
      flush: true,
      waitsOffline: true,
    };
  },

  /** `undo` is for the log only: ⌘Z taking a mark back, not a mark judged wrong */
  remove(board: string, id: string, undo = false, s: Store = roomStore): Op<{ ok: boolean; id: string; rev?: number }> {
    return {
      label: "remove that highlight",
      lanes: [markLane(id)],
      method: "DELETE",
      path: `/api/boards/${board}/marks/${id}${undo ? "?undo=1" : ""}`,
      optimistic: [{ key: marksKey(board), apply: without(id) }],
      confirm: (res, meta) => { s.patch<Mark[]>(marksKey(board), revOf(res?.rev), without(id), { epoch: meta.epoch, stamp: meta.rev }); },
      flush: true,
      waitsOffline: true,
    };
  },
};

/** One mark act as it waits on the device: enough to rebuild its op in a later tab. */
export type MarkIntent = { key: string; at: number; board: string; mid: string; quote: string; offline: boolean } & (
  | { kind: "create"; draft: MarkDraft }
  | { kind: "note"; note: string | null; was: string | null }
  | { kind: "reply"; id: string; text: string }
  | { kind: "remove"; undo: boolean }
);
type Ask = MarkIntent extends infer I ? I extends MarkIntent ? Omit<I, "key" | "at" | "quote" | "offline" | "was"> : never : never;

export interface Shelf { put(id: string, value: string): void; drop(id: string): void; all(): string[] }
const OUTBOX = "strata.outbox.mark.";
const localShelf: Shelf = {
  put: (id, value) => { try { localStorage.setItem(OUTBOX + id, value); } catch { /* private window or full: the act still rides the tab */ } },
  drop: (id) => { try { localStorage.removeItem(OUTBOX + id); } catch { /* no storage */ } },
  all: () => {
    const out: string[] = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(OUTBOX)) out.push(localStorage.getItem(k) ?? ""); } }
    catch { /* no storage */ }
    return out;
  },
};
const noShelf: Shelf = { put: () => {}, drop: () => {}, all: () => [] };

function opOf(i: MarkIntent, s: Store): Op<unknown> {
  const op = i.kind === "create" ? markOps.create(i.board, { ...i.draft, id: i.mid })
    : i.kind === "note" ? markOps.note(i.board, i.mid, i.note, i.offline ? i.was : undefined)
    : i.kind === "reply" ? markOps.reply(i.board, i.mid, i.id, i.text, Date.now, s)
    : markOps.remove(i.board, i.mid, i.undo, s);
  return { ...op, key: i.key } as Op<unknown>;
}

/** Keeps every mark act on the device until the server answers, so a highlight made on the plane survives a closed tab. */
export class MarkOutbox {
  private readonly sent = new Set<string>();
  private readonly m: Mutator;
  private readonly s: Store;
  private readonly shelf: Shelf;
  private readonly clashes: Conflicts;
  private readonly down: () => boolean;
  private readonly now: () => number;
  constructor(m: Mutator = roomMutator, s: Store = roomStore, shelf: Shelf = typeof localStorage === "undefined" ? noShelf : localShelf,
    clashes: Conflicts = roomConflicts, down: () => boolean = () => m.wireDown(), now: () => number = Date.now) {
    this.m = m; this.s = s; this.shelf = shelf; this.clashes = clashes; this.down = down; this.now = now;
  }

  send(ask: Ask): Promise<any> {
    const shown = this.s.get<Mark[]>(marksKey(ask.board))?.find((x) => x.id === ask.mid);
    const quote = ask.kind === "create" ? String(ask.draft.quote ?? "") : shown?.quote ?? "";
    const intent = { ...ask, key: mintKey(), at: this.now(), quote, offline: this.down(),
      ...(ask.kind === "note" ? { was: shown?.note ?? null } : {}) } as MarkIntent;
    this.shelf.put(intent.key, JSON.stringify(intent));
    return this.go(intent);
  }

  /** Puts back on the wire the acts an earlier tab never heard answered; each keeps its key, so a replay is harmless. */
  restore(): number {
    const left: MarkIntent[] = [];
    for (const raw of this.shelf.all()) {
      try { const i = JSON.parse(raw) as MarkIntent; if (i && typeof i.key === "string" && !this.sent.has(i.key)) left.push(i); } catch { /* torn write */ }
    }
    left.sort((a, b) => a.at - b.at);
    for (const i of left) void this.go({ ...i, offline: true }).catch(() => {});
    return left.length;
  }

  private go(i: MarkIntent): Promise<any> {
    this.sent.add(i.key);
    return this.m.mutate(opOf(i, this.s)).then(
      (res) => { this.shelf.drop(i.key); this.sent.delete(i.key); return res; },
      (e: SaveError) => {
        // still owed: a later reconnect or open sends it again
        if (e?.retryable || e?.status === 0) throw e;
        this.shelf.drop(i.key);
        this.sent.delete(i.key);
        if (i.offline) this.clashed(i, e);
        throw e;
      },
    );
  }

  private clashed(i: MarkIntent, e: SaveError): void {
    if (i.kind === "remove") return;                  // already gone is what was wanted
    const theirs = (e.conflict?.value as { note?: string | null } | undefined)?.note ?? null;
    const why = e.status === 409 && e.conflict ? "the note was changed on another device"
      : i.kind === "create" ? "its source is no longer on the board"
      : "the highlight was removed on another device";
    const mine = i.kind === "create" ? i.draft.note ?? null : i.kind === "note" ? i.note : i.text;
    this.clashes.add({ id: i.key, at: i.at, board: i.board, mid: i.mid, kind: i.kind, quote: i.quote, mine, theirs, why,
      ...(e.status === 409 && e.conflict ? { canKeep: true } : {}) });
  }
}

export const markOutbox = new MarkOutbox();

export const marks = {
  create: (board: string, draft: MarkDraft) => markOutbox.send({ kind: "create", board, mid: draft.id ?? newMarkId(), draft }) as Promise<MarkAnswer>,
  note: (board: string, id: string, note: string | null) => markOutbox.send({ kind: "note", board, mid: id, note }) as Promise<{ mark: Mark; rev?: number }>,
  reply: (board: string, mid: string, text: string) => markOutbox.send({ kind: "reply", board, mid, id: newReplyId(), text }),
  remove: (board: string, id: string, undo = false) => markOutbox.send({ kind: "remove", board, mid: id, undo }),
  /** Settles a clash over a note: send it over what is there now, or take what is there. */
  keep: (board: string, id: string, note: string | null) => roomMutator.mutate(markOps.note(board, id, note)),
  /** Gives up on a failed create and what waits behind it, so the page shows what the server has. */
  abandon: (id: string) => { for (const op of pending()) if (op.lanes.includes(markLane(id))) discard(op.id); },
};
