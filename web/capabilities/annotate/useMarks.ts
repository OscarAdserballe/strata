import { useEffect, useRef, useState } from "react";
import { widenQuote } from "../../../shared/reading/compile-quote.ts";
import type { MutableRefObject } from "react";
import type { Mark } from "../../../shared/types/index.ts";
import { StrataAPI, StrataWireDown } from "../../data/api.ts";
import { store as roomStore } from "../../data/store.ts";
import { marksKey } from "../../data/entities/boards.ts";
import { marks as markOps, newMarkId, type MarkDraft } from "../../data/entities/marks.ts";
import { proseSelection, type ProseMaps } from "../../engines/prose/offsets.ts";
import { zoomOf } from "../../engines/zoom/zoom.ts";
import { NUDGE_PX } from "../../engines/pdf/window.ts";
import { TOUCH } from "../../platform/device.js";
import { begin as journey, end as arrived } from "../../platform/rum.ts";
import { asking, newAskId } from "../fold/asking.ts";
import { openFoldCard } from "../card/doors.ts";
import { typing } from "../keys/registry.ts";
import { chipKey } from "./chips.ts";
import { pdfSelection, type PageTextIndex, type PdfRange } from "./selection.ts";

type Ref<T> = MutableRefObject<T>;
export interface MarkSource { id: string; kind: string }
export interface OpenMark { id: string; draft: string }
/** `below` is the words' bottom edge; `live` is a selection made in a live page's frame */
export interface SelMenu { x: number; y: number; below: number; live?: boolean }
/** The chips under a mark: `fresh` is a mark just made, which ⌘Z takes back rather than ✕ */
export interface MarkChips { id: string; x: number; y: number; fresh: boolean }
type Place = { start: number; end: number; quote: string; page: number | null; rects: number[][]; box: string | null; block: number | null };

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

