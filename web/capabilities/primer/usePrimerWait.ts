import { useEffect } from "react";
import { StrataAPI } from "../../data/api.ts";
import { primers } from "../../data/entities/primers.ts";
import { nextWait, WAIT_FIRST } from "./primer.ts";

/** While a primer is asked for and the panel shows it: ask the board's rev, and read the board only past the one held. */
export function usePrimerWait(board: string | null, waiting: boolean): void {
  useEffect(() => {
    if (!board || !waiting) return;
    let live = true, wait = WAIT_FIRST;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      if (!live || document.hidden) return;
      try {
        const { rev } = await StrataAPI.boardStatus(board);
        wait = live && await primers.catchUp(board, rev) ? WAIT_FIRST : nextWait(wait);
      } catch { wait = nextWait(wait); }
      if (live) timer = setTimeout(look, wait);
    };
    const shown = () => { clearTimeout(timer); if (!document.hidden) void look(); };
    document.addEventListener("visibilitychange", shown);
    timer = setTimeout(look, WAIT_FIRST);
    return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", shown); };
  }, [board, waiting]);
}
