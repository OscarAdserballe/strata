// A pin appears only when the anchor resolves in the open resource: no match, no pin.

export interface Anchor {
  slide: number | null;
  sec: string | null;
  ts: string | null;
  slug: string | null;
  quote: string | null;
  top: boolean;
}

import { plainQuote } from "./prose-slugs.ts";
import { compileQuote, readableQuote } from "./compile-quote.ts";

export function anchorOf(card: { source?: unknown; excerpt?: unknown }): Anchor {
  let s = String(card.source || ""), passage: string | null = null;
  const encoded = s.match(/(?:^| · )quote:\s*("[\s\S]*")$/);
  if (encoded) {
    try { passage = JSON.parse(encoded[1]); s = s.slice(0, encoded.index); } catch { /* legacy free-text source */ }
  }
  const slide = s.match(/\b(?:slides?|pages?|p\.?|pp\.?)\s*(\d+)/i);
  const sec = s.match(/§\s*([\d]+(?:\.[\d]+)*)|\b(\d+\.\d+)\b/);
  const ts = s.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);   // 41:20 — a transcript's own anchor
  // #early-impact — how a distil anchors prose whose headings carry no numbers
  const slug = s.match(/#([a-z0-9][\w-]*)/i);
  // a verbatim quote, re-found in the text at jump time; straight or curly quotes
  const quote = s.match(/["“]([^"“”]{6,240})["”]/);
  return {
    slide: slide ? +slide[1] : null, sec: sec ? (sec[1] || sec[2]) : null, ts: ts ? ts[1] : null,
    slug: slug ? slug[1].toLowerCase() : null, quote: passage || (quote ? quote[1].trim() : null) || (typeof card.excerpt === "string" ? card.excerpt : null), top: /@top\b/i.test(s),
  };
}

// Match on words, not characters: emphasis marks, quote styles and wrapping vanish under this normalisation.
export const normQuote = (s: unknown): string =>
  plainQuote(String(s ?? "")).normalize("NFKC").toLowerCase()
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, "")
    .replace(/&(?:amp|nbsp|lt|gt|quot|apos);/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Normalise once, search many quotes: normalising per card made a repaint cost cards x source. */
export function passageIndex(blocks: string[]): { find(quote: string): number | null } {
  const parts = blocks.map(normQuote), text = " " + parts.join(" ") + " ";
  const starts: number[] = [];
  let start = 0;
  for (const p of parts) { starts.push(start); start += p.length + 1; }
  return {
    find(quote: string): number | null {
      const needle = normQuote(quote);
      if (!needle) return null;
      const at = text.indexOf(" " + needle + " ");
      if (at < 0 || text.indexOf(" " + needle + " ", at + 1) >= 0) return null;
      for (let i = 0; i < parts.length; i++) if (at < starts[i] + parts[i].length + 1) return i;
      return null;
    },
  };
}

export function passageBlock(blocks: string[], quote: string): number | null {
  return passageIndex(blocks).find(quote);
}

export const quoteAnchor = (quote: string): string => `quote: ${JSON.stringify(readableQuote(quote))}`;

export function anchorLabel(kind: string, a: Anchor): string | null {
  if (kind === "pdf" && a.slide) return `page ${a.slide}`;
  if (kind === "transcript" && a.ts) return `at ${a.ts}`;
  if (kind !== "pdf" && a.sec) return `§${a.sec}`;
  if (kind !== "pdf" && a.slug) return a.slug.replaceAll("-", " ");
  if (a.quote) return `“${a.quote.slice(0, 70)}${a.quote.length > 70 ? "…" : ""}”`;
  return a.top ? "start of source" : null;
}

export function inferSourceAnchor(kind: string, text: string, pages: string[], candidates: string[]): string | null {
  const src = kind === "pdf" ? { pages } : { text };
  for (const candidate of candidates) {
    const quotes = [...candidate.matchAll(/["“]([^"“”]{20,4000})["”]/g)].map(m => m[1]);
    // a long passage is placed by the first of its sentences that is the source's alone
    const pieces = [candidate, ...quotes, ...candidate.split(/\.{3}|…/), ...candidate.split(/(?<=[.!?])\s+/)].map(s => s.trim());
    for (const piece of pieces) {
      if (normQuote(piece).split(" ").length < 5 || piece.length > 4000) continue;
      const r = compileQuote(piece, src);
      if (r.ok) return (r.at.page != null ? `p. ${r.at.page} · ` : "") + quoteAnchor(piece);
    }
  }
  return null;
}
