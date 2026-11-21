import type { Mark, MarkReply } from "../../../shared/types/index.ts";
import { store as roomStore, type Store } from "../store.ts";
import { discard, mutate, pending, type Op } from "../mutate.ts";
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

const markIn = (s: Store, board: string, id: string): Mark | undefined => s.get<Mark[]>(marksKey(board))?.find((m) => m.id === id);
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
      revive: { kind: "mark.create", args: [board, { ...draft, id }, mark.createdAt] },
    };
  },

  /** `was` is the note this edit was written over: the server refuses it with a 409 if the note has changed since. */
  note(board: string, id: string, note: string | null, was: string | null | undefined = markIn(roomStore, board, id)?.note ?? null): Op<{ mark: Mark; rev?: number }> {
    return {
      label: "save that note",
      lanes: [markLane(id)],
      method: "PATCH",
      path: `/api/boards/${board}/marks/${id}`,
      body: was === undefined ? { note } : { note, was },
      optimistic: [{ key: marksKey(board), apply: (list: Mark[] | undefined) => (list ?? []).map((m) => (m.id === id ? { ...m, note } : m)) }],
      flush: true,
      revive: { kind: "mark.note", args: [board, id, note, was] },
      clash: (conflict) => {
        const theirs = (conflict.value as { note?: string | null } | null)?.note ?? null;
        const quote = markIn(roomStore, board, id)?.quote ?? "";
        return {
          where: quote ? `note on “${quote.length > 80 ? `${quote.slice(0, 80)}…` : quote}”` : "a note on a passage",
          mine: note ?? "", theirs: theirs ?? "",
          // sent over theirs, so it lands even if theirs is what the server holds now
          keepMine: { kind: "mark.note", args: [board, id, note, theirs] },
          ref: `${board}/${id}`,
        };
      },
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
      revive: { kind: "mark.reply", args: [board, mid, id, text, reply.at] },
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
      revive: { kind: "mark.remove", args: [board, id, undo] },
    };
  },
};

export const marks = {
  create: (board: string, draft: MarkDraft) => mutate(markOps.create(board, draft)),
  note: (board: string, id: string, note: string | null) => mutate(markOps.note(board, id, note)),
  reply: (board: string, mid: string, text: string) => mutate(markOps.reply(board, mid, newReplyId(), text)),
  remove: (board: string, id: string, undo = false) => mutate(markOps.remove(board, id, undo)),
  /** Gives up on a failed create and what waits behind it, so the page shows what the server has. */
  abandon: (id: string) => { for (const op of pending()) if (op.lanes.includes(markLane(id))) discard(op.id); },
};
