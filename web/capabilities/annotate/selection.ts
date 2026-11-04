import { mergeRects, rectsToFractions, type Fraction } from "../../../shared/reading/marks.ts";

export interface PageTextIndex { text: string; loc(item: number, char: number): number }
export interface PdfRange { page: number; start: number; end: number; quote: string; rects: Fraction[] }

export function pdfSelection(pageIndex: (page: number) => PageTextIndex | null | undefined): PdfRange | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const elOf = (node: Node | null): Element | null => (node && node.nodeType === 3 ? node.parentElement : node as Element | null);
  const slideOf = (node: Node | null) => { const e = elOf(node); return e && e.closest ? e.closest<HTMLElement>(".slide") : null; };
  const slide = slideOf(sel.anchorNode) || slideOf(sel.focusNode);
  const layer = slide && slide.querySelector(".tlayer");
  if (!slide || !layer) return null;
  const runs = layer.querySelectorAll<HTMLElement>("[data-i]");
  if (!runs.length) return null;
  const spanOf = (node: Node | null) => { const e = elOf(node); const s = e && e.closest ? e.closest<HTMLElement>(".tlayer [data-i]") : null; return s && layer.contains(s) ? s : null; };
  let a = spanOf(r.startContainer), b = spanOf(r.endContainer);
  let aOff = r.startOffset, bOff = r.endOffset;
  const clip = r.cloneRange();
  const probe = document.createRange();
  const where = (s: Node, node: Node, off: number) => { probe.selectNodeContents(s); return probe.comparePoint(node, off); };
  if (!a) {
    a = Array.prototype.find.call(runs, (s: HTMLElement) => where(s, r.startContainer, r.startOffset) < 0) as HTMLElement | undefined || null;
    aOff = 0;
    if (a) clip.setStart(a, 0);
  }
  if (!b) {
    for (let i = runs.length - 1; i >= 0 && !b; i--) if (where(runs[i], r.endContainer, r.endOffset) > 0) b = runs[i];
    bOff = b ? (b.textContent || "").length : 0;
    if (b) clip.setEnd(b, b.childNodes.length);
  }
  if (!a || !b || (a !== b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING))) return null;
  const page = +(slide.dataset.page as string);
  const idx = pageIndex(page);
  if (!idx) return null;
  let start = idx.loc(+(a.dataset.i as string), aOff);
  let end = idx.loc(+(b.dataset.i as string), bOff);
  if (end < start) { const t = start; start = end; end = t; }
  const text = idx.text;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const quote = text.slice(start, end);
  if (!quote.trim()) return null;
  // fractions of the canvas survive zoom, raster scale and window resizes
  const cv = slide.querySelector("canvas");
  const box = (cv || slide).getBoundingClientRect();
  const rects = mergeRects(rectsToFractions(Array.from(clip.getClientRects()), box));
  return { page, start, end, quote, rects };
}
