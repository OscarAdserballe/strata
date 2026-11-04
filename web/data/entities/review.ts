import { useSyncExternalStore } from "react";
import { StrataAPI } from "../api.ts";

export type ReviewStrip = Awaited<ReturnType<typeof StrataAPI.review>>;

export const REVIEW_FRESH_MS = 5 * 60 * 1000;
let strip: ReviewStrip | null = null;
let at = 0;
const heard = new Set<() => void>();
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
const now = () => strip;

let primed = false, primedAt = 0;
export const reviewStrip = {
  refresh(boot = false): void {
    StrataAPI.review(boot).then((r) => { at = Date.now(); strip = r; for (const cb of [...heard]) cb(); }).catch(() => {});
  },
  /** The boot read, sent with the first wave rather than after the first paint; the worker may answer it from its snapshot. */
  prime(): void { if (primed) return; primed = true; primedAt = Date.now(); this.refresh(true); },
  /** true while the boot read is young enough that a screen opening need not ask again */
  justPrimed(): boolean { return primed && Date.now() - primedAt < 10_000; },
  fresh(): ReviewStrip | null { return strip && Date.now() - at < REVIEW_FRESH_MS ? strip : null; },
  /** a review just ran on it: the next one asks the server */
  spend(): void { at = 0; },
};
export const useReviewStrip = (): ReviewStrip | null => useSyncExternalStore(subscribe, now, now);

/** A sitting's order: the server's due-date queue, shuffled so one deck's cards don't come in a row. */
export function shuffled<T>(a: readonly T[]): T[] {
  const out = a.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** A verdict on the queue's head: a got card (and any multiple choice) leaves the sitting, a missed one goes to the back. */
export function afterGrade<T extends { id: string; type?: string }>(queue: readonly T[], card: { id: string; type?: string }, got: boolean): T[] {
  if (queue[0]?.id !== card.id) return queue.slice();
  return got || card.type === "mcq" ? queue.slice(1) : queue.slice(1).concat(queue[0]);
}
