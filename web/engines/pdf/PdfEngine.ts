import type { PDFDocumentProxy, PDFPageProxy, PageViewport, RenderTask } from "pdfjs-dist";
import { pageIndex } from "../../../shared/reading/marks.ts";
import { begin as journey, end as arrived } from "../../platform/rum.ts";
import { zoomOf } from "../zoom/zoom.ts";
import { pdfCanvasScale, releasePdfCanvas } from "./canvas.ts";
import { pageTop } from "./landing.ts";
import { loadPdf, pdfWasmUrl, readerWorker, releaseWorker } from "./runtime.ts";
import * as thumbnails from "./thumbnails.ts";
import { bindEndOfContent, fitLayer, type BoundTextLayer } from "./textLayer.ts";
import { pageWindow, DRAW_AHEAD, DRAW_BEHIND, KEEP_AHEAD, KEEP_BEHIND, WHILE_MOVING, SETTLE_MS, NUDGE_PX } from "./window.ts";

type Worker = Awaited<ReturnType<typeof readerWorker>>;
type PdfJs = Awaited<ReturnType<typeof loadPdf>>;
// pdf.js 6 has no doc.destroy(), so the calls below throw into their catch; fixing it changes memory timing.
type Destroyable = { destroy(): Promise<void> };
const destroyOf = (doc: PDFDocumentProxy): Destroyable => doc as unknown as Destroyable;
export type PageText = ReturnType<typeof pageIndex>;

export interface PdfAsk { key: string; rid: string; filename: string; url: string }

export interface PdfEngineOptions {
  scroller(): HTMLElement | null;
  pageZoom(): number;
  readerShown(): boolean;
  landOnPage(): number | null;
  landed(): void;
  pendingScroll(): number | null;
  onLaid(): void;
  onPageDrawn(n: number): void;
  onPageText(n: number): void;
}

interface Current {
  doc: PDFDocumentProxy | null;
  key: string | null;
  rendering: boolean;
  want?: string;
  worker?: Worker;
  drawn?: Map<number, boolean>;
  sweep?: (() => void) | null;
  detach?: (() => void) | null;
  text?: Map<number, PageText>;
  jumped?: () => void;
  redraw?: () => void;
}

export class PdfEngine {
  readonly o: PdfEngineOptions;
  private readonly pdfRef: { current: Current } = { current: { doc: null, key: null, rendering: false } };
  private host: HTMLElement | null = null;
  private asked: PdfAsk | null = null;

  constructor(options: PdfEngineOptions) { this.o = options; }

  get text(): Map<number, PageText> | undefined { return this.pdfRef.current.text; }

  isOpen(key: string): boolean { return this.pdfRef.current.key === key && !this.pdfRef.current.rendering; }

  /** Clears the newest ask so a superseded render doesn't reopen a PDF into the hidden host. */
  forget(): void { this.asked = null; }

