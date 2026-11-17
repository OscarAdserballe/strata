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

/** Alt+N (⌥N) from anywhere, typing included; by code, since ⌥N on a Mac types a dead "˜". */
export const isPadKey = (e: KeyboardEvent): boolean => e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.code === "KeyN";
export const PAD_KEY_LABEL = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? "⌥N" : "Alt+N";
