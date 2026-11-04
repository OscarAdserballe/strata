import { useMemo, useRef } from "react";
import type { Board, BoardState } from "../../../shared/types/index.ts";
import { boards } from "../../data/entities/sources.ts";

export interface BoardActionOptions {
  onState?: (boardId: string, state: BoardState) => void;
  onError?: (error: unknown, said: string) => void;
  onDeleted?: (boardId: string) => void;
}

export const UNTITLED_BOARD = "Untitled board";

export function useBoardActions(options: BoardActionOptions = {}) {
  const latest = useRef(options);
  latest.current = options;
  return useMemo(() => {
    const said = (what: string) => (e: unknown) => { latest.current.onError?.(e, what); return null; };
    return {
      create(question?: string): Promise<{ board: Board; state: BoardState } | null> {
        const q = (question || "").trim();
        return boards.create(q ? { question: q } : { title: UNTITLED_BOARD }).catch(said("couldn't make a board"));
      },
      rename(id: string, title: string) {
        const next = (title || "").trim();
        if (!next) return Promise.resolve(null);
        return boards.rename(id, next).then(
          (r) => { if (r?.state) latest.current.onState?.(id, r.state); return r; },
          said("couldn't rename the board"));
      },
      remove(id: string) {
        return boards.remove(id).then((r) => { latest.current.onDeleted?.(id); return r; }, said("couldn't delete the board"));
      },
    };
  }, []);
}

export type BoardActions = ReturnType<typeof useBoardActions>;
