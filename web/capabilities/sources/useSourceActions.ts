import { useMemo, useRef } from "react";
import type { BoardState } from "../../../shared/types/index.ts";
import { boards, sources } from "../../data/entities/sources.ts";
import type { SaveError } from "../../data/mutate.ts";
import { toast } from "../../shell/layers.ts";

export type SourceVerbName = "rename" | "done" | "delete" | "file";

/** How long a deleted source can be brought back before the delete is sent. */
export const UNDO_MS = 8000;

export interface SourceActionOptions {
  onState?: (boardId: string, state: BoardState, verb: SourceVerbName) => void;
  onError?: (error: unknown, said: string) => void;
  /** a source is about to go: whoever shows it steps off it first */
  onLeaving?: (boardId: string, rid: string) => void;
}

export interface Fileable { boardId: string; pairId: string | null; resourceId: string; filename?: string }

export function useSourceActions(options: SourceActionOptions = {}) {
  const latest = useRef(options);
  latest.current = options;
  return useMemo(() => {
    const said = (what: string) => (e: unknown) => { latest.current.onError?.(e, what); return null; };
    const landed = (board: string, verb: SourceVerbName) => <R extends { state?: BoardState } | null>(r: R): R => {
      if (r?.state) latest.current.onState?.(board, r.state, verb);
      return r;
    };
    return {
      rename(board: string, rid: string, name: string) {
        const next = (name || "").trim();
        if (!next) return Promise.resolve(null);
        return sources.rename(board, rid, next).then(landed(board, "rename"), said("couldn't rename that"));
      },
      done(board: string, rid: string, done: boolean) {
        return sources.done(board, rid, done).then(landed(board, "done"), said(done ? "couldn't mark that done" : "couldn't take that back"));
      },
      /** Gone at once; sent once the Undo in the toast has had UNDO_MS. Resolves null when undone or refused. */
      remove(board: string, rid: string, name?: string) {
        latest.current.onLeaving?.(board, rid);
        const { done, undo } = sources.removeLater(board, rid, UNDO_MS);
        const what = name ? `“${name}”` : "the source";
        toast(`Deleted ${what}`, UNDO_MS, { label: "Undo", run: () => toast(undo() ? `${what} is back` : `too late: ${what} is already deleted`, 2400) });
        return done.then(landed(board, "delete"), (e: SaveError) => (e?.withdrawn ? null : said("couldn't delete that")(e)));
      },
      removePair(board: string, pid: string) {
        return sources.removePair(board, pid).then(landed(board, "delete"), said("couldn't delete that"));
      },
      async file(e: Fileable, to: { id: string; title: string } | null) {
        if (!e.pairId) return said("couldn't file that")(new Error("it has no page to move"));
        try {
          let dest = to;
          if (!dest) {
            const made = await boards.create({ title: (e.filename || "Untitled board").replace(/\.[a-z0-9]+$/i, "").slice(0, 80) });
            dest = { id: made.board.id, title: made.board.title };
          }
          const moved = await sources.file(e.boardId, e.pairId, e.resourceId, dest.id, dest.title);
          latest.current.onState?.(e.boardId, moved.state, "file");
          latest.current.onState?.(dest.id, moved.destState, "file");
          return moved;
        } catch (x) { return said("couldn't file that")(x); }
      },
      redistil(board: string, rid: string) {
        return sources.distil(board, rid).catch(said("couldn't start that"));
      },
    };
  }, []);
}

export type SourceActions = ReturnType<typeof useSourceActions>;
