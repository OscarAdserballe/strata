// Journey timings from the reader's device; only a name, duration, build and device class leave the page.
import { PHONE, TABLET } from "./device.js";

type Sample = { j: string; ms: number; at: number };
const queue: Sample[] = [];
// Samples wait (the newest 200) until main.tsx hands in a sender.
type Sender = (path: string, body: string) => void;
let sender: Sender | null = null;
export function sendSamplesWith(send: Sender): void { sender = send; }
const open = new Map<string, number>();
const device = PHONE ? "phone" : TABLET ? "tablet" : "desktop";

const afterPaint = (fn: () => void): void => {
  if (typeof requestAnimationFrame !== "function") { fn(); return; }
  requestAnimationFrame(() => requestAnimationFrame(fn));
};

export function sample(journey: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > 600_000) return;
  queue.push({ j: journey, ms: Math.round(ms), at: Date.now() });
  if (queue.length >= 100) flush();
}
/** The person acted: start the clock (a second begin restarts it). */
export function begin(journey: string, at: number = performance.now()): void { open.set(journey, at); }
/** The result is in the DOM: stop the clock once it has been painted. */
export function end(journey: string): void {
  const t0 = open.get(journey);
  if (t0 === undefined) return;
  open.delete(journey);
  afterPaint(() => sample(journey, performance.now() - t0));
}
/** A journey that started with the page itself (home, a direct link): measured from navigation. */
export function sinceLoad(journey: string): void {
  afterPaint(() => sample(journey, performance.now()));
}
export const pending = (journey: string): boolean => open.has(journey);

function flush(): void {
  if (!queue.length) return;
  if (!sender) { if (queue.length > 200) queue.splice(0, queue.length - 200); return; }
  sender("/api/perf", JSON.stringify({ build: (window as { STRATA_BUILD?: string }).STRATA_BUILD ?? null, device, samples: queue.splice(0, 200) }));
}

/* Long animation frames are Chromium-only; a rAF sampler would cost the battery it measures. */
let blocked = 0;
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) blocked += (e as PerformanceEntry & { blockingDuration?: number }).blockingDuration ?? 0; })
    .observe({ type: "long-animation-frame", buffered: false });
} catch { /* unsupported */ }

if (typeof window !== "undefined") {
  setInterval(() => { if (blocked > 0) { sample("frames.blocked", blocked); blocked = 0; } flush(); }, 60_000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  addEventListener("pagehide", flush);
}
