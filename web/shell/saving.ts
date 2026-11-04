import type { PendingOp } from "../data/mutate.ts";
// Publishes a one-word summary that changes rarely, so fast saves never re-render the chip.
export const SLOW_MS = 1000;

export function saveLine(ops: readonly PendingOp[], slow: boolean): string {
  const failed = ops.filter((p) => p.state === "failed").length;
  if (failed) return String(failed);
  return ops.length && (slow || ops.some((p) => p.state === "retrying")) ? "saving" : "";
}

export interface SaveSource { pending(): PendingOp[]; subscribePending(cb: () => void): () => void }
type Timers = { set(fn: () => void, ms: number): unknown; clear(t: unknown): void };
const browserTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as number) };

export function saveWatch(m: SaveSource, timers: Timers = browserTimers) {
  let slow = false, timer: unknown = null;
  const read = () => saveLine(m.pending(), slow);
  const watch = (changed: () => void) => {
    let told = read();
    const tell = () => { const now = read(); if (now !== told) { told = now; changed(); } };
    const tick = () => {
      const busy = m.pending().some((p) => p.state !== "failed");
      if (!busy) { if (timer !== null) timers.clear(timer); timer = null; slow = false; }
      else if (!slow && timer === null) timer = timers.set(() => { timer = null; slow = true; tell(); }, SLOW_MS);
      tell();
    };
    const off = m.subscribePending(tick);
    tick();
    return () => { off(); if (timer !== null) timers.clear(timer); timer = null; slow = false; };
  };
  return { read, watch };
}
