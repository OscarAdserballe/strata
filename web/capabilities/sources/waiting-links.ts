// A link pasted on the plane can't be fetched there: it waits on the device under the receipt it will be captured with.
import { useSyncExternalStore } from "react";
import { StrataAPI, StrataWireDown, StrataWireWatch } from "../../data/api.ts";
import { localShelf, noShelf, type Shelf } from "../../data/outbox.ts";

export interface WaitingLink { key: string; board: string; url: string; at: number }
export interface LinkDeps {
  shelf: Shelf;
  down(): boolean;
  capture(board: string, url: string, key: string): Promise<unknown>;
  /** a capture landed: the board's sources are read again */
  landed(link: WaitingLink, answer: unknown): void;
  /** the server refused it: said once, and the link is let go */
  refused(link: WaitingLink, e: unknown): void;
}

const mint = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const parse = (raw: string): WaitingLink | null => { try { const v = JSON.parse(raw); return v && typeof v.key === "string" && typeof v.url === "string" ? v : null; } catch { return null; } };

export class WaitingLinks {
  private list: WaitingLink[];
  private readonly heard = new Set<() => void>();
  private draining = false;
  private readonly d: LinkDeps;
  constructor(d: LinkDeps) {
    this.d = d;
    this.list = d.shelf.all().map(parse).filter((l): l is WaitingLink => !!l).sort((a, b) => a.at - b.at);
  }
  /** Offline, keeps the link to capture later and says so; online it is not taken. */
  wait(board: string, url: string, now = Date.now()): WaitingLink | null {
    if (!this.d.down()) return null;
    const same = this.list.find((l) => l.board === board && l.url === url);
    if (same) return same;
    const link = { key: mint(), board, url, at: now };
    this.d.shelf.put(link.key, JSON.stringify(link));
    this.set([...this.list, link]);
    return link;
  }
  /** Sends what waits, in the order pasted; a lost answer leaves it for the next try under the same key. */
  async drain(): Promise<void> {
    if (this.draining || this.d.down() || !this.list.length) return;
    this.draining = true;
    try {
      for (const link of [...this.list]) {
        if (this.d.down()) break;
        try {
          const answer = await this.d.capture(link.board, link.url, link.key);
          this.drop(link);
          this.d.landed(link, answer);
        } catch (e) {
          const status = (e as { status?: number } | null)?.status;
          if (!status || status >= 500 || status === 408 || status === 429) break;
          this.drop(link);
          this.d.refused(link, e);
        }
      }
    } finally { this.draining = false; }
  }
  now = (): readonly WaitingLink[] => this.list;
  subscribe = (fn: () => void): (() => void) => { this.heard.add(fn); return () => { this.heard.delete(fn); }; };
  private drop(link: WaitingLink): void { this.d.shelf.drop(link.key); this.set(this.list.filter((l) => l.key !== link.key)); }
  private set(next: WaitingLink[]): void { this.list = next; for (const fn of [...this.heard]) fn(); }
}

let said: Pick<LinkDeps, "landed" | "refused"> = { landed: () => {}, refused: () => {} };
/** The room says what a landed or refused link means for the screen; bound once by the source host. */
export function onWaitingLinks(s: Pick<LinkDeps, "landed" | "refused">): void { said = s; }

export const waitingLinks = new WaitingLinks({
  shelf: typeof localStorage !== "undefined" ? localShelf("strata.links.") : noShelf,
  down: StrataWireDown,
  capture: (board, url, key) => StrataAPI.capture(board, url, key),
  landed: (l, a) => said.landed(l, a),
  refused: (l, e) => said.refused(l, e),
});
StrataWireWatch(() => { void waitingLinks.drain(); });

export const useWaitingLinks = (): readonly WaitingLink[] => useSyncExternalStore(waitingLinks.subscribe, waitingLinks.now, waitingLinks.now);
export const shortLink = (url: string): string => { try { const u = new URL(url); return (u.host.replace(/^www\./, "") + u.pathname).slice(0, 40) + ((u.host + u.pathname).length > 40 ? "…" : ""); } catch { return url.slice(0, 40); } };
