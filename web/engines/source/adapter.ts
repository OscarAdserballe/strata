import type { Anchor } from "../../../shared/reading/anchors.ts";
import { anchorEl, quotesOnce, type QuoteBlocks } from "../position/anchors-dom.ts";
import { glideTo, waitForAnchor } from "../position/scroll.ts";
import { clearTicks, drawTick } from "../fold/view.ts";
import { type Box, type LayerDom, type LayerIntents, type LayerItem, type Spot, layerDrawer, tintWords } from "../fold/layers.ts";
import { compileQuote } from "../../../shared/reading/compile-quote.ts";
import { mergeRects, rectsToFractions } from "../../../shared/reading/marks.ts";
import { textLayerRange, type PageTextIndex } from "../find/paint.ts";
import { proseRange } from "../prose/paint.ts";
import type { ProseMaps } from "../prose/offsets.ts";

// Everything that differs between kinds of source sits behind this face; the reader above it never asks what kind it shows.
export interface SourceAdapter {
  /** how the source is drawn: "pdf", "html", "transcript" or a prose kind */
  readonly kind: string;
  /** the block an anchor sits in, or null when the source doesn't have it or keeps its blocks out of reach */
  blockOf(a: Anchor): Element | null;
  /** brings an anchor into view and lights it; false when the source doesn't have it */
  reveal(a: Anchor): Promise<boolean>;
  /** ticks on shut passages and sheets over open ones, wherever this source keeps its passages */
  drawLayers(items: readonly LayerItem[], on: LayerIntents): void;
  /** a new source starts with every sheet shut */
  forgetLayers(): void;
  /** a PDF page's text came in: whether a card waits on it for its place */
  pageDrawn?(n: number): boolean;
}

export interface AdapterHost {
  scroller(): HTMLElement | null;
  /** a PDF draws pages near the viewport only; a jump has to ask for the ones it lands on */
  ensureDrawn(): void;
  /** a live page answers from inside its sandbox */
  revealLive(quote: string | null, slug: string | null): Promise<boolean>;
  /** a live page draws its own layers; what is done in them comes back through `on`. `fresh`: a new page, nothing kept */
  layersLive(items: readonly LayerItem[], on: LayerIntents, fresh?: boolean): void;
  /** the prose shown: its source text, which cards' quotes compile against, and where each block's words came from */
  proseDoc(): { text: string; maps: ProseMaps } | null;
  /** a PDF page's text, once that page's text layer is in */
  pdfText(n: number): PageTextIndex | null;
}

// Markdown, transcripts and PDFs: their blocks are in the reader's own DOM, and their sheets lie on a plane at the
// top of the scroller, so they scroll with the page and sit above it.
function readerPlane(host: AdapterHost): Pick<LayerDom, "sheet" | "closeExcept" | "tint"> & { frame(): PlaneFrame | null } {
  const sheets = new Map<string, HTMLElement>();
  const plane = () => host.scroller()?.querySelector<HTMLElement>(":scope > .layer-plane") ?? null;
  return {
    frame() {
      const el = plane();
      if (!el) return null;
      // the used width, not offsetWidth: a rounded width puts the zoom off, and far down a book the sheets a line off
      const r = el.getBoundingClientRect(), wide = parseFloat(getComputedStyle(el).width) || el.offsetWidth, z = wide ? r.width / wide : 1;
      return {
        width: wide, perClient: 1 / z,
        box: (b) => ({ top: (b.top - r.top) / z, bottom: (b.bottom - r.top) / z, left: (b.left - r.left) / z, right: (b.right - r.left) / z }),
      };
    },
    sheet(key) {
      const el = plane();
      if (!el) return null;
      let s = sheets.get(key);
      if (!s || s.parentElement !== el) { s = el.ownerDocument.createElement("div"); el.append(s); sheets.set(key, s); }
      return { host: s, root: s };
    },
    closeExcept(keep) { for (const [k, s] of sheets) if (!keep.has(k)) { s.remove(); sheets.delete(k); } },
    tint: (t) => tintWords(host.scroller()?.ownerDocument ?? null, t),
  };
}

interface PlaneFrame { width: number; perClient: number; box(b: { top: number; bottom: number; left: number; right: number }): Box }

