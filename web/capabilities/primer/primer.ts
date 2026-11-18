// Whether the reader has the primer up, and the slow look for one being written; kept here so a toggle renders neither the reader nor the room.
import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "../../data/store.ts";
import { primerKey, primerRead, primers, type PrimerEntity } from "../../data/entities/primers.ts";

let up = false;
const heard = new Set<() => void>();
export const primerPane = {
  subscribe(cb: () => void): () => void { heard.add(cb); return () => { heard.delete(cb); }; },
  get: (): boolean => up,
  set(on: boolean): void {
    if (on === up) return;
    up = on;
    for (const cb of [...heard]) cb();
  },
};
export const usePrimerUp = (): boolean => useSyncExternalStore(primerPane.subscribe, primerPane.get, primerPane.get);

const FIRST_MS = 5_000, MAX_MS = 60_000;

/** The source's primer, looked for again while one is being written: slower each time, never while the tab is hidden. */
export function usePrimer(board: string, rid: string): PrimerEntity | undefined {
  const p = useQuery<PrimerEntity>(primerKey(rid), primerRead(board, rid));
  const writing = p?.status === "requested";
  useEffect(() => {
    if (!writing) return;
    let live = true, delay = FIRST_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      if (!live || document.hidden) return;
      try {
        const now = await primers.reread(board, rid);
        if (now?.status !== "requested") return;
      } catch { /* the next look tries again */ }
      delay = Math.min(MAX_MS, Math.round(delay * 1.5));
      if (live) timer = setTimeout(look, delay);
    };
    const shown = () => { clearTimeout(timer); if (!document.hidden) { delay = FIRST_MS; void look(); } };
    document.addEventListener("visibilitychange", shown);
    timer = setTimeout(look, delay);
    return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", shown); };
  }, [board, rid, writing]);
  return p;
}
