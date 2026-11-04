import type { ProseMaps } from "./offsets.ts";

export interface Wrapped { id?: string; note?: unknown }
export interface PaintedMark extends Wrapped { start: number; end: number }

// Back to front so splitting a node never invalidates earlier offsets; one text node at a time.
export function wrapRendered(blk: Node, rs: number, re: number, m: Wrapped, on: boolean, cls?: string): void {
  const nodes: { node: Text; at: number }[] = [];
  const w = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
  let t: Node | null, n = 0;
  while ((t = w.nextNode())) { nodes.push({ node: t as Text, at: n }); n += t.nodeValue!.length; }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { node, at } = nodes[i];
    const len = node.nodeValue!.length;
    const a = Math.max(rs, at), b = Math.min(re, at + len);
    if (b <= a || !node.parentNode) continue;
    // Where marks overlap the first painted wins; nested highlights look like a rendering bug.
    if (!cls && node.parentElement && node.parentElement.classList.contains("mk")) continue;
    let mid = node;
    if (b < at + len) mid.splitText(b - at);
    if (a > at) mid = mid.splitText(a - at);
    const span = document.createElement("span");
    span.className = cls || ("mk" + (m.note ? " said" : "") + (on ? " on" : ""));
    if (m.id) span.dataset.mark = m.id;
    mid.parentNode!.replaceChild(span, mid);
    span.appendChild(mid);
  }
}

export function paintProseMarks(host: ParentNode | null | undefined, maps: ProseMaps | null | undefined, marks: readonly PaintedMark[], activeMarkId?: string | null): void {
  if (!host || !maps || !maps.length) return;
  for (const blk of host.querySelectorAll("[data-b]")) {
    const map = maps[+blk.getAttribute("data-b")!];
    if (!map || !map.length) continue;
    const lo = map[0], hi = map[map.length - 1];
    for (const m of marks) {
      if (m.end <= lo || m.start >= hi) continue;
      let rs = -1, re = -1;
      for (let i = 0; i < map.length - 1; i++) {
        if (map[i] >= m.start && map[i] < m.end) { if (rs < 0) rs = i; re = i + 1; }
      }
      if (rs >= 0) wrapRendered(blk, rs, re, m, m.id === activeMarkId);
    }
  }
}

// Reconcile instead of resetting innerHTML: it's slow on heavily marked sources and trips scroll anchoring.
export function reconcileProseMarks(host: ParentNode | null | undefined, maps: ProseMaps | null | undefined, marks: readonly PaintedMark[] | null | undefined, activeMarkId?: string | null): void {
  if (!host) return;
  const wanted = new Map((marks || []).map((m) => [m.id, m]));
  const present = new Set<string | undefined>();
  const heal = new Set<Node>();
  for (const span of host.querySelectorAll<HTMLElement>(".mk[data-mark]")) {
    const m = wanted.get(span.dataset.mark);
    if (!m) {
      const p = span.parentNode;
      if (p) {
        while (span.firstChild) p.insertBefore(span.firstChild, span);
        span.remove();
        heal.add(p);
      }
      continue;
    }
    present.add(m.id);
    span.className = "mk" + (m.note ? " said" : "") + (m.id === activeMarkId ? " on" : "");
  }
  for (const p of heal) p.normalize();
  for (const m of marks || []) {
    if (present.has(m.id)) continue;
    paintProseMarks(host, maps, [m], activeMarkId);
  }
}

// a block's own words, not the tick and peek hung in it
const CHROME_IN_BLOCK = ".ftick, .fpeek, .ftick-at";
function pointIn(blk: Element, i: number): [Text, number] | null {
  const w = blk.ownerDocument.createTreeWalker(blk, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(CHROME_IN_BLOCK) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let at = 0, last: Text | null = null;
  for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
    const len = t.nodeValue?.length ?? 0;
    if (i <= at + len) return [t, i - at];
    at += len; last = t;
  }
  return last ? [last, last.nodeValue?.length ?? 0] : null;
}

/** The rendered words between two offsets of the source text, as a range, and the block they start in. */
export function proseRange(host: ParentNode, maps: ProseMaps, start: number, end: number): { block: HTMLElement; range: Range } | null {
  let a: [Text, number] | null = null, b: [Text, number] | null = null, first: HTMLElement | null = null;
  for (const blk of host.querySelectorAll<HTMLElement>("[data-b]")) {
    const map = maps[+(blk.dataset.b as string)];
    if (!map || !map.length || map[map.length - 1] < start || map[0] >= end) continue;
    let rs = -1, re = -1;
    for (let n = 0; n < map.length - 1; n++) if (map[n] >= start && map[n] < end) { if (rs < 0) rs = n; re = n + 1; }
    if (rs < 0) continue;
    if (!a) { a = pointIn(blk, rs); first = blk; }
    b = pointIn(blk, re);
    if (map[map.length - 1] >= end) break;
  }
  if (!a || !b || !first) return null;
  const range = first.ownerDocument.createRange();
  try { range.setStart(a[0], a[1]); range.setEnd(b[0], b[1]); } catch { return null; }
  return { block: first, range };
}