// A PDF's passage is a page, or lines of a book's page as fractions of it: nothing cuts the page, the sheet lies over it.
interface PdfSpot extends Spot { page: number; top: number; bottom: number; slide: boolean; words?: { left: number; right: number; bottom: number } }
function pdfDom(host: AdapterHost): LayerDom & { pageDrawn(n: number): boolean } {
  const slideOf = (n: number) => host.scroller()?.querySelector<HTMLElement>("#pg-" + n) ?? null;
  const plane = readerPlane(host);
  // pages a card waits on for its words
  const waiting = new Set<number>();
  const cardLine = new Map<string, string>();
  return {
    pageDrawn: (n) => waiting.has(n),
    tint: plane.tint,
    spotOf(it) {
      // a card sits on its words, found in the page's text layer by the same compile as everywhere; a question's are washed too
      let tint: Range | null = null;
      if (it.kind === "card" || it.kind === "ask") {
        const n = it.anchor.page ?? null, slide = n ? slideOf(n) : null, idx = n ? host.pdfText(n) : null;
        const ready = !!(slide && idx && slide.querySelector(".tlayer"));
        if (it.kind === "card" && n && !ready) waiting.add(n);
        if (ready) {
          waiting.delete(n!);
          const r = compileQuote(it.anchor.quote, { text: idx!.text });
          tint = r.ok ? textLayerRange(slide!, idx!, r.at.start, r.at.end) : null;
        }
        if (it.kind === "card") {
          const words = tint;
          if (!words || !slide || !n) return null;
          const box = (slide.querySelector("canvas") ?? slide).getBoundingClientRect();
          const rs = mergeRects(rectsToFractions([...words.getClientRects()], box));
          if (!rs.length) return null;
          const top = Math.min(...rs.map((x) => x[1])), bottom = Math.max(...rs.map((x) => x[1] + x[3]));
          const at = { left: Math.min(...rs.map((x) => x[0])), right: Math.max(...rs.map((x) => x[0] + x[2])), bottom };
          if (slide.offsetWidth > slide.offsetHeight * 1.15) return { key: "pg" + n, block: slide, page: n, top: 0, bottom: 1, slide: true, words: at, tint: words } as PdfSpot;
          // a card's line is read once: mid-resize the text layer lags its canvas, and a key that moved would rebuild its sheet
          const line = `${it.id}@${n}`, key = cardLine.get(line) ?? `pg${n}:${Math.round(bottom * 400)}`;
          cardLine.set(line, key);
          return { key, block: slide, page: n, top, bottom, slide: false, words: at, tint: words } as PdfSpot;
        }
      }
      const n = it.anchor.page, rs = it.anchor.rects ?? [];
      const slide = n ? slideOf(n) : null;
      if (!n || !slide) return null;
      const words = rs.length ? { left: Math.min(...rs.map((r) => r[0])), right: Math.max(...rs.map((r) => r[0] + r[2])), bottom: Math.max(...rs.map((r) => r[1] + r[3])) } : undefined;
      if (slide.offsetWidth > slide.offsetHeight * 1.15) return { key: "pg" + n, block: slide, page: n, top: 0, bottom: 1, slide: true, words, tint } as PdfSpot;
      if (!rs.length) return null;
      const top = Math.min(...rs.map((r) => r[1])), bottom = Math.max(...rs.map((r) => r[1] + r[3]));
      return { key: `pg${n}:${Math.round(bottom * 400)}`, block: slide, page: n, top, bottom, slide: false, words, tint } as PdfSpot;
    },
    place(s) {
      const spot = s as PdfSpot, f = plane.frame();
      if (!f) return null;
      const pg = f.box(spot.block.getBoundingClientRect()), h = pg.bottom - pg.top, w = pg.right - pg.left;
      if (h <= 0) return null;
      // words picked on a page: the bracket and the sheet go by the words, not the page's edges
      const col = spot.words && !spot.slide ? { left: pg.left + spot.words.left * w, right: pg.left + Math.max(spot.words.right, 0.6) * w } : { left: pg.left, right: pg.right };
      return {
        passage: { left: col.left, right: col.right, top: pg.top + spot.top * h, bottom: pg.top + spot.bottom * h },
        column: col, width: f.width, unit: 1, perClient: f.perClient,
        // a slide is read whole: its sheet lies over it, under the picked words if there are any, rather than over the next slide
        dock: spot.slide ? (spot.words ? pg.top + spot.words.bottom * h + 8 : pg.top + h * 0.5) : undefined,
      };
    },
    sheet: plane.sheet,
    closeExcept: plane.closeExcept,
    tick(s, marks, peek, open) {
      const spot = s as PdfSpot;
      const at = spot.block.ownerDocument.createElement("div");
      at.className = "ftick-at";
      at.style.cssText = `position:absolute;left:0;right:0;top:${spot.top * 100}%;height:${(spot.bottom - spot.top) * 100}%;pointer-events:none;`;
      spot.block.append(at);
      drawTick(at, spot.key, marks, peek, open);
      at.style.position = "absolute";
      for (const t of at.querySelectorAll<HTMLElement>(".ftick")) t.style.pointerEvents = "auto";
    },
    clearTicks() { host.scroller()?.querySelectorAll(".ftick-at").forEach((n) => n.remove()); },
  };
}

