import { type Anchor, passageIndex } from "../../../shared/reading/anchors.ts";

export interface QuoteBlocks { blocks: Element[]; index: { find(quote: string): number | null } }

export function anchorEl(host: ParentNode | null | undefined, kind: string, a: Anchor, quotes?: () => QuoteBlocks): Element | null {
  if (!host) return null;
  if (kind === "pdf" && a.slide) { const el = host.querySelector("#pg-" + a.slide); if (el) return el; }
  if (kind === "transcript" && a.ts) { const el = host.querySelector(`[data-ts="${a.ts}"]`); if (el) return el; }
  if (a.sec) { const el = host.querySelector(`[data-sec="${a.sec}"]`); if (el) return el; }
  if (a.slug) {
    const el = host.querySelector(`[data-slug="${a.slug}"]`);
    if (el) return el;
    // An exact slug miss falls back to the tightest heading containing the anchor's words in order.
    const want = a.slug.split("-").filter(Boolean);
    let best: Element | null = null, extra = Infinity;
    for (const h of host.querySelectorAll<HTMLElement>("[data-slug]")) {
      const have = h.dataset.slug!.split("-");
      let i = 0;
      for (const w of have) if (i < want.length && w === want[i]) i++;
      if (i === want.length && have.length - want.length < extra) { best = h; extra = have.length - want.length; }
    }
    if (best) return best;
  }
  // Match by words: the quote is raw markdown, the block's text has lost the markup.
  if (a.quote) {
    const q = quotes ? quotes() : quoteBlocks(host, kind);
    const index = q.index.find(a.quote);
    if (index !== null) return q.blocks[index];
  }
  if (a.top) return host.querySelector("[data-b]");        // "@top" — the first block there is
  return null;
}
// A fold's tick and its peek sit inside the passage; their words would otherwise read as part of it.
const CHROME = ".ftick, .fpeek, .ftick-at";
export function quoteBlocks(host: ParentNode, kind: string): QuoteBlocks {
  const blocks = [...host.querySelectorAll(kind === "pdf" ? ".slide" : "[data-b]")];
  return { blocks, index: passageIndex(blocks.map(textBesideFolds)) };
}
export function textBesideFolds(el: Element): string {
  if (!el.querySelector(CHROME)) return el.textContent!;
  let out = "";
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) if (!n.parentElement!.closest(CHROME)) out += n.data;
  return out;
}
// Build the quote index lazily, once per paint.
export const quotesOnce = (host: ParentNode, kind: string): (() => QuoteBlocks) => { let q: QuoteBlocks | null = null; return () => (q ??= quoteBlocks(host, kind)); };
