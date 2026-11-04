import type { Board, BoardListEntry, BoardState, RegisterEntry, RegisterResponse } from "../../../shared/types/index.ts";
import type { Heading } from "../../../shared/imports/import-plan.ts";
import { fetched } from "../api.ts";
import { store as roomStore, type Fetcher, type Store } from "../store.ts";
import { call, mutator, type Mutator, type Op, type SaveError } from "../mutate.ts";
import { boardKey, type BoardEntity } from "./boards.ts";
import { confirmByShape, type ConfirmMeta } from "./confirm.ts";

// Filing names the source and both boards' lanes, so a file into a board being deleted is refused, not lost.

export const REGISTER = "register";
export const BOARDS = "boards";
const DECK_TAGS = ["decks", "review", "collection"];

export const sourceLane = (rid: string) => `source:${rid}`;
export const pairLane = (pid: string) => `pair:${pid}`;
export const boardLane = (id: string) => `board:${id}`;

export interface WithState { state: BoardState }
export interface Moved { to: string; state: BoardState; destState: BoardState }
export interface Created { board: Board; state: BoardState }
export interface Distilling { status: string; sections?: number }

type Change<T> = (v: T) => T;
const onEntries = (fn: (e: RegisterEntry[]) => RegisterEntry[]): Change<RegisterResponse | undefined> =>
  (reg) => (reg ? { ...reg, entries: fn(reg.entries ?? []) } : reg) as RegisterResponse;
const onBoards = (fn: (b: BoardListEntry[]) => BoardListEntry[]): Change<BoardListEntry[] | undefined> =>
  (list) => (list ? fn(list) : list) as BoardListEntry[];

export const lists = {
  renameSource: (rid: string, name: string) => onEntries((es) => es.map((e) => (e.resourceId === rid ? { ...e, filename: name } : e))),
  renameListedSource: (rid: string, name: string) => onBoards((bs) => bs.map((b) => {
    const has = b.resources?.some((r) => r.id === rid);
    const last = b.lastRead?.resourceId === rid;
    if (!has && !last) return b;
    return {
      ...b,
      ...(has ? { resources: b.resources.map((r) => (r.id === rid ? { ...r, filename: name } : r)) } : {}),
      ...(last ? { lastRead: { ...b.lastRead!, filename: name } } : {}),
    };
  })),
  dropSource: (rid: string) => onEntries((es) => es.filter((e) => e.resourceId !== rid)),
  fileSource: (rid: string, to: string, title: string) =>
    onEntries((es) => es.map((e) => (e.resourceId === rid ? { ...e, boardId: to, boardTitle: title, unfiled: false } : e))),
  renameBoardEntries: (id: string, title: string) => onEntries((es) => es.map((e) => (e.boardId === id ? { ...e, boardTitle: title } : e))),
  dropBoardEntries: (id: string) => onEntries((es) => es.filter((e) => e.boardId !== id)),
  renameBoard: (id: string, title: string) => onBoards((bs) => bs.map((b) => (b.id === id ? { ...b, title } : b))),
  retitle: (title: string): Change<BoardEntity | undefined> => (bd) => (bd ? { ...bd, board: { ...bd.board, title } } : bd),
  dropBoard: (id: string) => onBoards((bs) => bs.filter((b) => b.id !== id)),
  /** newest first: a board just made is by definition the most recently touched */
  addBoard: (board: Board) => onBoards((bs) => [{ resources: [], msgCount: 0, touchedAt: Date.now(), ...board } as BoardListEntry, ...bs.filter((b) => b.id !== board.id)]),
};

interface ListChange { key: string; apply: Change<any> }

/** The guess, also folded into the held list on the answer so nothing flickers back before the reread. */
function listOp<Res>(op: Omit<Op<Res>, "optimistic" | "confirm">, changes: ListChange[], s: Store, after?: (res: Res, meta: ConfirmMeta) => void): Op<Res> {
  return {
    ...op,
    optimistic: changes.map((c) => ({ key: c.key, apply: c.apply })),
    confirm: (res, meta) => {
      s.batch(() => {
        confirmByShape(op, res, meta, s);
        for (const c of changes) s.patch(c.key, 0, c.apply);
        after?.(res, meta);
      });
    },
  };
}

