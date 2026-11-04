// Times every tap and key by hand, the same in every engine: Safari has no Event Timing or LoAF entries.
import { sample } from "./rum.ts";

/** Parts of the room, most specific first. A new surface worth its own line gets one here. */
export const REGIONS: readonly [string, string][] = [
  [".selmenu", "selmenu"],
  [".ftick", "fold.tick"],
  [".fold", "fold"],
  [".cram-card", "cram.card"],
  [".cramv", "cram"],
  [".rcard", "review.card"],
  [".reviewv", "review"],
  [".home-continue", "home.continue"],
  [".home-review", "home.review"],
  [".home-boards", "home.boards"],
  [".home-library", "home.library"],
  [".home-tools", "home.tools"],
  [".import-activity", "home.imports"],
  [".launcher", "home"],
  [".bp-rail", "board.rail"],
  [".bp-cover", "board.cover"],
  [".bp-front", "board.front"],
  [".desk-at", "board"],
  [".bench", "bench"],
  [".go", "go"],
  [".keys-sheet", "keys"],
  [".turns", "chat.thread"],
  [".line", "chat.line"],
  [".deck", "card"],
  [".pdf-col", "reader.pdf"],
  [".page-col", "reader.prose"],
  [".page", "reader"],
];

interface ElementLike {
  closest(selector: string): unknown;
  getAttribute?(name: string): string | null;
  parentElement?: ElementLike | null;
}
const clean = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Where a tap landed, as a journey-name segment (lowercase, digits, dots). */
export function regionOf(target: ElementLike | null | undefined): string {
  if (!target || typeof target.closest !== "function") return "page";
  for (const [selector, name] of REGIONS) if (target.closest(selector)) return name;
  // no named region: the class family of the nearest element that has one (`bp-it sel` → bp)
  for (let el: ElementLike | null | undefined = target; el; el = el.parentElement) {
    const cls = el.getAttribute?.("class");
    const family = cls ? clean(cls.trim().split(/\s+/)[0].split(/[-_]/)[0]) : "";
    if (family) return family.slice(0, 20);
  }
  return "page";
}

/** A shortcut's name: `n`, `escape`, `mod.z`. Modifier keys alone are not a shortcut. */
export function keyName(e: { key?: string; metaKey?: boolean; ctrlKey?: boolean }): string | null {
  const k = e.key === " " ? "space" : clean(String(e.key || ""));
  if (!k || ["shift", "control", "meta", "alt", "capslock", "dead", "unidentified", "process"].includes(k)) return null;
  return (e.metaKey || e.ctrlKey ? "mod." : "") + k.slice(0, 16);
}

type Kind = "pointerdown" | "pointerup" | "click" | "pointercancel" | "keydown";
interface Open { name: string; start: number; worst: number; pending: number; done: boolean; over: boolean }

/* A press that turned into a scroll, or anything the tab was hidden through, is dropped. */
const PRESS_MS = 1000;
export class Interactions {
  private cur: Open | null = null;
  private live = new Set<Open>();
  private report: (name: string, ms: number) => void;
  private afterPaint: (fn: () => void) => void;
  private now: () => number;
  private later: (fn: () => void, ms: number) => void;
  constructor(report: (name: string, ms: number) => void, afterPaint: (fn: () => void) => void,
    now: () => number, later: (fn: () => void, ms: number) => void) {
    this.report = report; this.afterPaint = afterPaint; this.now = now; this.later = later;
  }
  on(kind: Kind, timeStamp: number, name: string): void {
    const now = this.now();
    // an engine whose timestamp is on another clock gets the moment the listener ran instead
    const t0 = timeStamp > 0 && timeStamp <= now + 5 && now - timeStamp < 60_000 ? timeStamp : now;
    if (kind === "pointercancel") { if (this.cur) { this.cur.over = true; this.cur = null; } return; }
    if (kind === "pointerdown" || kind === "keydown" || !this.cur || this.cur.done) {
      this.cur = { name, start: t0, worst: 0, pending: 0, done: false, over: false };
      this.live.add(this.cur);
    }
    const x = this.cur;
    x.pending++;
    this.afterPaint(() => { x.worst = Math.max(x.worst, this.now() - t0); x.pending--; this.settle(x); });
    if (kind === "click" || kind === "keydown") { x.done = true; if (this.cur === x) this.cur = null; }
    else this.later(() => { x.done = true; if (this.cur === x) this.cur = null; this.settle(x); }, PRESS_MS);
  }
  /** The tab was hidden: nothing open now measured a wait someone saw. */
  hidden(): void { for (const x of this.live) x.over = true; this.live.clear(); this.cur = null; }
  private settle(x: Open): void {
    if (!x.done || x.pending > 0 || !this.live.has(x)) return;
    this.live.delete(x);
    if (!x.over) this.report(x.name, x.worst);
  }
}

const editable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""));
};

export function watchTaps(): void {
  if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") return;
  const taps = new Interactions(
    (name, ms) => sample(name, ms),
    (fn) => requestAnimationFrame(() => setTimeout(fn, 0)),
    () => performance.now(),
    (fn, ms) => { setTimeout(fn, ms); },
  );
  let name = "tap.page", typed = 0;
  const opts = { capture: true, passive: true } as const;
  addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || !e.isPrimary) return;
    name = "tap." + regionOf(e.target as Element | null);
    taps.on("pointerdown", e.timeStamp, name);
  }, opts);
  for (const kind of ["pointerup", "pointercancel"] as const) {
    addEventListener(kind, (e) => { if (e.isTrusted && e.isPrimary) taps.on(kind, e.timeStamp, name); }, opts);
  }
  addEventListener("click", (e) => {
    // a click the code made is not one a person waited on, and one a key made is its keydown's
    if (!e.isTrusted || e.detail === 0) return;
    taps.on("click", e.timeStamp, name);
  }, opts);
  addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.repeat || e.isComposing) return;
    if (editable(e.target)) {
      if (++typed % 5) return;
      taps.on("keydown", e.timeStamp, "type." + regionOf(e.target as Element | null));
      return;
    }
    const k = keyName(e);
    if (k) taps.on("keydown", e.timeStamp, "key." + k);
  }, opts);
  document.addEventListener("visibilitychange", () => { if (document.hidden) taps.hidden(); });
}
