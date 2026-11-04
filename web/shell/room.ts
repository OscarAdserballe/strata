import { type DragEvent, useSyncExternalStore } from "react";
import type { BoardActions } from "../capabilities/sources/useBoardActions.ts";

export interface RoomHandle {
  activeId(): string | null;
  openBoard(id: string, resource?: string, options?: { resume?: boolean }): Promise<boolean | undefined>;
  newBoard(question: string): Promise<{ id: string } | undefined>;
  warmBoard(id: string, resume?: boolean): void;
  sourceMutated(boardId: string, state: unknown, verb: string): void;
  boardState(state: unknown): void;
  deckChanged(slug: string, standOn?: string | null): void;
  deleteCard(card: any): unknown;
  restoreCard(card: any): unknown;
  goToCardSource(card: any): void;
  deckCards(slug: string): Promise<any[]>;
  boardActions: BoardActions;
  panesDrag: { onDragOver(e: DragEvent): void; onDragLeave(e: DragEvent): void; onDrop(e: DragEvent): void };
  toastWhy(e: unknown, said: string): void;
}

let handle = {} as RoomHandle;
export function bindRoom(h: RoomHandle): void { handle = h; }
const calls: Record<string, unknown> = {};
/** Each verb calls whatever the room bound last, so screens can hold on to it as a prop. */
export const room = new Proxy(handle, {
  get: (_, k: string) => typeof handle[k as keyof RoomHandle] === "function"
    ? calls[k] ??= (...a: unknown[]) => (handle[k as keyof RoomHandle] as (...a: unknown[]) => unknown)(...a)
    : handle[k as keyof RoomHandle],
});

const heard = new Set<() => void>();
const tell = () => { for (const cb of [...heard]) cb(); };
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };

export interface Held { id: string | null; board: any; decks: any[] }
let held: Held = { id: null, board: null, decks: [] };
export function holdBoard(next: Omit<Held, "decks">): void {
  if (next.id === held.id && next.board === held.board) return;
  held = { ...next, decks: held.decks };
  tell();
}
export function holdDecks(decks: any[]): void {
  if (decks === held.decks) return;
  held = { ...held, decks };
  tell();
}
const heldNow = () => held;
const heldIdNow = () => held.id;
export const useHeld = (): Held => useSyncExternalStore(subscribe, heldNow, heldNow);
export const useHeldId = (): string | null => useSyncExternalStore(subscribe, heldIdNow, heldIdNow);

export type RoomHostName = "library" | "veil" | "bench-lib" | "panes";
const hosts: Partial<Record<RoomHostName, HTMLElement>> = {};
const refs: Partial<Record<RoomHostName, (el: HTMLElement | null) => void>> = {};
/** One function per host, so React calls it only when the element itself comes or goes. */
export function roomHost(name: RoomHostName): (el: HTMLElement | null) => void {
  return refs[name] ??= (el) => {
    if ((hosts[name] ?? null) === el) return;
    if (el) hosts[name] = el; else delete hosts[name];
    tell();
  };
}
export function useRoomHost(name: RoomHostName): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => hosts[name] ?? null, () => null);
}
