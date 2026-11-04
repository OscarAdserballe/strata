// Page thumbnails: cached in IndexedDB, drawn from the reader's open document when possible.

import { useEffect, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { loadPdf, pdfWasmUrl } from "./runtime.ts";

// About 2x the displayed tile width; JPEG is a third the size of PNG with no visible difference.
export const THUMB_W = 320;
const THUMB_TYPE = "image/jpeg";
const THUMB_Q = 0.84;
const PARK_MS = 20000;        // how long an out-of-band document stays open after its pass

// All best-effort: private mode, quota or a blocked upgrade just means drawing again.
let dbP: Promise<IDBDatabase | null> | null = null;
function store(): Promise<IDBDatabase | null> {
  if (dbP) return dbP;
  dbP = new Promise((res) => {
    let rq: IDBOpenDBRequest;
    try { rq = indexedDB.open("strata-thumbs", 1); } catch (e) { return res(null); }
    rq.onupgradeneeded = () => { const d = rq.result; if (!d.objectStoreNames.contains("t")) d.createObjectStore("t"); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
    rq.onblocked = () => res(null);
  });
  return dbP;
}
export async function cacheGet<T = unknown>(k: string): Promise<T | null> {
  const d = await store(); if (!d) return null;
  return new Promise((res) => {
    try { const r = d.transaction("t").objectStore("t").get(k); r.onsuccess = () => res((r.result as T) ?? null); r.onerror = () => res(null); }
    catch (e) { res(null); }
  });
}
export async function cachePut(k: string, v: unknown): Promise<void> {
  const d = await store(); if (!d) return;
  try { d.transaction("t", "readwrite").objectStore("t").put(v, k); } catch (e) { /* over quota */ }
}

// Object URLs are never revoked: they are small and bounded by the thumbnails seen this session.
type Sub = (url: string) => void;
interface Want { src: string; rid: string; page: number; subs: Set<Sub> }
type Thumb = (n: number) => Promise<unknown>;
const mem = new Map<string, string>();
const wanted = new Map<string, Want>();
const pages = new Map<string, number>();
const failed = new Map<string, number>();     // rid → when it last failed, so offline does not spin
const live: { rid: string | null; thumb: Thumb | null } = { rid: null, thumb: null };
const parked: { rid: string | null; doc: PDFDocumentProxy | null; timer: ReturnType<typeof setTimeout> | undefined } = { rid: null, doc: null, timer: undefined };
let running = false;

const keyOf = (rid: string, page: number) => rid + "@" + page + "@" + THUMB_W;
const idle = (fn: () => void) => (typeof requestIdleCallback === "function"
  ? requestIdleCallback(fn, { timeout: 400 }) : setTimeout(fn, 1));

// Fill white first: PDF pages can be transparent and a canvas defaults to transparent black.
export async function raster(doc: PDFDocumentProxy, n: number): Promise<Blob | null> {
  const pg = await doc.getPage(n);
  let cv: HTMLCanvasElement | null = null;
  try {
    const scale = THUMB_W / pg.getViewport({ scale: 1 }).width;
    const vp = pg.getViewport({ scale });
    cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(vp.width));
    cv.height = Math.max(1, Math.round(vp.height));
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("PDF thumbnail canvas allocation failed");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp } as Parameters<PDFPageProxy["render"]>[0]).promise;
    const c = cv;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, THUMB_TYPE, THUMB_Q));
    // give the bitmap back at once — the same discipline the reader's undraw follows
    cv.width = cv.height = 0;
    return blob;
  } finally {
    if (cv) cv.width = cv.height = 0;
    try { pg.cleanup(); } catch (e) {}
  }
}

function deliver(key: string, blob: Blob | null | undefined) {
  const url = blob ? URL.createObjectURL(blob) : "";
  mem.set(key, url);
  const w = wanted.get(key);
  wanted.delete(key);
  if (w) for (const s of w.subs) { try { s(url); } catch (e) {} }
}

const alive = (w: Want | undefined) => !!w && w.subs.size > 0;

// pdf.js 6 has no doc.destroy(); release through the loading task.
const release = (doc: PDFDocumentProxy) => { void doc.loadingTask.destroy().catch(() => {}); };

function park(rid: string, doc: PDFDocumentProxy) {
  clearTimeout(parked.timer);
  if (parked.doc && parked.doc !== doc) release(parked.doc);
  parked.rid = rid; parked.doc = doc;
  parked.timer = setTimeout(() => {
    const d = parked.doc;
    parked.rid = null; parked.doc = null; parked.timer = undefined;
    if (d) release(d);
  }, PARK_MS);
}

