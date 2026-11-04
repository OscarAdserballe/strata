import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { sectionAtPage } from "../../../shared/reading/pdf-chapters.ts";
import { StrataAPI } from "../../data/api.ts";
import type { Section } from "../../../shared/types/index.ts";

type Ref<T> = MutableRefObject<T>;
export type ChapterSection = Section;

export interface ChapterReader {
  pageRef: Ref<HTMLElement | null>;
  landOnPage: Ref<number | null>;
  live(): { pairs: { sectionId?: string | null }[]; solo: boolean };
  openPair(i: number): void;
  toast(t: string): void;
}

export function useChapters(reader: ChapterReader, { activeId, pairIdx, src, sectionsHere, openSection, followChapters }: {
  activeId: string | null; pairIdx: number; src: { id: string; kind: string } | null;
  sectionsHere: ChapterSection[]; openSection: ChapterSection | null; followChapters: boolean;
}) {
  const { pageRef } = reader;
  const [atPage, setAtPage] = useState(0);
  useEffect(() => {
    const sc = pageRef.current;
    if (!sc || !src || src.kind !== "pdf" || sectionsHere.length < 2) { setAtPage(0); return; }
    let t: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const slides = sc.querySelectorAll<HTMLElement>(".slide");
      if (!slides.length) return;
      // probe a little below the top: a chapter's lead-in leaves the top pixel on the previous page
      const top = sc.scrollTop + 90;
      let n = 0;
      for (const s of slides) { if (s.offsetTop <= top) n = +(s.dataset.page as string); else break; }
      setAtPage(n);
    };
    const onScroll = () => { clearTimeout(t); t = setTimeout(look, 120); };
    sc.addEventListener("scroll", onScroll, { passive: true });
    const settle = setInterval(look, 400);
    setTimeout(() => clearInterval(settle), 4000);
    look();
    return () => { clearTimeout(t); clearInterval(settle); sc.removeEventListener("scroll", onScroll); };
  }, [activeId, pairIdx, src && src.id, sectionsHere.length]);

  const atSection: ChapterSection | null = atPage
    ? sectionAtPage(sectionsHere, atPage, openSection?.id)
    : null;
  const driftSection = (atSection && openSection && atSection.id !== openSection.id) ? atSection : null;
  // a ref, because the keydown handler isn't re-bound on scroll and would read a stale value
  const driftRef = useRef<ChapterSection | null>(null); driftRef.current = driftSection;

  // dwell on top of the probe's debounce, so scrolling through a boundary adopts nothing
  useEffect(() => {
    if (!followChapters || !driftSection || driftSection.kind === "apparatus") return;
    if (!reader.live().pairs.some((p) => p.sectionId === driftSection.id)) return;
    const t = setTimeout(() => {
      const d = driftRef.current;
      if (!d || d.id !== driftSection.id || reader.live().solo) return;
      StrataAPI.log("drift_follow", { board: activeId, to: d.label || null });
      adoptDrift();
    }, 350);
    return () => clearTimeout(t);
  }, [followChapters, driftSection && driftSection.id]);

  function adoptDrift() {
    const drift = driftRef.current;
    if (!drift) return;
    const i = reader.live().pairs.findIndex((p) => p.sectionId === drift.id);
    if (i < 0) { reader.toast("that chapter has no page on this board"); return; }
    const keep = pageRef.current ? pageRef.current.scrollTop : null;
    reader.openPair(i);
    reader.landOnPage.current = null;                       // stay where you are, do not jump
    if (keep != null) requestAnimationFrame(() => { if (pageRef.current) pageRef.current.scrollTop = keep; });
    reader.toast(drift.label as string);
  }

  return { atPage, atSection, driftSection, driftRef, adoptDrift };
}
