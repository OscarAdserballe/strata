import { useSyncExternalStore } from "react";

export interface BoardPageUp { pin: boolean; done: boolean }

let now: BoardPageUp = { pin: false, done: false };
const subs = new Set<() => void>();
const set = (next: BoardPageUp) => {
  if (next.pin === now.pin && next.done === now.done) return;
  now = next;
  for (const s of subs) s();
};

export const boardPage = {
  get: (): BoardPageUp => now,
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
  over: (): boolean => now.pin || now.done,
  show(force?: boolean): void { set({ ...now, pin: force === undefined ? !now.pin : force }); },
  hide(): void { set({ pin: false, done: false }); },
  unpin(): void { set({ ...now, pin: false }); },
  finished(done: boolean): void { set({ ...now, done }); },
};

export function useBoardPageUp(): BoardPageUp {
  return useSyncExternalStore(boardPage.subscribe, boardPage.get);
}
