import { useMemo, useRef } from "react";
import type { BoardPlan, BoardState, Minted } from "../../../shared/types/index.ts";
import { sameData, store as roomStore, useEntity, type ApplyMeta, type Store } from "../store.ts";
import { mergeNewest, type ThreadEntity } from "./threads.ts";

// A board snapshot is split into per-part keys, each ordered by rev, so a late older snapshot changes none.

export type BoardEntity = Pick<BoardState, "board" | "resources" | "budget" | "deck" | "pairs" | "sections" | "trees" | "touched" | "windowFrom" | "mintedEverywhere">;
export interface NotesEntity { text: string; notesRev: number }
export type PlanEntity = BoardPlan & { rev: number };
export type AuthoredRow = Minted & { rev?: number };
export type { ThreadEntity };

export type RevisionedBoardState = BoardState & { rev?: number; notesRev?: number; plan: BoardPlan & { rev?: number }; minted: AuthoredRow[] };

export const boardKey = (id: string) => `board:${id}`;
export const notesKey = (id: string) => `notes:${id}`;
export const marksKey = (id: string) => `marks:${id}`;
export const asksKey = (id: string) => `asks:${id}`;
export const planKey = (id: string) => `plan:${id}`;
export const authoredKey = (id: string) => `authored:${id}`;
export const threadKey = (id: string, resourceId: string | null) => `thread:${id}/${resourceId ?? ""}`;

export const revOf = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

export const THREAD_PAGE = 100;

export interface BoardMeta {
  epoch?: string;
  stamp?: number;
  origin?: "wire" | "shelf";
  /** Which thread the page is (null = the board's own); left out, it is read from the page's messages. */
  thread?: string | null;
}

/** Split a snapshot into its keys, in one notification. True when the board key took it. */
export function applyBoardState(state: BoardState, meta: BoardMeta = {}, s: Store = roomStore): boolean {
  const st = state as RevisionedBoardState;
  const id = st.board.id;
  const rev = revOf(st.rev);
  const origin = meta.origin ?? "wire";
  const at: ApplyMeta & { epoch: string } = { epoch: meta.epoch ?? "", stamp: meta.stamp, equal: sameData };
  return s.batch(() => {
    const before = s.entry<BoardEntity>(boardKey(id));
    const board: BoardEntity = {
      board: st.board, resources: st.resources ?? [], budget: st.budget, deck: st.deck ?? null, pairs: st.pairs ?? [],
      sections: st.sections ?? [], trees: st.trees ?? {}, touched: st.touched ?? {}, windowFrom: st.windowFrom ?? {},
      mintedEverywhere: st.mintedEverywhere ?? [],
    };
    const took = s.apply(boardKey(id), rev, board, origin, at);
    // the log by its own revision, as a save's answer and a 409's text are (entities/notes.ts)
    s.apply<NotesEntity>(notesKey(id), revOf(st.notesRev), { text: st.notes ?? "", notesRev: revOf(st.notesRev) }, origin, at);
    s.apply(marksKey(id), rev, st.marks ?? [], origin, at);
    s.apply(asksKey(id), rev, st.asks ?? [], origin, at);
    if (st.plan) s.apply<PlanEntity>(planKey(id), rev, { ...st.plan, rev: revOf(st.plan.rev) }, origin, at);
    s.apply(authoredKey(id), rev, st.minted ?? [], origin, at);
    applyThreadPage(s, id, st, rev, origin, at, meta.thread);
    // a section whose tree just turned ready has a new deck, which no answer carried
    if (took && before?.held && before.base) {
      for (const [sid, tree] of Object.entries(board.trees)) {
        if (tree?.status === "ready" && before.base.trees?.[sid]?.status !== "ready") s.invalidate([`deck:src-${sid}`]);
      }
    }
    return took;
  });
}

// The route re-renders only when what it draws changes, not when reading stats or touched counts move.
const drawnOf = ({ touched, windowFrom, resources, ...drawn }: BoardEntity) =>
  [drawn, resources.map(({ read, readPct, readMs, lastReadAt, ...r }) => r)];
export const sameDrawn = (a: BoardEntity, b: BoardEntity): boolean => sameData(drawnOf(a), drawnOf(b));
export const keepDrawn = (was: BoardEntity | undefined, v: BoardEntity | undefined): BoardEntity | undefined =>
  v && was && sameDrawn(was, v) ? was : v;

export type BoardView = BoardEntity & { minted: AuthoredRow[] };

/** A new view only when what the board draws or its authored rows change; null with no board open. */
export function useBoardView(id: string | null, s: Store = roomStore): BoardView | null {
  const drawn = useRef<BoardEntity | undefined>(undefined);
  const entity = useEntity<BoardEntity, BoardEntity | undefined>(boardKey(id ?? ""), (v) => (drawn.current = keepDrawn(drawn.current, v)), s);
  const minted = useEntity<AuthoredRow[]>(authoredKey(id ?? ""), undefined, s);
  return useMemo(() => (entity ? { ...entity, minted: minted ?? [] } : null), [entity, minted]);
}

/* A page shorter than THREAD_PAGE is the whole thread; a full page keeps older pages beneath it. */
function applyThreadPage(s: Store, id: string, st: BoardState, rev: number, origin: "wire" | "shelf", at: ApplyMeta, thread: string | null | undefined): void {
  const page = [...(st.messages ?? [])].sort((a, b) => a.idx - b.idx);
  if (thread === undefined && !page.length) return;
  const scope = thread !== undefined ? (thread ?? "") : (page[0]?.resourceId ?? "");
  const key = threadKey(id, scope || null);
  const held = s.entry<ThreadEntity>(key);
  const full = page.length >= THREAD_PAGE;
  // a page covers part of the thread: the merge, not the snapshot's rev, decides what stays
  s.apply<ThreadEntity>(key, Math.max(rev, held?.rev ?? 0), mergeNewest(held?.base, {
    messages: page, before: full ? undefined : null, windowFrom: st.windowFrom?.[scope] ?? 0,
  }), origin, at);
}
