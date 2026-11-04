import { useEffect, useRef } from "react";
import { StrataAPI } from "./api.ts";

/** Poll serially while visible; refresh full data only when status changes. */
export function useJobPoll(board: string | null, enabled: boolean, changed: () => Promise<void>): void {
  const callback = useRef(changed); callback.current = changed;
  useEffect(() => {
    if (!board || !enabled) return;
    let live = true, running = false, version: string | undefined, delay = 4000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!live || running || document.hidden) return;
      running = true;
      try {
        const status = await StrataAPI.boardStatus(board);
        if (!live) return;
        if (status.version !== version) { version = status.version; await callback.current(); }
        delay = status.busy ? 4000 : 15000;
      } catch { delay = Math.min(delay*2,30000); }
      finally { running = false; if (live) timer = setTimeout(poll,delay); }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange",visibility);
    timer = setTimeout(poll,1000);
    return () => { live=false; clearTimeout(timer); document.removeEventListener("visibilitychange",visibility); };
  }, [board,enabled]);
}
