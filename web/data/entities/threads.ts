import type { Message } from "../../../shared/types/index.ts";
import { mutator as roomMutator, type Mutator, type Op } from "../mutate.ts";

// Pages are merged by idx, never replaced: a read answered before a reply was saved must not drop it.

export interface ThreadEntity {
  messages: Message[];
  /** the idx of the oldest message still inside the model's window (0 = all of it) */
  windowFrom: number;
  /** the cursor for the next older page; null = nothing older; undefined = not known yet */
  before?: number | null;
  /** every idx at or below this was cleared on this device: a late read never brings it back */
  floor?: number;
}

export interface ThreadPageIn {
  messages: Message[];
  /** null when the page is the whole thread (or reaches its start) */
  before: number | null | undefined;
  windowFrom?: number;
}

const byIdx = (a: Message, b: Message) => a.idx - b.idx;

/** The newest page of a thread, over what is held. */
export function mergeNewest(held: ThreadEntity | undefined, page: ThreadPageIn): ThreadEntity {
  const floor = held?.floor;
  const fresh = page.messages.filter((m) => floor === undefined || m.idx > floor).sort(byIdx);
  const windowFrom = page.windowFrom ?? held?.windowFrom ?? 0;
  const whole = page.before === null;
  if (!held || !fresh.length) {
    // nothing held, or a page with nothing (past the floor) in it: whole, it is the thread
    if (!held || whole || !page.messages.length) return { messages: fresh, windowFrom, before: whole ? null : page.before, ...(floor === undefined ? {} : { floor }) };
    return { ...held, windowFrom };
  }
  const lo = fresh[0].idx, hi = fresh[fresh.length - 1].idx;
  const beneath = whole ? [] : held.messages.filter((m) => m.idx < lo);
  const newer = held.messages.filter((m) => m.idx > hi);
  return {
    messages: [...beneath, ...fresh, ...newer],
    windowFrom,
    before: whole ? null : (beneath.length ? held.before : page.before),
    ...(floor === undefined ? {} : { floor }),
  };
}

/** An older page (GET …/messages?before=), under what is held. */
export function mergeOlder(held: ThreadEntity | undefined, page: ThreadPageIn): ThreadEntity {
  const floor = held?.floor;
  const fresh = page.messages.filter((m) => floor === undefined || m.idx > floor);
  const have = new Set((held?.messages ?? []).map((m) => m.idx));
  return {
    messages: [...fresh.filter((m) => !have.has(m.idx)), ...(held?.messages ?? [])].sort(byIdx),
    windowFrom: held?.windowFrom ?? 0,
    before: page.before ?? null,
    ...(floor === undefined ? {} : { floor }),
  };
}

/** The thread as this device just cleared it: empty, and closed to a read from before. */
export function cleared(held: ThreadEntity | undefined): ThreadEntity {
  const top = Math.max(held?.floor ?? -1, ...(held?.messages ?? []).map((m) => m.idx));
  return { messages: [], windowFrom: 0, before: null, floor: top };
}

export type ClearTarget = { board: string; rid?: string | null } | { deck: string; card: string };

export const threadOps = {
  /** A board's answer (its new state) is applied by shape; a card thread's carries nothing. */
  clear(target: ClearTarget, lane: string): Op<unknown> {
    const byShape = "board" in target;
    const path = "board" in target
      ? `/api/boards/${target.board}/messages${target.rid ? `?resource=${encodeURIComponent(target.rid)}` : ""}`
      : `/api/review/chat?${new URLSearchParams({ course: target.deck, card: target.card })}`;
    return { label: "clear the conversation", lanes: [lane], method: "DELETE", path, ...(byShape ? {} : { confirm: () => {} }) };
  },
};

/** A failed clear releases its lane, else it would hold every later clear of that thread. */
export const threads = {
  clear: (target: ClearTarget, lane: string, m: Mutator = roomMutator): Promise<unknown> => m.release(threadOps.clear(target, lane)),
};
