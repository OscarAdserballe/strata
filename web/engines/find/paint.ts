import { findQuote, mergeRects, rectsToFractions } from "../../../shared/reading/marks.ts";
import { wrapRendered } from "../prose/paint.ts";
import { zoomOf } from "../zoom/zoom.ts";
import type { FindHit } from "./find.ts";

export interface PageTextIndex { text: string; loc(item: number, char: number): number }

export function clearFindPaint(prose: HTMLElement | null, pdfHost: HTMLElement | null): void {
  if (prose) prose.querySelectorAll(".findmk").forEach((s) => {
    const p = s.parentNode!;
    while (s.firstChild) p.insertBefore(s.firstChild, s);
    s.remove();
    p.normalize();   // heal the splits, so repeated finds don't shred the text nodes
  });
  if (pdfHost) pdfHost.querySelectorAll(".findbox").forEach((b) => b.remove());
}

/** The words between two offsets of a page's text, as a range over its text layer; null before the layer is drawn. */
export function textLayerRange(slide: HTMLElement, idx: PageTextIndex, start: number, end: number): Range | null {
  const layer = slide.querySelector(".tlayer");
  if (!layer) return null;
  let aN: Node | null = null, aC = 0, bN: Node | null = null, bC = 0;
  for (const sp of layer.querySelectorAll<HTMLElement>("[data-i]")) {
    const tn = sp.firstChild;
    if (!tn || tn.nodeType !== 3) continue;
    const it = +(sp.dataset.i as string), len = (tn.nodeValue || "").length;
    if (!aN && idx.loc(it, len) > start) {
      let c = 0; while (c < len && idx.loc(it, c + 1) <= start) c++;
      aN = tn; aC = c;
    }
    if (aN) {
      let c = 0; while (c < len && idx.loc(it, c) < end) c++;
      if (c > 0) { bN = tn; bC = c; }
      if (c < len) break;
    }
  }
  if (!aN || !bN) return null;
  const r = slide.ownerDocument.createRange();
  try { r.setStart(aN, aC); r.setEnd(bN, bC); } catch { return null; }
  return r;
}

// The stored offsets are only a hint; the quote is authoritative (the upload may have used another pdf.js).
export function paintFindBox(slide: HTMLElement, idx: PageTextIndex, h: FindHit, pageText: string): void {
  slide.querySelectorAll(".findbox").forEach((b) => b.remove());
  const quote = (pageText || "").slice(h.start, h.end);
  const found = quote ? findQuote(idx.text, quote, h.start) : null;
  if (!found) return;
  const r = textLayerRange(slide, idx, found.start, found.end);
  if (!r) return;
  const cv = slide.querySelector("canvas");
  const box = (cv || slide).getBoundingClientRect();
  if (!box.width || !box.height) return;
  for (const [x, y, w, hh] of mergeRects(rectsToFractions(Array.from(r.getClientRects()), box))) {
    const b = document.createElement("div");
    b.className = "findbox";
    b.style.left = (x * 100) + "%"; b.style.top = (y * 100) + "%";
    b.style.width = (w * 100) + "%"; b.style.height = (hh * 100) + "%";
    slide.appendChild(b);
  }
}

// Re-snap while nearby pages are undrawn: their placeholder heights change as they draw.
export function snapToPdfHit(opts: { scroller: () => HTMLElement | null; slide: HTMLElement; hit: FindHit; pageText: string;
  index: (page: number) => PageTextIndex | null | undefined; live: () => boolean }): void {
  const { scroller, slide, hit: h, pageText, index, live } = opts;
  (function paint(tries: number, pinned: boolean) {
    if (!live()) return;
    const sc = scroller(); if (!sc) return;
    const idx = index(h.page as number);
    const ready = !!(idx && slide.querySelector(".tlayer") && slide.querySelector("canvas"));
    if (ready && !slide.querySelector(".findbox")) paintFindBox(slide, idx!, h, pageText);
    const z = zoomOf(sc) || 1;
    const want = (slide.getBoundingClientRect().top - sc.getBoundingClientRect().top) / z + sc.scrollTop - 26;
    const off = want - sc.scrollTop;
    if (pinned && Math.abs(off) > 700) return;         // the reader scrolled on — let them
    let undrawn = false;
    for (const s of sc.querySelectorAll<HTMLElement>(".slide")) {
      const a = s.offsetTop, b = a + s.offsetHeight;
      if (b >= sc.scrollTop - sc.clientHeight && a <= sc.scrollTop + 2 * sc.clientHeight && !s.querySelector("canvas")) { undrawn = true; break; }
    }
    if (Math.abs(off) > 3 && (undrawn || !pinned)) sc.scrollTop = want;
    if ((undrawn || !ready) && tries > 0) setTimeout(() => paint(tries - 1, true), 150);
  })(33, false);
}

export function paintProseHit(host: HTMLElement, maps: readonly (readonly number[])[], h: FindHit): Element | null {
  let first: Element | null = null;
  for (const blk of host.querySelectorAll("[data-b]")) {
    const map = maps[+(blk.getAttribute("data-b") as string)];
    if (!map || !map.length) continue;
    if (map[map.length - 1] < h.start || map[0] >= h.end) continue;
    let rs = -1, re = -1;
    for (let n = 0; n < map.length; n++) if (map[n] >= h.start && map[n] < h.end) { if (rs < 0) rs = n; re = n + 1; }
    if (rs < 0) continue;   // the hit sits in markdown syntax the renderer dropped
    wrapRendered(blk, rs, re, {}, false, "findmk");
    if (!first) first = blk.querySelector(".findmk");
    if (map[map.length - 1] >= h.end) break;
  }
  return first;
}