function pageAdapter(kind: string, host: AdapterHost): SourceAdapter {
  const prose = kind !== "pdf";
  const column = () => host.scroller()?.querySelector<HTMLElement>(".page-col") ?? null;
  // a deck's cards are placed by their words on every paint: the passages are indexed once per text written, not per card
  let quotes: { first: Element | null; q: () => QuoteBlocks } | null = null;
  const plane = readerPlane(host);
  const dom: LayerDom = prose ? {
    spotOf(it) {
      const col = column();
      if (!col) return null;
      const first = col.firstElementChild;
      if (!quotes || quotes.first !== first) quotes = { first, q: quotesOnce(col, kind) };
      const q = quotes.q;
      // a card sits on its quote, compiled against the source text like everywhere else, and nowhere if it doesn't compile;
      // words being written about, or asked at, name the block they are in
      const doc = host.proseDoc();
      if (it.kind === "card") {
        const r = doc ? compileQuote(it.anchor.quote, { text: doc.text }) : null;
        const at = r?.ok && doc ? proseRange(col, doc.maps, r.at.start, r.at.end) : null;
        return at ? { key: "b" + at.block.dataset.b, block: at.block, tint: at.range } : null;
      }
      const at = it.anchor.block != null ? col.querySelector(`[data-b="${it.anchor.block}"]`)
        : it.kind === "note" ? col.querySelector(`[data-mark="${it.id}"]`)
        : it.anchor.legacy ? anchorEl(col, kind, it.anchor.legacy, q) : null;
      const block = at?.closest<HTMLElement>("[data-b]");
      const tint = it.kind === "ask" && doc && it.anchor.end > it.anchor.start ? proseRange(col, doc.maps, it.anchor.start, it.anchor.end)?.range ?? null : null;
      return block ? { key: "b" + block.dataset.b, block, tint } : null;
    },
    place(spot) {
      const col = column(), f = plane.frame();
      if (!col || !f) return null;
      const c = f.box(col.getBoundingClientRect()), cs = getComputedStyle(col);
      // a card on a heading asks about the section under it: its sheet lies after that text, not over it
      let end: Element = spot.block;
      if (/^H[1-6]$/.test(spot.block.tagName)) for (let n = spot.block.nextElementSibling; n && !/^H[1-6]$/.test(n.tagName); n = n.nextElementSibling) if (n instanceof HTMLElement && n.dataset.b) end = n;
      const passage = f.box(spot.block.getBoundingClientRect());
      if (end !== spot.block) passage.bottom = f.box(end.getBoundingClientRect()).bottom;
      return {
        passage,
        column: { left: c.left + parseFloat(cs.paddingLeft || "0"), right: c.right - parseFloat(cs.paddingRight || "0") },
        width: f.width, unit: 1, perClient: f.perClient,
      };
    },
    sheet: plane.sheet,
    closeExcept: plane.closeExcept,
    tint: plane.tint,
    tick: (spot, marks, peek, open) => drawTick(spot.block, spot.key, marks, peek, open),
    clearTicks() { const c = column(); if (c) clearTicks(c); },
  } : pdfDom(host);
  const drawer = layerDrawer(dom);
  return {
    kind,
    pageDrawn: (n) => !prose && (dom as ReturnType<typeof pdfDom>).pageDrawn(n),
    drawLayers: (items, on) => drawer.draw(items, on),
    forgetLayers: () => drawer.forget(),
    blockOf: (a) => anchorEl(host.scroller(), kind, a),
    async reveal(a) {
      const el = await waitForAnchor(() => host.scroller(), kind, a) as HTMLElement | null;
      const sc = host.scroller();
      if (!el || !sc) return false;
      if (kind === "pdf") {
        host.ensureDrawn();
        glideTo(sc, el, 26);
        sc.querySelectorAll(".slide.lit").forEach((x) => x.classList.remove("lit"));
        void el.offsetWidth; el.classList.add("lit");
        return true;
      }
      glideTo(sc, el, 22);
      sc.querySelectorAll("p.glow").forEach((x) => x.classList.remove("glow"));
      const p = el.tagName === "P" ? el : el.nextElementSibling as HTMLElement | null;
      if (p && p.tagName === "P") { void p.offsetWidth; p.classList.add("glow"); }
      return true;
    },
  };
}

// A live page draws itself in a sandbox: its blocks are out of reach, so it is asked through the bridge.
function liveAdapter(host: AdapterHost): SourceAdapter {
  return {
    kind: "html",
    drawLayers: (items, on) => host.layersLive(items, on),
    forgetLayers: () => host.layersLive([], { edit() {}, leave() {}, remove() {}, reply() {}, show() {}, later() {}, grade() {}, keep() {}, discard() {}, ask() {}, capture() {} }, true),
    blockOf: () => null,
    reveal: (a) => host.revealLive(a.quote, a.slug),
  };
}

/** One adapter per drawn kind, made once: they hold no state of their own, only the host's getters. */
export function sourceAdapters(host: AdapterHost): (kind: string) => SourceAdapter {
  const made = new Map<string, SourceAdapter>();
  return (kind) => {
    let a = made.get(kind);
    if (!a) made.set(kind, a = kind === "html" ? liveAdapter(host) : pageAdapter(kind, host));
    return a;
  };
}

