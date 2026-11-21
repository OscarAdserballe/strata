// Offline writes the server refused on reconnect, kept on the device until the reader settles each one.

export interface Clash {
  /** the refused act's key */
  id: string;
  at: number;
  board: string;
  mid: string;
  kind: "create" | "note" | "reply";
  quote: string;
  /** what was written offline */
  mine: string | null;
  /** what the server holds now, when it said */
  theirs: string | null;
  why: string;
  /** the reader's text can still be sent over what is there */
  canKeep?: boolean;
}

export interface ClashShelf { read(): string | null; write(v: string): void }
const KEY = "strata.conflicts";
const localShelf: ClashShelf = {
  read: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  write: (v) => { try { localStorage.setItem(KEY, v); } catch { /* private window: the list lasts the tab */ } },
};
const noShelf: ClashShelf = { read: () => null, write: () => {} };
const NONE: readonly Clash[] = Object.freeze([]);

export class Conflicts {
  private list: readonly Clash[] = NONE;
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  private readonly shelf: ClashShelf;
  constructor(shelf: ClashShelf = typeof localStorage === "undefined" ? noShelf : localShelf) { this.shelf = shelf; }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try { const v = JSON.parse(this.shelf.read() ?? "[]"); if (Array.isArray(v)) this.list = v; } catch { /* torn write */ }
  }
  private set(next: readonly Clash[]): void {
    this.list = next.length ? next : NONE;
    this.shelf.write(JSON.stringify(this.list));
    for (const fn of [...this.listeners]) fn();
  }

  add(c: Clash): void { this.load(); this.set([...this.list.filter((x) => x.id !== c.id), c].sort((a, b) => a.at - b.at)); }
  settle(id: string): void { this.load(); if (this.list.some((x) => x.id === id)) this.set(this.list.filter((x) => x.id !== id)); }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = (): readonly Clash[] => { this.load(); return this.list; };
}

export const conflicts = new Conflicts();
