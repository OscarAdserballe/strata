import type { Anchor } from "../../../shared/reading/anchors.ts";
import { pageTop } from "../pdf/landing.ts";
import { zoomOf } from "../zoom/zoom.ts";
import { anchorEl } from "./anchors-dom.ts";

export function glideTo(sc: HTMLElement | null, el: Element | null, pad?: number): void {
  if (!sc || !el) return;
  const z = zoomOf(sc);
  const target = (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) / z + sc.scrollTop - (pad || 22);
  const from = sc.scrollTop, dist = target - from, t0 = performance.now(), ms = 430;
  const ease = (t: number) => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  (function step(now: number) { const t = Math.min(1, (now - t0) / ms); sc.scrollTop = from + dist * ease(t); if (t < 1) requestAnimationFrame(step); })(t0);
  setTimeout(() => { if (Math.abs(sc.scrollTop - target) > 2) sc.scrollTop = target; }, ms + 70);
}

// PDF pages render progressively, so the anchored page may not exist yet; wait for it.
export function waitForAnchor(host: () => ParentNode | null, kind: string, a: Anchor, ms = 6000): Promise<Element | null> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    (function look() {
      const el = anchorEl(host(), kind, a);
      if (el || performance.now() - t0 > ms) { resolve(el || null); return; }
      setTimeout(look, 150);
    })();
  });
}

// Land flush with the page top: any lead-in shows the end of the previous page instead.
export function landOnPageNow(sc: HTMLElement | null, page: number | null): boolean {
  if (!page || !sc) return false;
  const el = sc.querySelector<HTMLElement>("#pg-" + page);
  if (!el) return false;
  sc.scrollTop = pageTop(el);
  return true;
}

export function restoreScroll(sc: HTMLElement, want: number): number {
  sc.scrollTop = Math.min(want, Math.max(0, sc.scrollHeight - sc.clientHeight));
  return sc.scrollTop;
}
