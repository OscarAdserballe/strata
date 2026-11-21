import { useEffect, useRef, useState } from "react";
import { widenQuote } from "../../../shared/reading/compile-quote.ts";
import type { MutableRefObject } from "react";
import type { Mark } from "../../../shared/types/index.ts";
import { StrataAPI } from "../../data/api.ts";
import { store as roomStore } from "../../data/store.ts";
import { marksKey } from "../../data/entities/boards.ts";
import { marks as markOps, newMarkId, type MarkDraft } from "../../data/entities/marks.ts";
import { proseSelection, type ProseMaps } from "../../engines/prose/offsets.ts";
import { zoomOf } from "../../engines/zoom/zoom.ts";
import { NUDGE_PX } from "../../engines/pdf/window.ts";
import { TOUCH } from "../../platform/device.js";
import { begin as journey, end as arrived } from "../../platform/rum.ts";
import { drawnAs } from "../../engines/html/drawn.ts";
import { typing } from "../keys/registry.ts";
import { chipKey, isMarkKey, type ChipAct, type ChipOffer } from "./chips.ts";
import { asking, newAskId } from "../fold/asking.ts";
import { openFoldCard } from "../card/doors.ts";
import { pdfSelection, type PageTextIndex, type PdfRange } from "./selection.ts";

type Ref<T> = MutableRefObject<T>;
export interface MarkSource { id: string; kind: string }
export interface OpenMark { id: string; draft: string; prefill?: string }
/** over the picked words, and the line under them where the chips will sit */
export interface SelMenu { x: number; y: number; under: number }
type Place = { start: number; end: number; quote: string; page: number | null; rects: number[][]; box: string | null; block: number | null };
/** the chips under a mark; one just made carries its words as picked, and a live page's own words for a card */
export interface Chips { id: string; x: number; y: number; fresh: boolean; at: Place | null; own: string | null }

export interface MarksReader {
  pageRef: Ref<HTMLElement | null>;
  proseRef: Ref<HTMLElement | null>;
  pdfHostRef: Ref<HTMLElement | null>;
  docRef: Ref<{ maps: ProseMaps; text: string }>;
  pageIndex(page: number): PageTextIndex | null | undefined;
  live(): { activeId: string | null; src: MarkSource | null; onHome: boolean; treeOpen: boolean };
  toast(t: string, ms?: number): void;
  toastWhy(e: unknown, said: string): void;
  reread(boardId: string): void;
  clearLive?(): void;
}
/** words picked in a live page, or a whole labelled box (`box`) */
export interface LiveSelection { start: number; end: number; quote: string; box?: string | null; own?: string | null }

const NO_MARKS: readonly Mark[] = Object.freeze([]);
export function marksOn(bid: string | null | undefined, src: { id: string } | null | undefined): readonly Mark[] {
  if (!bid || !src) return NO_MARKS;
  const all = roomStore.get<Mark[]>(marksKey(bid));
  return all ? all.filter((m) => m.resourceId === src.id) : NO_MARKS;
}

type Act = { type: "create" | "delete"; id: string; payload: MarkDraft & { note?: string | null } }
  | { type: "note"; id: string; before: string | null; after: string | null };
type Failure = any;