// Prefer the cheapest work: a cache hit, then the reader's open document, then opening the file.
async function step(): Promise<boolean> {
  for (const [key, w] of wanted) if (!alive(w)) wanted.delete(key);
  if (!wanted.size) return false;

  for (const [key] of wanted) {
    const rec = await cacheGet<{ blob?: Blob | null }>(key);
    if (rec && rec.blob) { deliver(key, rec.blob); return true; }
    if (rec) { deliver(key, null); return true; }
    break;                                                // one lookup per pass; keep it fair
  }

  for (const [key, w] of wanted) {
    if (w.rid !== live.rid || !live.thumb) continue;
    const blob = (await live.thumb(w.page)) as Blob | null;
    if (blob) await cachePut(key, { blob, at: Date.now() });
    deliver(key, blob);
    return true;
  }

  const first = wanted.entries().next().value;
  if (!first) return false;
  const [, w0] = first;
  const rid = w0.rid;
  const last = failed.get(rid);
  if (last && Date.now() - last < 60000) {
    for (const [key, w] of wanted) if (w.rid === rid) deliver(key, null);
    return true;
  }
  let doc = parked.rid === rid ? parked.doc : null;
  // Unpark while in use so the release can't land mid-page and cache "no picture".
  if (doc) { clearTimeout(parked.timer); parked.timer = undefined; }
  if (!doc) {
    try {
      const pdfjsLib = await loadPdf();
      doc = await pdfjsLib.getDocument({
        url: w0.src,
        disableRange: true, disableStream: true, wasmUrl: pdfWasmUrl(),
      }).promise;
    } catch (e) {
      failed.set(rid, Date.now());
      for (const [key, w] of wanted) if (w.rid === rid) deliver(key, null);
      return true;
    }
  }
  pages.set(rid, doc.numPages);
  for (const [key, w] of Array.from(wanted)) {
    if (w.rid !== rid || !alive(w)) continue;
    if (w.page < 1 || w.page > doc.numPages) { deliver(key, null); continue; }
    let blob: Blob | null = null;
    try { blob = await raster(doc, w.page); } catch (e) { blob = null; }
    await cachePut(key, { blob, at: Date.now() });
    deliver(key, blob);
  }
  park(rid, doc);
  return true;
}

function pump() {
  if (running || !wanted.size) return;
  running = true;
  idle(async () => {
    try { while (await step()) { /* until there is nothing left worth doing */ } }
    catch (e) { /* a cache is never an error the room sees */ }
    finally { running = false; if (wanted.size) pump(); }
  });
}

export function request(src: string, rid: string, page: number, sub: Sub): void {
  const key = keyOf(rid, page);
  const hit = mem.get(key);
  if (hit !== undefined) { sub(hit); return; }
  let w = wanted.get(key);
  if (!w) { w = { src, rid, page, subs: new Set() }; wanted.set(key, w); }
  w.subs.add(sub);
  pump();
}
export function withdraw(rid: string, page: number, sub: Sub): void {
  const w = wanted.get(keyOf(rid, page));
  if (w) { w.subs.delete(sub); }
}

// The reader lends its document and queue; thumbnails run behind page draws, never beside them.
export function attachDoc(rid: string, thumb: Thumb): void {
  live.rid = rid; live.thumb = thumb;
  pump();
}
export function detachDoc(rid: string): void {
  if (!rid || live.rid === rid) { live.rid = null; live.thumb = null; }
}
// Undefined means unknown, not zero pages.
export const pageCount = (rid: string): number | undefined => pages.get(rid);
export function notePages(rid: string, n: number): void { if (rid && n > 0) pages.set(rid, n); }

export function useThumb(src: string | null, rid: string | null | undefined, page: number, want: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() => (rid && want ? mem.get(keyOf(rid, page)) : undefined) ?? null);
  useEffect(() => {
    if (!rid || !src || !want) return;
    let dead = false;
    const sub = (u: string) => { if (!dead) setUrl(u || null); };
    request(src, rid, page, sub);
    return () => { dead = true; withdraw(rid, page, sub); };
  }, [src, rid, page, want]);
  return url;
}

export const get = (src: string, rid: string, page: number) => new Promise<string>((res) => request(src, rid, page, res));
export const stats = () => ({ cached: mem.size, waiting: wanted.size, known: pages.size, live: live.rid });
