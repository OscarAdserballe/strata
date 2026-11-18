// Whether the primer's plan is open: i flips it from the room's keys, the ⓘ in the bar by hand.
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

export function setPlanOpen(on: boolean | ((was: boolean) => boolean)): void {
  const next = typeof on === "function" ? on(open) : on;
  if (next === open) return;
  open = next;
  for (const l of listeners) l();
}
export const togglePlan = (): void => setPlanOpen((v) => !v);
export const usePlanOpen = (): boolean => useSyncExternalStore(subscribe, () => open, () => false);
