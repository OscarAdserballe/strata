import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { StrataAPI } from "../../data/api.ts";
import { findHits, type FindHit } from "../../engines/find/find.ts";
import { clearFindPaint as clearFind, paintProseHit, snapToPdfHit, type PageTextIndex } from "../../engines/find/paint.ts";

type Ref<T> = MutableRefObject<T>;
export interface FindState { q: string; hits: FindHit[]; at: number; missing: boolean; tick?: number }

export interface FindSource { id: string; kind: string }

export interface FindReader {
  here(): { activeId: string | null; src: FindSource | null };
  pageRef: Ref<HTMLElement | null>;
  proseRef: Ref<HTMLElement | null>;
  pdfHostRef: Ref<HTMLElement | null>;
  docRef: Ref<{ text: string; maps: number[][] }>;
  pageIndex(page: number): PageTextIndex | null | undefined;
  ensureDrawn(): void;
  scrollTo(el: Element, pad: number): void;
  panelOpen(what: string): void;
}

export function useFind(reader: FindReader, moved: readonly unknown[]) {
  const [find, setFind] = useState<FindState | null>(null);
  const live = useRef(find);
  live.current = find;
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findRunRef = useRef(0);       // bumps to orphan any in-flight jump's paint polling
  const pdfPagesRef = useRef<Record<string, string[]>>({});

  function openFind() {
    reader.panelOpen("find");
    setFind((f) => f || { q: "", hits: [], at: -1, missing: false });
    setTimeout(() => { const el = findInputRef.current; if (el) { el.focus(); el.select(); } }, 30);
  }
  function closeFind() {
    findRunRef.current++;
    clearFindPaint();
    setFind(null);
  }
  function clearFindPaint() { clearFind(reader.proseRef.current, reader.pdfHostRef.current); }
  // `tick` re-runs this when the fetch lands, so typing during it never gets a stale list
  useEffect(() => {
    if (!find) return;
    const st = reader.here();
    const q = find.q.trim();
    if (q.length < 2 || !st.src) { clearFindPaint(); setFind((f) => f && { ...f, hits: [], at: -1, missing: false }); return; }
    const src = st.src;
    if (src.kind === "pdf" && !pdfPagesRef.current[src.id]) {
      const rid = src.id;
      let dead = false;
      StrataAPI.pageText(st.activeId as string, rid)
        .then((pages: string[]) => { pdfPagesRef.current[rid] = pages; if (!dead) setFind((f) => f && { ...f, tick: (f.tick || 0) + 1 }); })
        .catch(() => { if (!dead) setFind((f) => f && { ...f, hits: [], at: -1, missing: true }); });
      return () => { dead = true; };
    }
    // rows uploaded before extraction have no page text
    if (src.kind === "pdf" && !(pdfPagesRef.current[src.id] || []).length) {
      setFind((f) => f && { ...f, hits: [], at: -1, missing: true });
      return;
    }
    const hits = findHits(q, src.kind === "pdf" ? { pages: pdfPagesRef.current[src.id] || [] } : { text: reader.docRef.current.text || "" });
    setFind((f) => f && { ...f, hits, at: hits.length ? 0 : -1, missing: false });
    if (hits.length) gotoFindHit(hits, 0); else clearFindPaint();
  }, [find && find.q, find && find.tick]);
  function findStep(d: number) {
    const f = live.current;
    if (!f || !f.hits.length) return;
    const at = (f.at + d + f.hits.length) % f.hits.length;
    setFind({ ...f, at });
    gotoFindHit(f.hits, at);
  }
  function gotoFindHit(hits: FindHit[], i: number) {
    const src = reader.here().src;
    const h = hits[i];
    if (!h || !src) return;
    const token = ++findRunRef.current;
    clearFindPaint();
    if (src.kind === "pdf") {
      const host = reader.pageRef.current; if (!host) return;
      const slide = host.querySelector<HTMLElement>("#pg-" + h.page); if (!slide) return;
      reader.ensureDrawn();
      snapToPdfHit({ scroller: () => reader.pageRef.current, slide, hit: h,
        pageText: (pdfPagesRef.current[src.id] || [])[(h.page as number) - 1] || "",
        index: (page) => reader.pageIndex(page),
        live: () => findRunRef.current === token });
      return;
    }
    const host = reader.proseRef.current; if (!host) return;
    const first = paintProseHit(host, reader.docRef.current.maps || [], h);
    if (first) reader.scrollTo(first, 120);
  }
  useEffect(() => {
    if (!live.current) return;
    findRunRef.current++;
    clearFindPaint();
    setFind(null);
  }, moved);

  const findQuery = (q: string) => setFind((f) => f && { ...f, q });
  return { find, findInputRef, openFind, closeFind, findStep, findQuery };
}