export const sourceOps = {
  /** The source and, when it stands as one pair, that pair, in one request. */
  rename(board: string, rid: string, name: string, s: Store = roomStore): Op<WithState> {
    return listOp({
      label: "rename that", lanes: [sourceLane(rid)], method: "PATCH",
      path: `/api/boards/${board}/resources/${rid}`, body: { filename: name, pair: true },
      invalidates: [REGISTER, BOARDS],
    }, [
      { key: REGISTER, apply: lists.renameSource(rid, name) },
      { key: BOARDS, apply: lists.renameListedSource(rid, name) },
    ], s);
  },
  done(board: string, rid: string, done: boolean): Op<WithState> {
    return {
      label: done ? "mark that done" : "take that back", lanes: [sourceLane(rid)], method: "PATCH",
      path: `/api/boards/${board}/resources/${rid}`, body: { done },
      invalidates: [REGISTER],
    };
  },
  /** The whole source: its pages, its sections' decks, its marks. */
  remove(board: string, rid: string, s: Store = roomStore): Op<WithState> {
    return listOp({
      label: "delete that", lanes: [sourceLane(rid)], method: "DELETE",
      path: `/api/boards/${board}/resources/${rid}?pairs=1`,
      invalidates: [REGISTER, BOARDS, ...DECK_TAGS],
    }, [{ key: REGISTER, apply: lists.dropSource(rid) }], s);
  },
  /** A page with no source; its deck too if this was its last door. */
  removePair(board: string, pid: string): Op<WithState> {
    return {
      label: "delete that", lanes: [pairLane(pid)], method: "DELETE",
      path: `/api/boards/${board}/pairs/${pid}?deck=1`,
      invalidates: [...DECK_TAGS],
    };
  },
  /** Filing moves the source's pair (and so the source) to another board. */
  file(from: string, pid: string, rid: string, to: string, toTitle: string, s: Store = roomStore): Op<Moved> {
    return listOp({
      label: "file that", lanes: [sourceLane(rid), boardLane(from), boardLane(to)], method: "POST",
      path: `/api/boards/${from}/pairs/${pid}/move`, body: { to },
      invalidates: [REGISTER, BOARDS, "collection"],
    }, [{ key: REGISTER, apply: lists.fileSource(rid, to, toTitle) }], s);
  },
  /** Read the source again (a no-op on the server while it is already being read). */
  distil(board: string, rid: string): Op<Distilling> {
    return {
      label: "start that", lanes: [sourceLane(rid)], method: "POST",
      path: `/api/boards/${board}/resources/${rid}/distil`,
    };
  },
  /** A new split replaces the whole one it was chosen over; a 409 fails it rather than overwrite another's. */
  resplit(board: string, rid: string, plan: SplitPlan, base: number): Op<Resplit> {
    return {
      label: "change those sections", lanes: [sourceLane(rid)], method: "PUT",
      path: splitPath(board, rid), body: { plan }, base: () => base,
      invalidates: [splitKey(rid), ...DECK_TAGS],
    };
  },
};

export interface SplitPlan { outline: Heading[]; starts: number[]; excluded: number[] }
export interface SplitChoice {
  title: string; outline: Heading[]; defaultStarts: number[]; pageText: string[]; budgetTokens: number;
  hasBookmarks: boolean; startByPages: boolean; plan: SplitPlan; rev: number;
}
export interface Resplit extends WithState { sections: number; refiled: number; queued: number; rev: number }
export const splitKey = (rid: string) => `split:${rid}`;
export const splitPath = (board: string, rid: string) => `/api/boards/${board}/resources/${rid}/sections`;
export const splitRead = (board: string, rid: string): Fetcher<SplitChoice> => () => fetched<SplitChoice>(splitPath(board, rid), (v) => v.rev);

export const boardOps = {
  create(opts: { question?: string; title?: string }, s: Store = roomStore): Op<Created> {
    return {
      label: "make a board", lanes: ["board:new"], method: "POST", path: "/api/boards", body: opts,
      invalidates: [BOARDS],
      confirm: (res, meta) => {
        s.batch(() => {
          confirmByShape({ path: "/api/boards" }, res, meta, s);
          if (res?.board) s.patch(BOARDS, 0, lists.addBoard(res.board));
        });
      },
    };
  },
  /** Each rename's guess is its own layer, so two renames in flight never take off each other's. */
  rename(id: string, title: string, s: Store = roomStore): Op<{ board: Board } & WithState> {
    return listOp({
      label: "rename the board", lanes: [boardLane(id)], method: "PATCH", path: `/api/boards/${id}`, body: { title },
      invalidates: [BOARDS, REGISTER],
    }, [
      { key: BOARDS, apply: lists.renameBoard(id, title) },
      { key: REGISTER, apply: lists.renameBoardEntries(id, title) },
      { key: boardKey(id), apply: lists.retitle(title) },
    ], s);
  },
  remove(id: string, s: Store = roomStore): Op<{ ok: boolean }> {
    return listOp({
      label: "delete the board", lanes: [boardLane(id)], method: "DELETE", path: `/api/boards/${id}`,
      invalidates: [BOARDS, REGISTER, ...DECK_TAGS],
    }, [
      { key: BOARDS, apply: lists.dropBoard(id) },
      { key: REGISTER, apply: lists.dropBoardEntries(id) },
    ], s);
  },
};

/** Gives up an op that ran out of retries, so later writes in its lanes are not queued behind it. */
export const abandon = (lanes: readonly string[], m: Mutator = mutator): void => {
  for (const lane of lanes) m.discardFailed(lane);
};

export function run<Res>(op: Op<Res>, m: Mutator = mutator): Promise<Res> {
  return m.mutate(op).catch((e: SaveError) => {
    if (e?.retryable) abandon(op.lanes, m);
    throw e;
  });
}

export const sources = {
  rename: (board: string, rid: string, name: string) => run(sourceOps.rename(board, rid, name)),
  done: (board: string, rid: string, done: boolean) => run(sourceOps.done(board, rid, done)),
  remove: (board: string, rid: string) => run(sourceOps.remove(board, rid)),
  removePair: (board: string, pid: string) => run(sourceOps.removePair(board, pid)),
  file: (from: string, pid: string, rid: string, to: string, toTitle: string) => run(sourceOps.file(from, pid, rid, to, toTitle)),
  distil: (board: string, rid: string) => run(sourceOps.distil(board, rid)),
  resplit: (board: string, rid: string, plan: SplitPlan, base: number) => run(sourceOps.resplit(board, rid, plan, base)),
  /** The Unfiled board's id, made on first use (get-or-create, so a plain call). */
  unfiled: async (s: Store = roomStore): Promise<string> => {
    const { id } = await call<{ id: string }>("POST", "/api/register/inbox", {});
    if (!(s.get<BoardListEntry[]>(BOARDS) ?? []).some((b) => b.id === id)) s.invalidate([BOARDS]);
    return id;
  },
};

export const boards = {
  create: (opts: { question?: string; title?: string }) => run(boardOps.create(opts)),
  rename: (id: string, title: string) => run(boardOps.rename(id, title)),
  remove: (id: string) => run(boardOps.remove(id)),
};
