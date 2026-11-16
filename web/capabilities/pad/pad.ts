// Whether the notepad is open: kept outside any screen so toggling it re-renders only the pad.
import { useSyncExternalStore } from "react";

let open = false;
const heard = new Set<() => void>();
const tell = () => { for (const cb of [...heard]) cb(); };
export const padOpen = (): boolean => open;
export function setPadOpen(on: boolean): void { if (open !== on) { open = on; tell(); } }
export const togglePad = (): void => setPadOpen(!open);
export const closePad = (): void => setPadOpen(false);
const subscribe = (cb: () => void): (() => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
export const usePadOpen = (): boolean => useSyncExternalStore(subscribe, padOpen, () => false);

/** ⌘; or Ctrl+; from anywhere, typing included: the pad is for a thought you don't want to lose your place over. */
export const isPadKey = (e: KeyboardEvent): boolean => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === ";" || e.code === "Semicolon");