export function useMarks(reader: MarksReader, { pairIdx, loading, notesOnly = false }: { pairIdx: number; loading: boolean; notesOnly?: boolean }) {
  const { pageRef, proseRef, pdfHostRef, docRef } = reader;
  const [selMenu, setSelMenu] = useState<SelMenu | null>(null);
  const [chips, setChips] = useState<Chips | null>(null);
  const selMenuRef = useRef(selMenu);
  selMenuRef.current = selMenu;
  const [openMark, setOpenMark] = useState<OpenMark | null>(null);
  // the PDF draw loop reads this long after the render that started it
  const openMarkRef = useRef(openMark);
  openMarkRef.current = openMark;
  // kept out of state so reading it never waits for a render
  const pdfSelRef = useRef<PdfRange | null>(null);
  // a live page's selection lives in its frame, so the bridge hands it over and it is held here
  const liveSelRef = useRef<LiveSelection | null>(null);
  // a ref, not state: a re-render on each push would repaint every mark
  const undoRef = useRef(new Map<string, { past: Act[]; future: Act[] }>());
  const undoOf = (bid: string) => {
    let u = undoRef.current.get(bid);
    if (!u) undoRef.current.set(bid, u = { past: [], future: [] });
    return u;
  };
  const markNow = (mid: string) => (roomStore.get<Mark[]>(marksKey(reader.live().activeId as string)) || []).find((x) => x.id === mid);
  const { toast, toastWhy } = reader;

  function paintPdfMarks(page: number | null = null) {
    const host = pdfHostRef.current; if (!host) return;
    const scope = page == null ? host : host.querySelector("#pg-" + page);
    if (!scope) return;
    scope.querySelectorAll(".mkbox").forEach((b) => b.remove());
    const { activeId: bid, src: s } = reader.live();
    const om = openMarkRef.current;
    if (!bid || !s || s.kind !== "pdf") return;
    for (const m of marksOn(bid, s)) {
      if (m.resourceId !== s.id || !m.page || !(m.rects || []).length) continue;
      if (page != null && m.page !== page) continue;
      const slide = host.querySelector("#pg-" + m.page);
      if (!slide) continue;
      // on a page without its canvas the boxes would float in an empty rectangle
      if (!slide.querySelector("canvas")) continue;
      (m.rects || []).forEach(([x, y, w, h], i) => {
        const b = document.createElement("div");
        b.className = "mkbox" + (m.note ? " said" : "") + (om && om.id === m.id ? " on" : "");
        // only the first box carries the id, so a multi-line mark gets one margin note
        if (i === 0) b.dataset.mark = m.id; else b.dataset.markPart = m.id;
        b.style.left = (x * 100) + "%"; b.style.top = (y * 100) + "%";
        b.style.width = (w * 100) + "%"; b.style.height = (h * 100) + "%";
        // no click handler: the box takes no pointer events, so the reader hit-tests instead
        slide.appendChild(b);
      });
    }
  }

  // the open mark changing relights the boxes drawn, rather than drawing them all again
  function lightPdfMarks(id: string | null) {
    pdfHostRef.current?.querySelectorAll<HTMLElement>(".mkbox").forEach((b) => b.classList.toggle("on", !!id && (b.dataset.mark ?? b.dataset.markPart) === id));
  }

  function remember(bid: string, act: Act) {
    const u = undoOf(bid);
    u.past.push(act);
    if (u.past.length > 60) u.past.shift();
    u.future = [];
  }
  const selectionNow = () => pdfSelRef.current || liveSelRef.current || proseSelection(proseRef.current, docRef.current.maps, docRef.current.text);

  async function markSelection() {
    journey("highlight");
    const st = reader.live();
    const id = st.activeId, s = st.src;
    if (!id || !s || st.onHome || st.treeOpen) return;
    const sel = selectionNow() as (PdfRange | (ReturnType<typeof proseSelection> & { page?: number; rects?: number[][] })) | null;
    if (!sel) { toast("select a passage first"); return; }
    const payload = {
      resourceId: s.id, page: sel.page ?? null,
      // trimmed and capped as the server stores it, so the painted copy is not repainted
      start: sel.start, end: sel.end, quote: String(sel.quote).trim().slice(0, 4000), rects: sel.rects || [],
      ...((sel as LiveSelection).box ? { box: (sel as LiveSelection).box } : {}),
    } as MarkDraft;
    // read before the selection goes: an ask or a card hangs on the words as picked
    const at = pickedPlace(), own = liveSelRef.current?.own ?? null, menu = selMenuRef.current;
    // painted before it is saved, so the highlight never waits on a round trip
    const mid = newMarkId();
    const saving = markOps.create(id, { ...payload, id: mid });
    arrived("highlight");
    dropSelection();
    const act: Act = { type: "create", id: mid, payload };
    remember(id, act);
    if (menu) setChips({ id: mid, x: menu.x, y: menu.under, fresh: true, at, own });
    try { await saving; }
    catch (e) {
      // out of retries it may still have landed: re-read rather than make it twice
      markGaveUp(e as Failure, id, mid);
      const u = undoOf(id);
      u.past = u.past.filter((a) => a !== act);
      setOpenMark((o) => (o && o.id === mid ? null : o));
      setChips((c) => (c && c.id === mid ? null : c));
      toastWhy(e, "couldn't mark that");
    }
  }

  // prose snaps to whole words: a card's words are found again only as whole words
  function placeOf(sel: { start: number; end: number; quote: string; page?: number | null; rects?: readonly (readonly number[])[]; box?: string | null }, prose: boolean, block: number | null): Place | null {
    let { start, end } = sel, quote = String(sel.quote).trim();
    if (!quote) return null;
    if (prose) {
      const text = docRef.current.text, word = /[\p{L}\p{N}]/u;
      while (start > 0 && word.test(text[start - 1])) start--;
      while (end < text.length && word.test(text[end])) end++;
      quote = text.slice(start, end).trim();
    }
    return { start, end, quote: quote.slice(0, 4000), page: sel.page ?? null, rects: (sel.rects || []).map((r) => [...r]), box: sel.box ?? null, block };
  }
  // the words picked now, as a place a card or a question can hang on
  function pickedPlace(): Place | null {
    const sel = selectionNow() as (PdfRange | (ReturnType<typeof proseSelection> & { page?: number; rects?: number[][] })) | null;
    if (!sel) return null;
    const prose = !pdfSelRef.current && !liveSelRef.current;
    const pick = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).startContainer : null;
    return placeOf(sel, prose, prose ? blockOf(pick) : null);
  }
  // a mark made earlier, as the same place: its block is where its words are painted
  function markPlace(m: Mark): Place | null {
    const kind = drawnAs(reader.live().src?.kind || ""), prose = kind !== "pdf" && kind !== "html";
    return placeOf(m, prose, prose ? blockOf(proseRef.current?.querySelector(`[data-mark="${CSS.escape(m.id)}"]`) ?? null) : null);
  }
  function blockOf(at: Node | null): number | null {
    const b = (at?.nodeType === 3 ? at.parentElement : at as Element | null)?.closest<HTMLElement>("[data-b]");
    return b ? Number(b.dataset.b) : null;
  }
  function dropSelection() {
    window.getSelection()?.removeAllRanges();
    if (liveSelRef.current) { liveSelRef.current = null; reader.clearLive?.(); }
    pdfSelRef.current = null; setSelMenu(null);
  }

  // the question is asked in the fold under these words; the ask is made with its first question
  function askAt(at: Place) {
    const st = reader.live();
    if (!st.activeId || !st.src || st.onHome || st.treeOpen) return;
    asking.set({ id: newAskId(), resourceId: st.src.id, ...at });
    StrataAPI.log("ask_selection", { board: st.activeId, chars: at.quote.length });
  }

  // the card is written in the fold under these words; nothing is saved until it is kept
  function cardAt(at: Place, own: string | null) {
    const st = reader.live();
    if (!st.activeId || !st.src || st.onHome || st.treeOpen) return;
    const kind = drawnAs(st.src.kind);
    // a card sits on its words: too few, or words that occur elsewhere too, grow until they are its alone
    const text = kind === "pdf" ? (at.page ? reader.pageIndex(at.page)?.text ?? null : null) : kind !== "html" ? docRef.current.text : null;
    const quote = text ? widenQuote(text, at.start, at.end)?.quote ?? null : kind === "html" && !at.box ? own : at.quote;
    if (!quote) { toast("these words don't make a place of their own: pick a passage of at most 40 words that occurs once"); return; }
    openFoldCard({ ...at, resourceId: st.src.id, quote }, st.src.kind);
  }

  // a live page's own words for a card are known only while picked, so a mark made there earlier offers no card
  const offerOf = (c: Chips): ChipOffer => {
    const live = drawnAs(reader.live().src?.kind || "") === "html";
    return { note: true, ask: !notesOnly, card: !notesOnly && (!live || c.fresh || !!markNow(c.id)?.box), remove: !c.fresh };
  };
  function chipAct(act: ChipAct, prefill = "") {
    const c = chips;
    if (!c) return;
    setChips(null);
    const m = markNow(c.id);
    if (act === "remove") { void dropMark(c.id); return; }
    if (act === "note") { setOpenMark({ id: c.id, draft: m?.note || "", ...(prefill && !m?.note ? { prefill } : {}) }); return; }
    const at = c.at ?? (m ? markPlace(m) : null);
    if (!at) return;
    if (act === "ask") askAt(at); else cardAt(at, c.own);
  }
  // a mark tapped again: its chips under the line that was tapped, unzoomed like the menu
  function offerMark(id: string, line: { left: number; width: number; bottom: number } | null, x?: number) {
    if (!line || !pageRef.current) return;
    const z = zoomOf(pageRef.current) || 1;
    const cx = x == null ? line.left + line.width / 2 : Math.min(Math.max(x, line.left), line.left + line.width);
    setSelMenu(null);
    setChips({ id, x: cx / z, y: line.bottom / z, fresh: false, at: null, own: null });
  }
  const dropChips = () => setChips(null);

  // a mark act out of retries would block its lane: give the lane up and re-read
  function markGaveUp(e: Failure, bid: string, mid: string) {
    if (!e || !e.retryable) return;
    markOps.abandon(mid);
    reader.reread(bid);
  }

  async function saveNote(mid: string, text: string) {
    const id = reader.live().activeId; if (!id || !mid) return;
    const before = (markNow(mid) || {} as Partial<Mark>).note || "";
    const after = text.trim() ? text : null;
    try {
      await markOps.note(id, mid, after);
      remember(id, { type: "note", id: mid, before: before || null, after });
    } catch (e) {
      markGaveUp(e, id, mid);
      // a note written offline over one changed elsewhere is listed by the offline banner instead
      if (!(e as { clashed?: boolean } | null)?.clashed) toastWhy(e, "couldn't save that note");
    }
  }
  async function replyNote(mid: string, text: string) {
    const id = reader.live().activeId; if (!id || !mid || !text.trim()) return;
    try { await markOps.reply(id, mid, text); }
    catch (e) { markGaveUp(e, id, mid); toastWhy(e, "couldn't send that reply"); }
  }
  async function dropMark(mid: string) {
    const id = reader.live().activeId; if (!id || !mid) return;
    const m = markNow(mid);
    setOpenMark(null);
    try {
      await markOps.remove(id, mid);
      if (m) remember(id, { type: "delete", id: mid, payload: { resourceId: m.resourceId, page: m.page ?? null, start: m.start, end: m.end, quote: m.quote, note: m.note || null, rects: m.rects || [] } as MarkDraft });
      toast("mark removed — ⌘Z puts it back");
    } catch (e) { markGaveUp(e, id, mid); toastWhy(e, "couldn't remove that"); }
  }

  // every step goes through the mark's lane, so quick presses reach the server in order
  async function stepHistory(back: boolean) {
    const id = reader.live().activeId; if (!id) return;
    const u = undoOf(id);
    const from = back ? u.past : u.future, to = back ? u.future : u.past;
    const act = from.pop();
    if (!act) { toast(back ? "nothing to undo" : "nothing to redo"); return; }
    const undoing = back;
    try {
      if (act.type === "note") {
        const want = undoing ? act.before : act.after;
        await markOps.note(id, act.id, want);
        toast(undoing ? (act.before ? "note put back" : "note cleared") : "note redone");
      } else {
        // create-undone and delete-redone are the same move; so are the other two
        const removing = act.type === "create" ? undoing : !undoing;
        if (removing) {
          setOpenMark(null);
          await markOps.remove(id, act.id, undoing);
          toast(undoing ? "mark undone" : "mark removed");
        } else {
          act.id = act.id || newMarkId();
          await markOps.create(id, { ...act.payload, id: act.id });
          toast(undoing ? "mark put back" : "mark redone");
        }
      }
      to.push(act);
    } catch (e) {
      // the row is already gone: drop the step rather than wedge the stack
      markGaveUp(e, id, act.id);
      toastWhy(e, "couldn't undo that");
    }
  }

  // one listener on the scroller: the spans are rebuilt on every repaint
  function onReaderClick(e: { target: EventTarget | null; clientX: number; clientY: number }) {
    const t = e.target as Element | null;
    // the menu's own clicks land here too; do not read them as a click elsewhere
    if (t && t.closest && t.closest(".selmenu, .markchips")) return;
    // a live selection means this was a drag, so the menu owns it
    // PDF boxes are hit-tested by rect: elementsFromPoint skips pointer-events:none
    const live = window.getSelection();
    if (live && !live.isCollapsed && live.toString().trim()) return;
    let hit: { dataset: DOMStringMap; line?: DOMRect } | null = t && t.closest ? t.closest<HTMLElement>("[data-mark]") : null;
    const slide = !hit && t && t.closest ? t.closest(".slide") : null;
    if (slide) {
      for (const b of slide.querySelectorAll<HTMLElement>(".mkbox")) {
        const r = b.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          hit = { dataset: { mark: b.dataset.mark || b.dataset.markPart }, line: r };
          break;
        }
      }
    }
    if (hit && hit.dataset.mark) {
      const mid = hit.dataset.mark;
      const m = markNow(mid);
      // a said note on prose opens from its words to be read, in the fold; only a bare highlight offers its chips
      if (!slide && m && m.note) return;
      if (m && m.note) { setOpenMark((cur) => (cur && cur.id === mid ? cur : { id: mid, draft: m.note || "" })); return; }
      if (openMarkRef.current?.id === mid) return;
      const rects = hit.line ? [hit.line] : [...(hit as HTMLElement).getClientRects()];
      const line = rects.find((r) => e.clientY >= r.top && e.clientY <= r.bottom) || rects[rects.length - 1] || null;
      offerMark(mid, line, e.clientX);
      return;
    }
    if (t && t.closest && t.closest(".fold, .ftick")) return;
    setOpenMark(null);
  }

  // placed in unzoomed coordinates: the menu is fixed inside a zoomed subtree
  function onReaderUp() {
    const st = reader.live();
    if (st.onHome || !st.src || st.treeOpen) { pdfSelRef.current = null; setSelMenu(null); return; }
    const sel = st.src.kind === "pdf" ? pdfSelection(reader.pageIndex) : proseSelection(proseRef.current, docRef.current.maps, docRef.current.text);
    pdfSelRef.current = st.src.kind === "pdf" ? sel as PdfRange | null : null;
    if (!sel) { setSelMenu(null); return; }
    const live = window.getSelection();
    if (!live || !live.rangeCount) { setSelMenu(null); return; }
    const r = live.getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { setSelMenu(null); return; }
    const z = zoomOf(pageRef.current) || 1;
    // never above the reader: a drag past the edge may have scrolled the start out of view
    const R = (pageRef.current as HTMLElement).getBoundingClientRect();
    setSelMenu({ x: (r.left + r.width / 2) / z, y: Math.min(Math.max(r.top, R.top + 44), R.bottom) / z, under: Math.min(Math.max(r.bottom, R.top), R.bottom - 44) / z });
  }

  // the release can land anywhere, so the reader notes the press and the document hears the release
  const pressedInReader = useRef(false);
  const readerUpRef = useRef(onReaderUp);
  readerUpRef.current = onReaderUp;
  useEffect(() => {
    const up = () => {
      if (!pressedInReader.current) return;
      pressedInReader.current = false;
      readerUpRef.current();
    };
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);

  // a page nearby drawing nudges the scroll (NUDGE_PX); that must not close the menu
  useEffect(() => {
    if (!selMenu) return;
    const sc = pageRef.current;
    const off = () => setSelMenu(null);
    const onDown = (e: Event) => { const t = e.target as Element | null; if (!(t && t.closest && t.closest(".selmenu"))) off(); };
    const from = sc ? sc.scrollTop : 0;
    const onScroll = () => { if (sc && Math.abs(sc.scrollTop - from) >= NUDGE_PX) off(); };
    const onKey = (e: KeyboardEvent) => {
      if (isMarkKey(e) && !typing(e.target)) { e.preventDefault(); e.stopPropagation(); void markSelection(); return; }
      off();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    if (sc) sc.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", off);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      if (sc) sc.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", off);
    };
  }, [selMenu, pairIdx]);

  // the chips go on a press elsewhere, a scroll, a resize or a key that isn't theirs; the mark stays
  useEffect(() => {
    if (!chips) return;
    const sc = pageRef.current;
    const off = () => setChips(null);
    const onDown = (e: Event) => { const t = e.target as Element | null; if (!(t && t.closest && t.closest(".markchips"))) off(); };
    const from = sc ? sc.scrollTop : 0;
    const onScroll = () => { if (sc && Math.abs(sc.scrollTop - from) >= NUDGE_PX) off(); };
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) { off(); return; }
      const k = chipKey(e, offerOf(chips));
      if (!k) return;
      if ("drop" in k) { off(); if (!k.pass) { e.preventDefault(); e.stopPropagation(); } return; }
      e.preventDefault(); e.stopPropagation();
      chipAct(k.act, k.prefill);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    if (sc) sc.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", off);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      if (sc) sc.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", off);
    };
  }, [chips]);
  useEffect(() => { setChips(null); }, [pairIdx]);

  // touch has no mouseup: follow selectionchange, debounced while the handles move
  useEffect(() => {
    if (!TOUCH) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onSel = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.toString().trim()) { setSelMenu(null); return; }
        let n: Node | null = sel.anchorNode; if (n && n.nodeType === 3) n = n.parentElement;
        if (!n || !pageRef.current || !pageRef.current.contains(n)) return;
        onReaderUp();
      }, 320);
    };
    document.addEventListener("selectionchange", onSel);
    return () => { clearTimeout(t); document.removeEventListener("selectionchange", onSel); };
  }, [loading]);

  const onReaderDown = () => { pressedInReader.current = true; };

  function offerLive(sel: LiveSelection | null, at: { left: number; top: number; width: number; height?: number } | null) {
    liveSelRef.current = sel;
    if (!sel || !at || !pageRef.current) { setSelMenu(null); return; }
    const z = zoomOf(pageRef.current) || 1;
    const R = pageRef.current.getBoundingClientRect();
    const bottom = at.top + (at.height ?? 0);
    setSelMenu({ x: (at.left + at.width / 2) / z, y: Math.min(Math.max(at.top, R.top + 44), R.bottom) / z, under: Math.min(Math.max(bottom, R.top), R.bottom - 44) / z });
  }

  return {
    selMenu, chips, chipOffer: chips ? offerOf(chips) : null, chipAct, openMark, setOpenMark, openMarkRef,
    paintPdfMarks, lightPdfMarks,
    markSelection, stepHistory,
    onReaderDown, onReaderClick, offerLive, offerMark, dropChips, saveNote, replyNote, dropMark,
  };
}
