export type ProseMaps = readonly (readonly number[])[];

export function renderedIndex(blk: Node, node: Node, off: number): number {
  const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
  let t: Node | null, n = 0;
  while ((t = w.nextNode())) { if (t === node) return n + off; n += t.nodeValue!.length; }
  return n;
}

export function proseOffset(maps: ProseMaps, node: Node, off: number): number | null {
  const el = node.nodeType === 3 ? node.parentElement : node as Element;
  const blk = el && el.closest ? el.closest("[data-b]") : null;
  if (!blk) return null;
  const map = maps[+blk.getAttribute("data-b")!];
  if (!map || !map.length) return null;
  const n = renderedIndex(blk, node, off);
  return map[Math.max(0, Math.min(n, map.length - 1))];
}

export interface ProseRange { start: number; end: number; quote: string }

export function proseSelection(host: Node | null | undefined, maps: ProseMaps, text: string): ProseRange | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !host) return null;
  const r = sel.getRangeAt(0);
  if (!host.contains(r.commonAncestorContainer)) return null;
  const a = proseOffset(maps, r.startContainer, r.startOffset);
  const b = proseOffset(maps, r.endContainer, r.endOffset);
  if (a == null || b == null) return null;
  const start = Math.min(a, b), end = Math.max(a, b);
  // Quote from the source, not sel.toString(): the rendered text has lost the markdown.
  let s = start, e = Math.min(end, text.length);
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  const quote = text.slice(s, e);
  return quote.trim() ? { start: s, end: e, quote } : null;
}

export interface PointAt { target: EventTarget | null; clientX: number; clientY: number }
export function srcOffsetAt(e: PointAt, maps: ProseMaps, len: number): number {
  try {
    const target = e.target as Element | null;
    const blk = target && target.closest ? target.closest("[data-b]") : null;
    if (!blk) return len;                                        // the margin under the text → the end
    const map = maps[+blk.getAttribute("data-b")!];
    if (!map || !map.length) return len;
    let hit: { node: Node; off: number } | null = null;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) hit = { node: p.offsetNode, off: p.offset };
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) hit = { node: r.startContainer, off: r.startOffset };
    }
    let n = map.length - 1;                                       // no caret under the pointer → the block's end
    if (hit && hit.node && hit.node.nodeType === 3 && blk.contains(hit.node)) {
      n = 0;
      const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
      let t: Node | null; while ((t = w.nextNode())) { if (t === hit.node) { n += hit.off; break; } n += t.nodeValue!.length; }
    }
    return map[Math.max(0, Math.min(n, map.length - 1))];
  } catch (err) { return len; }
}
