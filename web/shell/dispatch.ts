import { useSyncExternalStore } from "react";

/** The room opened at <room>/dispatch: the reader with the dashboard's thread pane on its left. */
export const DISPATCH = typeof location !== "undefined" && /\/dispatch\/?$/.test(location.pathname);

// What the reader's bar says in Dispatch: the stage as the board's name, and the version open.
export interface DispatchBar { board: string; version: string }
let bar: DispatchBar | null = null;
const heard = new Set<() => void>();
export function setDispatchBar(next: DispatchBar | null): void {
  if (next?.board === bar?.board && next?.version === bar?.version) return;
  bar = next;
  for (const cb of [...heard]) cb();
}
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
const now = () => bar;
export const useDispatchBar = (): DispatchBar | null => useSyncExternalStore(subscribe, now, now);