  async open(host: HTMLElement, ask: PdfAsk): Promise<void> {
    const pdfRef = this.pdfRef, o = this.o;
    this.host = host; this.asked = ask;
    const key = ask.key;
    // Record the newest ask before any early return; the in-flight render checks against it.
    pdfRef.current.want = key;
    const col = host.querySelector(".pdf-col");
    // Sweep next frame: a document laid out while hidden drew nothing, and nothing else will trigger a draw.
    if (pdfRef.current.key === key && col) {
      o.onLaid();
      const s = pdfRef.current.sweep;
      if (s) requestAnimationFrame(s);
      return;
    }
    if (pdfRef.current.rendering) return;
    pdfRef.current.rendering = true;
    journey("pdf.open");
    if (pdfRef.current.detach) pdfRef.current.detach();
    pdfRef.current.key = null;
    host.replaceChildren();
    const openingCol = document.createElement("div"); openingCol.className = "pdf-col";
    const opening = document.createElement("div"); opening.className = "pdf-loading";
    opening.textContent = `opening ${ask.filename}…`;
    openingCol.appendChild(opening); host.appendChild(openingCol);
    try {
      const pdfjsLib = await loadPdf();
      if (pdfRef.current.want !== key) return;
      const worker = await readerWorker();
      if (pdfRef.current.want !== key) { releaseWorker(worker); return; }
      // Fetch the whole file rather than ranges: these PDFs are image-heavy and the service worker caches it.
      let doc: PDFDocumentProxy;
      try { doc = await pdfjsLib.getDocument({
        url: ask.url,
        disableRange: true,
        disableStream: true,
        // The reader never needs embedded JS; disabling it also limits exposure to parser bugs.
        enableScripting: false,
        wasmUrl: pdfWasmUrl(),
        worker,
      } as Parameters<PdfJs["getDocument"]>[0]).promise; } catch (e) { releaseWorker(worker); throw e; }
      // Compare against `want`, not the current key, which still names the previous source mid-switch.
      if (pdfRef.current.want !== key) { await destroyOf(doc).destroy(); releaseWorker(worker); return; }
      if (pdfRef.current.detach) pdfRef.current.detach();
      // Destroy the previous document, or switching sources leaks whole books.
      if (pdfRef.current.doc) {
        const was = pdfRef.current, done = () => releaseWorker(was.worker);
        try { destroyOf(was.doc!).destroy().then(done, done); } catch (e) { done(); }
      }
      const drawn = new Map<number, boolean>();
      const painted = new Set<number>();
      const failedPages = new Set<number>();
      let disposed = false;
      let activePage: number | null = null, activeRender: RenderTask | null = null;
      pdfRef.current = { doc, worker, key, want: key, rendering: true, drawn, sweep: null, detach: null, text: new Map() };
      const wrap = host.querySelector<HTMLElement>(".pdf-col")!;
      wrap.replaceChildren();
      const head = document.createElement("div"); head.className = "pdf-head";
      const name = document.createElement("span"); name.textContent = ask.filename;
      const count = document.createElement("span"); count.textContent = `${doc.numPages} page${doc.numPages > 1 ? "s" : ""}`;
      head.append(name, count); wrap.appendChild(head);

      // Placeholder height is the displayed (width:100%) height, not the rasterised one.
      const first = await doc.getPage(1);
      const vp1 = first.getViewport({ scale: 1.5 });
      const aspect = vp1.height / vp1.width;
      // Measured live: the column's width isn't known yet and changes on resize or zoom.
      let pageH = 0;
      // Keep the page at the top under the same pixel while placeholder heights change.
      const setPlaceholders = (h: number) => {
        if (!h || h === pageH) return;
        const sc = o.scroller();
        let anchor: { el: HTMLElement; into: number } | null = null;
        if (sc && pageH) {
          for (const s of wrap.querySelectorAll<HTMLElement>(".slide")) {
            if (s.offsetTop <= sc.scrollTop + 4) anchor = { el: s, into: sc.scrollTop - s.offsetTop };
            else break;
          }
        }
        pageH = h;
        for (const s of wrap.querySelectorAll<HTMLElement>(".slide")) {
          if (!s.querySelector("canvas")) s.style.height = h + "px";
        }
        if (anchor && anchor.el.isConnected) sc!.scrollTop = Math.max(0, anchor.el.offsetTop + anchor.into);
      };
      // Keep a measured height until the width changes; re-estimating on scroll shifts restored positions.
      let calibratedWidth = 0;
      const resize = () => {
        if (wrap.clientWidth && wrap.clientWidth === calibratedWidth) return;
        const cv = wrap.querySelector("canvas");
        if (cv) { calibrate(cv); return; }
        setPlaceholders(Math.round((wrap.clientWidth || vp1.width) * aspect));
      };
      // Calibrate from the first drawn page; the estimate's small error compounds over hundreds of pages.
      const calibrate = (cv: HTMLCanvasElement) => {
        const h = Math.round(cv.getBoundingClientRect().height / zoomOf(cv));
        if (h > 0) { calibratedWidth = wrap.clientWidth; setPlaceholders(h); }
      };
      const slides: HTMLElement[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const slide = document.createElement("div");
        slide.className = "slide"; slide.id = "pg-" + n;
        slide.dataset.page = String(n);
        slide.innerHTML = `<span class="no">${n} / ${doc.numPages}</span>`;
        wrap.appendChild(slide);
        slides.push(slide);
      }
      resize();

      const slideOf = (n: number): HTMLElement | undefined => slides[n-1];

      // One page at a time: concurrent pdf.js calls stall, and deadlock on the main-thread fallback.
      const pending: number[] = [];
      let drawing = false;
      let centre = 1, lastTop = 0, fittedWidth = -1, heading = 1, lastScrollAt = 0, settleTimer: ReturnType<typeof setTimeout> | undefined;
      // distance from the page in view, in pages; a tie goes to the page you are heading towards
      const nearness = (n: number) => Math.abs(n - centre) + ((n - centre) * heading < 0 ? 0.5 : 0);
      const unfitted = new Set<number>();   // pages whose layer was built while the column had no size
      // A jump drops the queue: pages left behind would otherwise delay the page in view.
      // Release the claim in `drawn` too, or a dropped page counts as drawn forever.
      const dropPending = () => { for (const n of pending) drawn.delete(n); pending.length = 0; };
      pdfRef.current.jumped = dropPending;
      // Thumbnails share this queue and run after reader pages: two concurrent pdf.js calls can deadlock.
      const thumbQ: { n: number; resolve: (out: unknown) => void }[] = [];
      const drainDraws = async () => {
        if (drawing) return;
        drawing = true;
        try {
          while ((pending.length || thumbQ.length) && !disposed && pdfRef.current.key === key) {
            if (pending.length) {
              // Sort by page distance, not offsetTop: reading offsets here forced a full-column layout per page.
              pending.sort((a, b) => nearness(a) - nearness(b));
              await drawOne(pending.shift()!);
              continue;
            }
            const job = thumbQ.shift()!;
            let out: unknown = null;
            try { out = await thumbnails.raster(doc, job.n); } catch (e) { out = null; }
            job.resolve(out);
          }
        } finally { drawing = false; }
      };
      // Resolve every waiter, even on teardown, or a tile spins forever.
      const dropThumbs = () => { while (thumbQ.length) thumbQ.shift()!.resolve(null); };
      const wantThumb = (n: number) => new Promise<unknown>((resolve) => {
        if (disposed || pdfRef.current.key !== key) return resolve(null);
        thumbQ.push({ n, resolve });
        void drainDraws();
      });
      // The text layer is sized via --scale-factor (not a transform) and built on this queue to avoid deadlock.
      const buildLayer = async (pg: PDFPageProxy, vp: PageViewport, slide: HTMLElement, n: number) => {
        const tc = await pg.getTextContent();
        if (disposed || !drawn.has(n) || pdfRef.current.key !== key || !slide.isConnected) return;
        const layer: BoundTextLayer = document.createElement("div");
        layer.className = "tlayer";
        // the page's width in its OWN units, which is what --scale-factor is measured against
        layer.dataset.pw = String(pg.getViewport({ scale: 1 }).width);
        const textLayer = new pdfjsLib.TextLayer({ textContentSource: tc, container: layer, viewport: vp });
        await textLayer.render();
        if (disposed || !drawn.has(n) || pdfRef.current.key !== key || !slide.isConnected) return;
        // Tag each span with its item index so a selection can be mapped back to page text.
        textLayer.textDivs.forEach((d, i) => { if (d) d.dataset.i = String(i); });
        bindEndOfContent(layer);
        const old = slide.querySelector<BoundTextLayer>(".tlayer");
        if (old) { if (old.release) old.release(); old.remove(); }
        slide.appendChild(layer);
        pdfRef.current.text!.set(n, pageIndex(tc.items as { str: string }[]));
        if (fitLayer(slide)) unfitted.delete(n); else unfitted.add(n);
      };

      const drawOne = async (n: number) => {
        const slide = slideOf(n);
        if (!slide || disposed || pdfRef.current.key !== key) { drawn.delete(n); return; }
        let pg: PDFPageProxy | null = null, cv: HTMLCanvasElement | null = null;
        activePage = n;
        const wanted = () => !disposed && drawn.has(n) && pdfRef.current.key === key && slide.isConnected;
        try {
          pg = await doc.getPage(n);
          if (!wanted()) return;
          // Rasterise at the displayed size; page zoom can change after the document opens.
          const base = pg.getViewport({ scale: 1 });
          const vp = pg.getViewport({ scale: pdfCanvasScale(base.width, base.height, 1.5 * o.pageZoom()) });
          cv = document.createElement("canvas");
          cv.width = Math.max(1, Math.floor(vp.width)); cv.height = Math.max(1, Math.floor(vp.height));
          const context = cv.getContext("2d");
          if (!context) throw new Error("PDF canvas allocation failed");
          activeRender = pg.render({ canvasContext: context, viewport: vp } as Parameters<PDFPageProxy["render"]>[0]);
          await activeRender.promise;
          activeRender = null;
          if (!wanted()) return;
          const old = slide.querySelector("canvas"); if (old) releasePdfCanvas(old);
          slide.querySelector(".pdf-page-error")?.remove();
          slide.insertBefore(cv, slide.firstChild);
          painted.add(n);
          if (painted.size === 1) arrived("pdf.open");
          // the canvas now defines the height; the placeholder must stop adding to it
          slide.style.height = "";
          calibrate(cv);
          o.onPageDrawn(n);
          // Text layer after the picture: the page shows sooner, and a failure still leaves it readable.
          try { await buildLayer(pg, vp, slide, n); }
          catch (e) { console.warn(`couldn't make PDF page ${n} selectable`, e); }
          o.onPageText(n);
        } catch (e) {
          if (wanted() && (e as Error).name !== "RenderingCancelledException") {
            failedPages.add(n);
            console.warn(`couldn't render PDF page ${n}`, e);
            if (!slide.querySelector(".pdf-page-error")) {
              const retry = document.createElement("button");
              retry.className = "pdf-page-error";
              retry.textContent = `Page ${n} couldn't load. Tap to retry.`;
              retry.onclick = () => { failedPages.delete(n); retry.remove(); draw(n); };
              slide.appendChild(retry);
            }
          }
          drawn.delete(n);
        } finally {
          activePage = activeRender = null;
          if (cv && !cv.isConnected) releasePdfCanvas(cv);
          // Evicting the canvas alone doesn't free pdf.js's decoded images and operator lists.
          try { pg?.cleanup(); } catch (e) { /* document was destroyed */ }
          if (!disposed) onScroll();
        }
      };
      // Claim the page now so a second sweep doesn't queue it twice.
      const draw = (n: number) => {
        if (disposed || failedPages.has(n) || drawn.has(n) || !slideOf(n)) return;
        drawn.set(n, true);
        pending.push(n);
        void drainDraws();
      };
      const undraw = (n: number) => {
        const slide = slideOf(n); if (!slide) return;
        if (activePage === n) activeRender?.cancel();
        const cv = slide.querySelector("canvas");
        if (cv) {
          // Restore the placeholder to the canvas's height so freeing a bitmap never shifts the page.
          slide.style.height = Math.round(cv.getBoundingClientRect().height / zoomOf(slide) || pageH) + "px";
          releasePdfCanvas(cv);
        }
        // The text layer and marks go with the bitmap; they repaint when the page draws again.
        slide.querySelectorAll(".mkbox,.findbox").forEach((b) => b.remove());
        const layer = slide.querySelector<BoundTextLayer>(".tlayer");
        if (layer) { if (layer.release) layer.release(); layer.remove(); }
        pdfRef.current.text!.delete(n);
        drawn.delete(n);
        painted.delete(n);
        unfitted.delete(n);
        failedPages.delete(n);
        slide.querySelector(".pdf-page-error")?.remove();
      };

      // Arithmetic, not IntersectionObserver: it never fires inside a CSS-zoomed subtree in Chromium.
      const sweep = () => {
        const sc = o.scroller();
        if (disposed || !sc || pdfRef.current.key !== key) return;
        // A hidden column measures zero; sweeping now would free every page and re-height all placeholders.
        if (!wrap.clientWidth || !sc.clientHeight) return;
        resize();
        const top = sc.scrollTop, bottom = top + sc.clientHeight;
        // Ignore nudges under NUDGE_PX when picking direction, or the ahead/behind windows flip.
        if (Math.abs(top - lastTop) >= NUDGE_PX) { heading = top > lastTop ? 1 : -1; lastTop = top; }
        const down = heading > 0;
        const moving = performance.now() - lastScrollAt < SETTLE_MS;
        const ahead = (d: number) => pageH * (moving ? Math.min(d, WHILE_MOVING) : d);
        const [wantUp, wantDown] = down ? [ahead(DRAW_BEHIND), ahead(DRAW_AHEAD)] : [ahead(DRAW_AHEAD), ahead(DRAW_BEHIND)];
        const [keepUp, keepDown] = down ? [ahead(KEEP_BEHIND), ahead(KEEP_AHEAD)] : [ahead(KEEP_AHEAD), ahead(KEEP_BEHIND)];
        const want = new Set<number>(), keep = new Set<number>();
        const mid = (top + bottom) / 2;
        let nearest = Infinity;
        for (const slide of pageWindow(slides,top-keepUp,bottom+keepDown)) {
          const n = +slide.dataset.page!;
          const a = slide.offsetTop, b = a + slide.offsetHeight;
          if (b >= top - wantUp && a <= bottom + wantDown) want.add(n);
          if (b >= top - keepUp && a <= bottom + keepDown) keep.add(n);
          const off = Math.abs((a + b) / 2 - mid);
          if (off < nearest) { nearest = off; centre = n; }
        }
        // Fast touch scrolls outrun rendering: drop stale queued work and free old bitmaps first.
        for (let i = pending.length - 1; i >= 0; i--) {
          if (!want.has(pending[i])) { drawn.delete(pending[i]); pending.splice(i, 1); }
        }
        // Match by claim or canvas: a jump mid-redraw can leave a canvas without a claim.
        for (const n of new Set([...drawn.keys(),...painted,...failedPages])) {
          if (!keep.has(n) && !pending.includes(n)) undraw(n);
        }
        // Nearest first: the first draw() on an idle queue starts immediately.
        for (const n of [...want].sort((a, b) => nearness(a) - nearness(b))) draw(n);
        // Refit text layers only when the width changed; each fit forces a layout.
        if (wrap.clientWidth !== fittedWidth) {
          fittedWidth = wrap.clientWidth;
          unfitted.clear();
          for (const n of painted) if (!fitLayer(slideOf(n)!)) unfitted.add(n);
        } else for (const n of unfitted) if (fitLayer(slideOf(n)!)) unfitted.delete(n);
      };
      // one sweep per frame at most: scrolling fires far faster than a page can be drawn
      let queued = false;
      const onScroll = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; sweep(); });
      };
      // Scrolling defers the draw-ahead until it pauses, measured from the last significant scroll.
      let movedTop: number | null = null;
      const onMove = () => {
        const at = o.scroller() ? o.scroller()!.scrollTop : 0;
        if (movedTop != null && Math.abs(at - movedTop) < NUDGE_PX) return;
        movedTop = at;
        lastScrollAt = performance.now();
        clearTimeout(settleTimer);
        settleTimer = setTimeout(onScroll, SETTLE_MS + 10);
        onScroll();
      };
      const sc = o.scroller();
      if (sc) sc.addEventListener("scroll", onMove, { passive: true });
      // The reader may have no height yet; the observer sweeps once it is laid out, and on resize or zoom.
      let ro: ResizeObserver | null = null;
      if (sc && typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(onScroll); ro.observe(sc); }
      // Also poll for a few seconds: opening is a burst of layout, and a missed trigger leaves a blank reader.
      let settle = 0;
      const settling = setInterval(() => { if (++settle > 16 || pdfRef.current.key !== key) { clearInterval(settling); return; } sweep(); }, 250);
      pdfRef.current.sweep = sweep;
      // Redraw through the same queue so pages are replaced in place and never go blank.
      pdfRef.current.redraw = () => { for (const n of drawn.keys()) if (!pending.includes(n)) pending.push(n); void drainDraws(); };
      pdfRef.current.detach = () => {
        if (disposed) return;
        disposed = true;
        activeRender?.cancel();
        dropPending();
        for (const n of new Set([...drawn.keys(), ...painted, ...failedPages])) undraw(n);
        if (sc) sc.removeEventListener("scroll", onMove);
        clearTimeout(settleTimer);
        if (ro) ro.disconnect();
        clearInterval(settling);
        thumbnails.detachDoc(key.split(":")[1]);
        dropThumbs();
      };
      thumbnails.notePages(ask.rid, doc.numPages);
      thumbnails.attachDoc(ask.rid, wantThumb);
      // Land before the first draw so the target page, not page one, is rasterised first.
      const sc1 = o.scroller();
      if (sc1 && o.readerShown()) {
        const land = o.landOnPage();
        const to = land ? slideOf(land) : null;
        if (to) {
          const y = pageTop(to);
          sc1.scrollTop = y;
          if (Math.abs(sc1.scrollTop - y) <= 2) o.landed();
        } else if (o.pendingScroll() != null) sc1.scrollTop = o.pendingScroll()!;
        lastTop = sc1.scrollTop;
      }
      sweep();
      o.onLaid();
    } catch (e) {
      const wrap = host.querySelector(".pdf-col");
      if (wrap) {
        wrap.replaceChildren();
        const failed = document.createElement("div"); failed.className = "pdf-loading";
        failed.textContent = `couldn't open ${ask.filename} — ${(e as Error).message}`;
        wrap.appendChild(failed);
      }
    } finally {
      pdfRef.current.rendering = false;
      // Open the ask that arrived mid-render, unless the reader has left PDFs (forget).
      const next = this.asked;
      if (pdfRef.current.want && pdfRef.current.want !== key && next && this.host) void this.open(this.host, next);
    }
  }

  // Sweep next frame so a jump to an undrawn page doesn't arrive at a blank box.
  ensureDrawn(): void {
    const pdfRef = this.pdfRef;
    if (pdfRef.current.jumped) pdfRef.current.jumped();
    const s = pdfRef.current.sweep;
    if (s) requestAnimationFrame(s);
  }

  redraw(): void {
    const p = this.pdfRef.current;
    if (p.doc && p.redraw) p.redraw();
  }

  dispose(): void {
    const p = this.pdfRef.current;
    if (p.detach) p.detach();
    if (p.doc) {
      const done = () => releaseWorker(p.worker);
      try { destroyOf(p.doc).destroy().then(done, done); } catch (e) { done(); }
    }
    this.pdfRef.current = { doc: null, key: null, rendering: false };
    this.asked = null;
  }
}
