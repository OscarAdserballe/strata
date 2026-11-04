// A card's place in its source is a verbatim quote of the words it asks about, and nothing else.
// One compile step decides whether a quote resolves, for distil, an agent's edit and the reader alike:
// it resolves when its words occur exactly once in the text it belongs to, and the error says why not.

export const QUOTE_WORDS = { min: 4, max: 40 } as const;

/** The text a quote is held to: a PDF's pages (within a section's pages, if it has them), or a whole text. */
export interface QuoteText { text?: string | null; pages?: readonly string[] | null; firstPage?: number; lastPage?: number }
/** Where a quote resolved: its page in a PDF (1-based) and the offsets of its words in that page's text, or in the text. */
export interface QuoteAt { page: number | null; start: number; end: number }
export type Compiled = { ok: true; at: QuoteAt } | { ok: false; error: string };

// what reads as no word: a markdown link's target, an HTML entity, a transcript's [music] or [0:12], a soft hyphen or zero-width space
const SKIP = /\]\([^)\s]*\)|&(?:amp|nbsp|lt|gt|quot|apos|#\d+);|\[(?:music|applause|laughter|inaudible|\d{1,2}:\d{2}(?::\d{2})?)\]|[­​-‍﻿]/gi;
const WORD = /[\p{L}\p{N}]/u, MARK = /^\p{M}$/u, MARKS = /\p{M}/gu;

/** Words only, lower case, one space between: with, for each folded character, the offset it came from. */
export function foldWords(text: string): { s: string; at: number[] } {
  const skip = new Uint8Array(text.length);
  for (const m of text.matchAll(SKIP)) skip.fill(1, m.index!, m.index! + m[0].length);
  // built as a list and tracked by its last character: reading the end of a growing string flattens it each time
  const out: string[] = [" "], at: number[] = [0];
  let gap = true;
  const space = (i: number) => { if (!gap) { out.push(" "); at.push(i); gap = true; } };
  for (let i = 0; i < text.length; i += text.charCodeAt(i) >= 0xd800 && text.charCodeAt(i) < 0xdc00 && i + 1 < text.length ? 2 : 1) {
    if (skip[i]) { space(i); continue; }
    const code = text.charCodeAt(i);
    // plain ASCII is most of any text: no normalising needed
    if (code < 128) {
      if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122)) { out.push(text[i]); at.push(i); gap = false; continue; }
      if (code >= 65 && code <= 90) { out.push(String.fromCharCode(code + 32)); at.push(i); gap = false; continue; }
      // a word broken over a line ("identi-\nfication") is one word
      if (code === 45 && i > 0 && WORD.test(text[i - 1])) {
        const m = /^-[ \t]*\r?\n\s*/.exec(text.slice(i, i + 48));
        if (m && WORD.test(text[i + m[0].length] ?? "")) { i += m[0].length - 1; continue; }
      }
      space(i);
      continue;
    }
    // a letter outside the basic plane ("𝑃") is two code units, read as one
    const c = String.fromCodePoint(text.codePointAt(i)!);
    // accents fold away, so "ȳ" and "y" with a combining macron are the same letter
    if (MARK.test(c)) continue;
    const k = c.normalize("NFKD").replace(MARKS, "").normalize("NFKC").toLowerCase();
    for (const ch of k) {
      if (WORD.test(ch)) { out.push(ch); at.push(i); gap = false; }
      else space(i);
    }
  }
  if (!gap) { out.push(" "); at.push(text.length); }
  return { s: out.join(""), at };
}

const shown = (quote: string) => JSON.stringify(quote.length > 90 ? quote.slice(0, 87) + "…" : quote);

// a deck compiles many quotes against the same pages: each text is folded once
const folded = new Map<string, { s: string; at: number[] }>();
function foldOnce(text: string): { s: string; at: number[] } {
  let f = folded.get(text);
  if (!f) {
    f = foldWords(text);
    folded.set(text, f);
    if (folded.size > 600) folded.delete(folded.keys().next().value as string);
  }
  return f;
}

