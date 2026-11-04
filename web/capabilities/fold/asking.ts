import type { AskWire } from "../ask/useThread.ts";

/** Words just picked to ask about: the ask exists on the server once its first question is sent. */
export interface AskPlace extends AskWire { resourceId: string; block: number | null }

let now: AskPlace | null = null;
const heard = new Set<() => void>();

export const asking = {
  now: (): AskPlace | null => now,
  set(next: AskPlace | null): void {
    if (next === now) return;
    now = next;
    for (const cb of [...heard]) cb();
  },
  subscribe(cb: () => void): () => void { heard.add(cb); return () => { heard.delete(cb); }; },
};

export const newAskId = (): string => "ak-" + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