export function useMarks(reader: MarksReader, { pairIdx, loading }: { pairIdx: number; loading: boolean }) {
  const { pageRef, proseRef, pdfHostRef, docRef } = reader;
  const [selMenu, setSelMenu] = useState<SelMenu | null>(null);
  const [chips, setChips] = useState<MarkChips | null>(null);
  // a key can press Mark before the menu's render has run
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

  function markSelection(withNote: boolean): string | null {
    journey("highlight");
    const st = reader.live();
    const id = st.activeId, s = st.src;
    if (!id || !s || st.onHome || st.treeOpen) return null;
    // the ref, not the render-time snapshot: the menu can be clicked before a re-render
    if (StrataWireDown()) { toast("offline — marks need the wire (read only)"); return null; }
    const sel = selectionNow() as (PdfRange | (ReturnType<typeof proseSelection> & { page?: number; rects?: number[][] })) | null;
    if (!sel) { toast("select a passage first"); return null; }
    const payload = {
      resourceId: s.id, page: sel.page ?? null,
      // trimmed and capped as the server stores it, so the painted copy is not repainted
      start: sel.start, end: sel.end, quote: String(sel.quote).trim().slice(0, 4000), rects: sel.rects || [],
      ...((sel as LiveSelection).box ? { box: (sel as LiveSelection).box } : {}),
    } as MarkDraft;
    // painted before it is saved, so the highlight never waits on a round trip
    const mid = newMarkId();
    const saving = markOps.create(id, { ...payload, id: mid });
    arrived("highlight");
    window.getSelection()?.removeAllRanges();
    if (liveSelRef.current) { liveSelRef.current = null; reader.clearLive?.(); }
    pdfSelRef.current = null; setSelMenu(null);
    const act: Act = { type: "create", id: mid, payload };
    remember(id, act);
    if (withNote) setOpenMark({ id: mid, draft: "" });
    saving.catch((e) => {
      // out of retries it may still have landed: re-read rather than make it twice
      markGaveUp(e as Failure, id, mid);
      const u = undoOf(id);
      u.past = u.past.filter((a) => a !== act);
      setOpenMark((o) => (o && o.id === mid ? null : o));
      setChips((c) => (c && c.id === mid ? null : c));
      toastWhy(e, "couldn't mark that");
    });
    return mid;
  }

  // a live page's frame keeps the keys, so there Mark opens the note at once, as Note did
  function markHere() {
    const at = selMenuRef.current, live = !!liveSelRef.current;
    const mid = markSelection(live);
    if (mid && !live && at) setChips({ id: mid, x: at.x, y: at.below, fresh: true });
  }

  // words as a place a card or a question can hang on; prose snaps to whole words
  function placeOf(sel: { start: number; end: number; quote: string; page?: number | null; rects?: readonly (readonly number[])[]; box?: string | null },
    prose: boolean, at: Node | null): Place | null {
    if (!sel.quote.trim()) return null;
    let { start, end } = sel, quote = String(sel.quote).trim(), block: number | null = null;
    if (prose) {
      // a card's words are found again only as whole words
      const text = docRef.current.text, word = /[\p{L}\p{N}]/u;
      while (start > 0 && word.test(text[start - 1])) start--;
      while (end < text.length && word.test(text[end])) end++;
      quote = text.slice(start, end).trim();
      const b = (at?.nodeType === 3 ? at.parentElement : at as Element | null)?.closest<HTMLElement>("[data-b]");
      block = b ? Number(b.dataset.b) : null;
    }
    return { start, end, quote: quote.slice(0, 4000), page: sel.page ?? null, rects: (sel.rects || []) as number[][], box: sel.box ?? null, block };
  }
  function pickedPlace(): Place | null {
    const sel = selectionNow() as (PdfRange | (ReturnType<typeof proseSelection> & { page?: number; rects?: number[][] })) | null;
    if (!sel) return null;
    const at = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).startContainer : null;
    return placeOf(sel as Parameters<typeof placeOf>[0], !pdfSelRef.current && !liveSelRef.current, at);
  }
  function markPlace(m: Mark): Place | null {
    const pdf = reader.live().src?.kind === "pdf";
    return placeOf(m, !pdf && !m.box, pdf ? null : proseRef.current?.querySelector(`[data-mark="${CSS.escape(m.id)}"]`) ?? null);
  }
  function dropSelection() {
    window.getSelection()?.removeAllRanges();
    if (liveSelRef.current) { liveSelRef.current = null; reader.clearLive?.(); }
    pdfSelRef.current = null; setSelMenu(null);
  }

  // the question is asked in the fold under these words; the ask is made with its first question
  function askAt(at: Place | null): boolean {
    const st = reader.live();
    if (!st.activeId || !st.src || st.onHome || st.treeOpen) return false;
    if (!at) { toast("select a passage first"); return false; }
    asking.set({ id: newAskId(), resourceId: st.src.id, ...at });
    StrataAPI.log("ask_selection", { board: st.activeId, chars: at.quote.length });
    return true;
  }
  function askSelection() { if (askAt(pickedPlace())) dropSelection(); }

  // the card is written in the fold under these words; nothing is saved until it is kept
  function cardAt(at: Place | null, text: string | null, liveOwn: string | null): boolean {
    const st = reader.live();
    if (!st.activeId || !st.src || st.onHome || st.treeOpen) return false;
    if (!at) { toast("select a passage first"); return false; }
    // a card sits on its words: too few, or words that occur elsewhere too, grow until they are its alone
    const own = text ? widenQuote(text, at.start, at.end) : null;
    const quote = text ? own?.quote ?? null : liveOwn !== null ? liveOwn : at.quote;
    if (!quote) { toast("these words don't make a place of their own: pick a passage of at most 40 words that occurs once"); return false; }
    openFoldCard({ resourceId: st.src.id, ...at, quote }, st.src.kind);
    return true;
  }
  function cardSelection() {
    const at = pickedPlace();
    const text = pdfSelRef.current && at?.page ? reader.pageIndex(at.page)?.text ?? null : !liveSelRef.current ? docRef.current.text : null;
    const live = liveSelRef.current && at && !at.box ? liveSelRef.current : null;
    if (cardAt(at, text, live ? live.own ?? "" : null)) dropSelection();
  }

  // what a chip under a mark does; a letter typed over the chips starts its note
  function noteMark(mid: string, typed = "") {
    const m = markNow(mid);
    setChips(null);
    if (m) setOpenMark({ id: mid, draft: (m.note || "") + typed });
  }
  function askMark(mid: string) {
    const m = markNow(mid);
    setChips(null);
    if (m) askAt(markPlace(m));
  }
  function cardMark(mid: string) {
    const m = markNow(mid);
    setChips(null);
    if (!m) return;
    const text = reader.live().src?.kind === "pdf" ? (m.page ? reader.pageIndex(m.page)?.text ?? null : null) : m.box ? null : docRef.current.text;
    cardAt(markPlace(m), text, null);
  }
  function removeMark(mid: string) { setChips(null); void dropMark(mid); }

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
    } catch (e) { markGaveUp(e, id, mid); toastWhy(e, "couldn't save that note"); }
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
          setChips((c) => (c && c.id === act.id ? null : c));
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
    if (t && t.closest && t.closest(".selmenu")) return;
    // a live selection means this was a drag, so the menu owns it
    // PDF boxes are hit-tested by rect: elementsFromPoint skips pointer-events:none
    const live = window.getSelection();
    if (live && !live.isCollapsed && live.toString().trim()) return;
    let hit: { dataset: DOMStringMap } | null = t && t.closest ? t.closest<HTMLElement>("[data-mark]") : null;
    let hitBox: DOMRect | null = null;
    const slide = !hit && t && t.closest ? t.closest(".slide") : null;
    if (slide) {
      for (const b of slide.querySelectorAll<HTMLElement>(".mkbox")) {
        const r = b.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          hit = { dataset: { mark: b.dataset.mark || b.dataset.markPart } };
          hitBox = r;
          break;
        }
      }
    }
    if (hit && hit.dataset.mark) {
      const mid = hit.dataset.mark;
      const m = markNow(mid);
      // a said note on prose opens from its words to be read, in the fold; a bare highlight offers its chips
      if (!slide && m && m.note) return;
      if (m && m.note) { setOpenMark((cur) => (cur && cur.id === mid ? cur : { id: mid, draft: m.note || "" })); return; }
      const line = slide ? hitBox : (hit as HTMLElement).getBoundingClientRect();
      const z = zoomOf(pageRef.current) || 1;
      setOpenMark(null);
      setChips({ id: mid, x: e.clientX / z, y: (line ? line.bottom : e.clientY) / z, fresh: false });
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
    setSelMenu({ x: (r.left + r.width / 2) / z, y: Math.min(Math.max(r.top, R.top + 44), R.bottom) / z, below: Math.max(Math.min(r.bottom, R.bottom - 44), R.top) / z });
  }

  const markHereRef = useRef(markHere);
  markHereRef.current = markHere;

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
      if (e.key === "m" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); markHereRef.current(); return; }
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

  // the chips stay until a click, a scroll or Esc elsewhere; the highlight stays with them gone
  const chipActs = useRef({ noteMark, askMark, cardMark });
  chipActs.current = { noteMark, askMark, cardMark };
  useEffect(() => {
    if (!chips) return;
    const sc = pageRef.current, id = chips.id;
    const off = () => setChips(null);
    const onDown = (e: Event) => { const t = e.target as Element | null; if (!(t && t.closest && t.closest(".selmenu"))) off(); };
    const from = sc ? sc.scrollTop : 0;
    const onScroll = () => { if (sc && Math.abs(sc.scrollTop - from) >= NUDGE_PX) off(); };
    const onKey = (e: KeyboardEvent) => {
      const k = typing(e.target) ? null : chipKey(e);
      if (!k) return;
      e.preventDefault(); e.stopPropagation();
      const acts = chipActs.current;
      if (k.act === "drop") off();
      else if (k.act === "note") acts.noteMark(id, k.typed);
      else if (k.act === "ask") acts.askMark(id);
      else acts.cardMark(id);
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
  }, [chips, pairIdx]);
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

  function offerLive(sel: LiveSelection | null, at: { left: number; top: number; width: number } | null) {
    liveSelRef.current = sel;
    if (!sel || !at || !pageRef.current) { setSelMenu(null); return; }
    const z = zoomOf(pageRef.current) || 1;
    const R = pageRef.current.getBoundingClientRect();
    setSelMenu({ x: (at.left + at.width / 2) / z, y: Math.min(Math.max(at.top, R.top + 44), R.bottom) / z, below: at.top / z, live: true });
  }

  return {
    selMenu, chips, openMark, setOpenMark, openMarkRef,
    paintPdfMarks, lightPdfMarks,
    markHere, askSelection, cardSelection, noteMark, askMark, cardMark, removeMark, stepHistory,
    onReaderDown, onReaderClick, offerLive, saveNote, replyNote, dropMark,
  };
}