// a PDF's extracted text splits words its renderer joins ("fi rst", "fea- tures"): words are also matched blind to spaces
const compact = new Map<string, { c: string; to: number[] }>();
function compactOnce(f: { s: string }): { c: string; to: number[] } {
  let k = compact.get(f.s);
  if (!k) {
    let c = ""; const to: number[] = [];
    for (let i = 0; i < f.s.length; i++) if (f.s[i] !== " ") { c += f.s[i]; to.push(i); }
    k = { c, to };
    compact.set(f.s, k);
    if (compact.size > 600) compact.delete(compact.keys().next().value as string);
  }
  return k;
}

/** Every occurrence of the quote's words in a text, as offsets into that text: as words, or else blind to spaces from word to word. */
function occurrences(text: string, needle: string): { start: number; end: number }[] {
  const f = foldOnce(text), out: { start: number; end: number }[] = [];
  for (let i = f.s.indexOf(needle); i >= 0; i = f.s.indexOf(needle, i + 1)) {
    out.push({ start: f.at[i + 1], end: f.at[i + needle.length - 2] + 1 });
  }
  if (out.length) return out;
  const k = compactOnce(f), bare = needle.replace(/ /g, "");
  for (let j = k.c.indexOf(bare); j >= 0; j = k.c.indexOf(bare, j + 1)) {
    const a = k.to[j], b = k.to[j + bare.length - 1];
    if (f.s[a - 1] === " " && f.s[b + 1] === " ") out.push({ start: f.at[a], end: f.at[b] + 1 });
  }
  return out;
}

export function compileQuote(quote: unknown, src: QuoteText): Compiled {
  const q = String(quote ?? "").trim();
  const words = foldWords(q).s.trim();
  const n = words ? words.split(" ").length : 0;
  if (n < QUOTE_WORDS.min || n > QUOTE_WORDS.max) {
    return { ok: false, error: `the quote ${shown(q)} is ${n} word${n === 1 ? "" : "s"}; quote ${QUOTE_WORDS.min} to ${QUOTE_WORDS.max} consecutive words, exactly as the source has them` };
  }
  const needle = " " + words + " ";
  if (src.pages && src.pages.length) {
    const lo = Math.max(1, src.firstPage ?? 1), hi = Math.min(src.pages.length, src.lastPage ?? src.pages.length);
    const hits: QuoteAt[] = [], outside: number[] = [];
    src.pages.forEach((p, i) => {
      for (const o of occurrences(p, needle)) (i + 1 >= lo && i + 1 <= hi ? hits.push({ page: i + 1, ...o }) : outside.push(i + 1));
    });
    if (hits.length === 1) return { ok: true, at: hits[0] };
    if (hits.length > 1) return { ok: false, error: `the quote ${shown(q)} occurs ${hits.length} times (pp. ${hits.map((h) => h.page).join(", ")}); quote more of the sentence so it occurs once` };
    if (outside.length) return { ok: false, error: `the quote ${shown(q)} is on p. ${outside.join(", ")}, outside this passage (pp. ${lo}–${hi}); quote words from the passage the card asks about` };
    return { ok: false, error: `the quote ${shown(q)} is not in the source verbatim; copy consecutive words exactly as they stand: no paraphrase, no ellipsis, no words from two pages` };
  }
  if (src.text == null || !src.text.trim()) return { ok: false, error: "this source has no text to quote from" };
  const hits = occurrences(src.text, needle);
  if (hits.length === 1) return { ok: true, at: { page: null, ...hits[0] } };
  if (hits.length > 1) return { ok: false, error: `the quote ${shown(q)} occurs ${hits.length} times in the source; quote more of the sentence so it occurs once` };
  return { ok: false, error: `the quote ${shown(q)} is not in the source verbatim; copy consecutive words exactly as they stand: no paraphrase, no ellipsis, no added or changed words` };
}

/** The anchor a card is stored with: the page it compiled to, for a PDF, and the quote itself. */
export const quoteAnchor = (quote: string, at: QuoteAt): string =>
  `${at.page != null ? `p. ${at.page} · ` : ""}quote: ${JSON.stringify(quote.trim())}`;

