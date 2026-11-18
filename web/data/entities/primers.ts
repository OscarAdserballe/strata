import type { BoardState, PrimerMeta, ResourceMeta } from "../../../shared/types/index.ts";
import { StrataAPI, StrataAnswer } from "../api.ts";
import { store as roomStore, type Store } from "../store.ts";
import { mutator, type Mutator, type Op } from "../mutate.ts";
import { run } from "./sources.ts";
import { applyBoardState, boardKey, type BoardEntity } from "./boards.ts";

// Asking for a primer: the answer carries the board, whose resources say each source's primer.

export interface PrimerAsked { asked: boolean; woke: boolean; state: BoardState }
export interface BoardPrimersAsked { asked: number; left: number; woke: boolean; state: BoardState }

export const primerLane = (rid: string) => `primer:${rid}`;
export const boardPrimersLane = (board: string) => `primers:${board}`;

/** The source shown as asked for at once; one it already had keeps showing while the new one is written. */
export const askedOn = (rid: string, at: number) => (bd: BoardEntity | undefined): BoardEntity | undefined => bd && {
  ...bd,
  resources: bd.resources.map((r: ResourceMeta) => r.id !== rid || r.primer?.status === "requested" ? r
    : { ...r, primer: { status: "requested", requestedAt: at, builtAt: r.primer?.builtAt ?? null } satisfies PrimerMeta }),
};

export const primerOps = {
  request(board: string, rid: string, now = Date.now()): Op<PrimerAsked> {
    return {
      label: "ask for that primer", lanes: [primerLane(rid), boardPrimersLane(board)], method: "POST",
      path: `/api/boards/${board}/resources/${rid}/primer`,
      optimistic: [{ key: boardKey(board), apply: askedOn(rid, now) }],
    };
  },
  board(board: string): Op<BoardPrimersAsked> {
    return { label: "ask for this board's primers", lanes: [boardPrimersLane(board)], method: "POST", path: `/api/boards/${board}/primers` };
  },
};

export const primers = {
  request: (board: string, rid: string, m: Mutator = mutator) => run(primerOps.request(board, rid), m),
  board: (board: string, m: Mutator = mutator) => run(primerOps.board(board), m),
  /** An agent's primer lands with no write of ours to carry it: past the rev held, the board is read again. True when it was. */
  async catchUp(board: string, rev: number | undefined, s: Store = roomStore, read = StrataAPI.getBoard): Promise<boolean> {
    if (!rev || rev <= (s.entry(boardKey(board))?.rev ?? 0)) return false;
    const st = await read(board);
    applyBoardState(st, StrataAnswer(st) ?? { epoch: s.entry(boardKey(board))?.epoch ?? "" }, s);
    return true;
  },
};