/** A card's quote and the page it was compiled to, read back from its stored anchor; null for an anchor that is not a quote. */
export function quoteOfAnchor(source: unknown): { quote: string; page: number | null } | null {
  const s = String(source ?? "");
  const m = s.match(/(?:^| · )quote:\s*("[\s\S]*")$/);
  if (!m) return null;
  let quote: string;
  try { quote = JSON.parse(m[1]); } catch { return null; }
  if (typeof quote !== "string" || !quote.trim()) return null;
  const p = s.slice(0, m.index).match(/^p\. (\d+)$/);
  return { quote, page: p ? +p[1] : null };
}

/** A stored anchor, compiled again: a card placed by anything but a quote that resolves does not compile.
 *  A PDF anchor names the page it was placed on, so its words need only be its own on that page, as the reader reads them. */
export function compileAnchor(source: unknown, src: QuoteText): Compiled {
  const q = quoteOfAnchor(source);
  if (!q) return { ok: false, error: String(source ?? "").trim() ? `the anchor ${shown(String(source))} is not a quote; a card is placed by a verbatim quote of the words it asks about` : "the card has no anchor; give it a verbatim quote of the words it asks about" };
  if (q.page == null || !src.pages?.length) return compileQuote(q.quote, src);
  const lo = Math.max(1, src.firstPage ?? 1), hi = Math.min(src.pages.length, src.lastPage ?? src.pages.length);
  if (q.page < lo || q.page > hi) return { ok: false, error: `the quote ${shown(q.quote)} is placed on p. ${q.page}, outside this passage (pp. ${lo}–${hi})` };
  const r = compileQuote(q.quote, { pages: src.pages, firstPage: q.page, lastPage: q.page });
  return r.ok || !/outside this passage/.test(r.error) ? r : { ok: false, error: `the quote ${shown(q.quote)} is not on p. ${q.page}, where it is placed` };
}

/** Words picked in a text, grown a word at a time on either side until they compile: a card written from a few
 *  words that occur elsewhere too still gets a place of its own, and one written from a long passage sits on its
 *  opening words. Null when no span up to the limit is unique. */
export function widenQuote(text: string, start: number, end: number): { quote: string; start: number; end: number } | null {
  const word = /[\p{L}\p{N}]/u;
  let s = Math.max(0, start), e = Math.min(text.length, end);
  // a selection can begin or end inside a word: it is held to whole words
  while (s > 0 && word.test(text[s - 1]) && word.test(text[s] ?? "")) s--;
  while (e < text.length && word.test(text[e]) && word.test(text[e - 1] ?? "")) e++;
  // a passage longer than a quote is placed by its opening words
  const long = [...text.slice(s, e).matchAll(/[\p{L}\p{N}]+/gu)];
  if (long.length > QUOTE_WORDS.max) e = s + long[24].index! + long[24][0].length;
  const outLeft = () => { while (s > 0 && !word.test(text[s - 1])) s--; while (s > 0 && word.test(text[s - 1])) s--; };
  const outRight = () => { while (e < text.length && !word.test(text[e])) e++; while (e < text.length && word.test(text[e])) e++; };
  for (let i = 0; i < 2 * QUOTE_WORDS.max; i++) {
    const quote = text.slice(s, e).replace(/\s+/g, " ").trim();
    const r = compileQuote(quote, { text });
    if (r.ok) return { quote, start: s, end: e };
    if (/is not in the source/.test(r.error) || foldWords(quote).s.trim().split(" ").length >= QUOTE_WORDS.max) return null;
    const was = [s, e];
    if (i % 2 === 0 && e < text.length) outRight(); else if (s > 0) outLeft(); else outRight();
    if (was[0] === s && was[1] === e) return null;
  }
  return null;
}

/** A quote as it reads, without the markdown it was copied with: only when that leaves its words as they were. */
export function readableQuote(quote: string): string {
  const plain = quote.replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, "$1").replace(/(^|[^\p{L}\p{N}*_`~])[*_`~]+|[*_`~]+(?=[^\p{L}\p{N}]|$)/gu, "$1").trim();
  return foldWords(plain).s === foldWords(quote).s ? plain : quote.trim();
}
