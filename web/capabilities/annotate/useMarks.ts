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
import { pdfSelection, type PageTextIndex, type PdfRange } from "./selection.ts";

type Ref<T> = MutableRefObject<T>;
export interface MarkSource { id: string; kind: string }
export interface OpenMark { id: string; draft: string }
/** x at the words' middle, y over them, b under them */
export interface SelMenu { x: number; y: number; b: number }
/** words as a place a card or a question can hang on */
export interface Place { start: number; end: number; quote: string; page: number | null; rects: number[][]; box: string | null; block: number | null }
/** the chips under a mark: `held` is the key of a create not yet sent, `own` the words a card there would sit on */
export interface Chips { x: number; y: number; id: string; held: string | null; place: Place | null; own: string | null }

// long enough to pick a chip; Card or Ask inside it take the new mark back unsent
export const CHIPS_HOLD_MS = 15_000;
const plain = (e: KeyboardEvent) => !e.metaKey && !e.ctrlKey && !e.altKey;

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
  /** a page read for its notes alone: its chips offer Note only */
  notesOnly?: boolean;
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
  const selMenuRef = useRef(selMenu);
  selMenuRef.current = selMenu;
  const [chips, setChips] = useState<Chips | null>(null);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
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

  // painted at once and held while its chips are up, so Card or Ask can take it back unsent
  function markSelection() {
    journey("highlight");
    const st = reader.live();
    const id = st.activeId, s = st.src;
    if (!id || !s || st.onHome || st.treeOpen) return;
    // the ref, not the render-time snapshot: the menu can be clicked before a re-render
    if (StrataWireDown()) { toast("offline — marks need the wire (read only)"); return; }
    const sel = selectionNow() as (PdfRange | (ReturnType<typeof proseSelection> & { page?: number; rects?: number[][] })) | null;
    if (!sel) { toast("select a passage first"); return; }
    const payload = {
      resourceId: s.id, page: sel.page ?? null,
      // trimmed and capped as the server stores it, so the painted copy is not repainted
      start: sel.start, end: sel.end, quote: String(sel.quote).trim().slice(0, 4000), rects: sel.rects || [],
      ...((sel as LiveSelection).box ? { box: (sel as LiveSelection).box } : {}),
    } as MarkDraft;
    const place = pickedPlace();
    const own = place ? ownQuote(place, pdfSelRef.current ? "pdf" : liveSelRef.current ? "live" : "prose", liveSelRef.current?.own) : null;
    const mid = newMarkId();
    const { key, saving } = markOps.hold(id, { ...payload, id: mid }, CHIPS_HOLD_MS);
    arrived("highlight");
    const at = selMenuRef.current;
    dropSelection();
    if (at) setChips({ x: at.x, y: at.b, id: mid, held: key, place, own });
    const act: Act = { type: "create", id: mid, payload };
    remember(id, act);
    saving.catch((e: Failure) => {
      const u = undoOf(id);
      u.past = u.past.filter((a) => a !== act);
      if (e?.withdrawn) return;
      // out of retries it may still have landed: re-read rather than make it twice
      markGaveUp(e, id, mid);
      setOpenMark((o) => (o && o.id === mid ? null : o));
      setChips((c) => (c && c.id === mid ? null : c));
      toastWhy(e, "couldn't mark that");
    });
  }

  // a card's and a question's words are found again only as whole words
  function wholeWords(start: number, end: number) {
    const text = docRef.current.text, word = /[\p{L}\p{N}]/u;
    while (start > 0 && word.test(text[start - 1])) start--;
    while (end < text.length && word.test(text[end])) end++;
    return { start, end, quote: text.slice(start, end).trim() };
  }
  const blockOf = (n: Node | null | undefined) => {
    const b = (n?.nodeType === 3 ? n.parentElement : n as Element | null)?.closest<HTMLElement>("[data-b]");
    return b ? Number(b.dataset.b) : null;
  };

  // the words picked now, as a place a card or a question can hang on
  function pickedPlace(): Place | null {
    const sel = selectionNow() as (PdfRange | (ReturnType<typeof proseSelection> & { page?: number; rects?: number[][] })) | null;
    if (!sel || !sel.quote.trim()) return null;
    let { start, end } = sel, quote = String(sel.quote).trim(), block: number | null = null;
    if (!pdfSelRef.current && !liveSelRef.current) {
      ({ start, end, quote } = wholeWords(start, end));
      block = blockOf(window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0).startContainer : null);
    }
    return { start, end, quote: quote.slice(0, 4000), page: sel.page ?? null, rects: (sel.rects || []) as number[][], box: (sel as LiveSelection).box ?? null, block };
  }

  // a card sits on its words: too few, or words that occur elsewhere too, grow until they are its alone
  function ownQuote(at: Place, from: "pdf" | "live" | "prose", liveOwn?: string | null): string | null {
    if (from === "live") return at.box ? at.quote : liveOwn ?? null;
    const text = from === "pdf" ? (at.page ? reader.pageIndex(at.page)?.text ?? null : null) : docRef.current.text;
    return text ? widenQuote(text, at.start, at.end)?.quote ?? null : null;
  }

  // a mark already on the page, as the place its chips ask or card on
  function placeOfMark(m: Mark, from: "pdf" | "prose", el: Element | null): { place: Place; own: string | null } {
    let { start, end } = m, quote = String(m.quote).trim();
    if (from === "prose") ({ start, end, quote } = wholeWords(start, end));
    const place: Place = { start, end, quote: quote.slice(0, 4000), page: m.page ?? null, rects: (m.rects || []) as number[][], box: m.box ?? null,
      block: from === "prose" ? blockOf(el) : null };
    return { place, own: ownQuote(place, from) };
  }
  function dropSelection() {
    window.getSelection()?.removeAllRanges();
    if (liveSelRef.current) { liveSelRef.current = null; reader.clearLive?.(); }
    pdfSelRef.current = null; setSelMenu(null);
  }

  // the chips go; a mark they held is sent now rather than when its hold runs out
  function closeChips() {
    const c = chipsRef.current;
    if (c?.held) markOps.send(c.held);
    setChips(null);
  }

  // the mark's note opens in its sheet, starting with the letter typed if one was
  function chipNote(first = "") {
    const c = chipsRef.current; if (!c) return;
    closeChips();
    const m = markNow(c.id);
    setOpenMark({ id: c.id, draft: ((m && m.note) || "") + first });
  }

  // the question is asked in the fold under these words; the ask is made with its first question
  function chipAsk() {
    const st = reader.live(), c = chipsRef.current;
    if (!c || !st.activeId || !st.src || st.onHome || st.treeOpen) return;
    if (!c.place) { toast("select a passage first"); return; }
    if (c.held) markOps.takeBack(c.held);
    setChips(null);
    asking.set({ id: newAskId(), resourceId: st.src.id, ...c.place });
    StrataAPI.log("ask_selection", { board: st.activeId, chars: c.place.quote.length });
  }

  // the card is written in the fold under these words; nothing is saved until it is kept
  function chipCard() {
    const st = reader.live(), c = chipsRef.current;
    if (!c || !st.activeId || !st.src || st.onHome || st.treeOpen) return;
    if (!c.place) { toast("select a passage first"); return; }
    if (!c.own) { toast("these words don't make a place of their own: pick a passage of at most 40 words that occurs once"); return; }
    if (c.held) markOps.takeBack(c.held);
    setChips(null);
    openFoldCard({ resourceId: st.src.id, ...c.place, quote: c.own }, st.src.kind);
  }

  function chipRemove() {
    const c = chipsRef.current; if (!c) return;
    closeChips();
    void dropMark(c.id);
  }

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
    let hit: { dataset: DOMStringMap } | null = t && t.closest ? t.closest<HTMLElement>("[data-mark]") : null;
    const slide = !hit && t && t.closest ? t.closest(".slide") : null;
    if (slide) {
      for (const b of slide.querySelectorAll<HTMLElement>(".mkbox")) {
        const r = b.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          hit = { dataset: { mark: b.dataset.mark || b.dataset.markPart } };
          break;
        }
      }
    }
    if (hit && hit.dataset.mark) {
      const mid = hit.dataset.mark;
      const m = markNow(mid);
      // a said note on prose opens from its words to be read, in the fold; only a bare highlight opens to write
      if (!slide && m && m.note) return;
      const r = m && markBox(mid);
      if (!m || !r) { setOpenMark((cur) => (cur && cur.id === mid ? cur : { id: mid, draft: (m && m.note) || "" })); return; }
      const z = zoomOf(pageRef.current) || 1;
      const { place, own } = placeOfMark(m, slide ? "pdf" : "prose", t);
      setOpenMark(null);
      setChips({ x: (r.left + r.right) / 2 / z, y: r.bottom / z, id: mid, held: null, place, own });
      return;
    }
    if (t && t.closest && t.closest(".fold, .ftick")) return;
    setOpenMark(null);
  }

  // the box round every piece of a mark on the page, in screen pixels
  function markBox(mid: string): { left: number; right: number; bottom: number } | null {
    const at = CSS.escape(mid);
    let left = Infinity, right = -Infinity, bottom = -Infinity;
    for (const el of pageRef.current?.querySelectorAll(`[data-mark="${at}"], [data-mark-part="${at}"]`) ?? []) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      left = Math.min(left, r.left); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    }
    return left < right ? { left, right, bottom } : null;
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
    if (chipsRef.current) closeChips();
    setSelMenu({ x: (r.left + r.width / 2) / z, y: Math.min(Math.max(r.top, R.top + 44), R.bottom) / z, b: Math.max(Math.min(r.bottom, R.bottom - 44), R.top) / z });
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
    document.addEventListener("mousedown", onDown, true);
    if (sc) sc.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", off);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      if (sc) sc.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", off);
    };
  }, [selMenu, pairIdx]);

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

  function offerLive(sel: LiveSelection | null, at: { left: number; top: number; width: number; height: number } | null) {
    liveSelRef.current = sel;
    if (!sel || !at || !pageRef.current) { setSelMenu(null); return; }
    const z = zoomOf(pageRef.current) || 1;
    const R = pageRef.current.getBoundingClientRect();
    if (chipsRef.current) closeChips();
    setSelMenu({ x: (at.left + at.width / 2) / z, y: Math.min(Math.max(at.top, R.top + 44), R.bottom) / z,
      b: Math.max(Math.min(at.top + at.height, R.bottom - 44), R.top) / z });
  }

  // the latest verbs, for listeners bound once per menu
  const acts = useRef({ markSelection, closeChips, chipNote, chipAsk, chipCard });
  acts.current = { markSelection, closeChips, chipNote, chipAsk, chipCard };

  // M marks the words picked; any other key puts the menu away
  useEffect(() => {
    if (!selMenu) return;
    const onKey = (e: KeyboardEvent) => {
      const k = (e.key || "").toLowerCase();
      if (k === "m" && plain(e) && !typing(e.target)) { e.preventDefault(); e.stopPropagation(); acts.current.markSelection(); return; }
      setSelMenu(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [selMenu]);

  // the chips own the next key: N, A, C pick, any other letter starts the note, Esc drops them and keeps the mark
  useEffect(() => {
    if (!chips) return;
    const sc = pageRef.current;
    const off = () => acts.current.closeChips();
    const onDown = (e: Event) => { const t = e.target as Element | null; if (!(t && t.closest && t.closest(".markchips"))) off(); };
    const onKey = (e: KeyboardEvent) => {
      const k = (e.key || "").toLowerCase(), a = acts.current;
      const take = (fn: () => void) => { e.preventDefault(); e.stopPropagation(); fn(); };
      if (typing(e.target)) { off(); return; }
      if (k === "escape") return take(off);
      if (!plain(e)) { off(); return; }
      if (k === "n") return take(() => a.chipNote());
      if (k === "a" && !reader.notesOnly) return take(a.chipAsk);
      if (k === "c" && !reader.notesOnly) return take(a.chipCard);
      if (e.key.length === 1 && /\p{L}/u.test(e.key)) return take(() => a.chipNote(e.key));
      off();
    };
    const from = sc ? sc.scrollTop : 0;
    const onScroll = () => { if (sc && Math.abs(sc.scrollTop - from) >= NUDGE_PX) off(); };
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

  // a source left with its chips up keeps the mark they held
  useEffect(() => () => { const c = chipsRef.current; if (c?.held) markOps.send(c.held); }, []);
  useEffect(() => { if (chipsRef.current) acts.current.closeChips(); }, [pairIdx]);

  return {
    selMenu, chips, openMark, setOpenMark, openMarkRef,
    paintPdfMarks, lightPdfMarks,
    markSelection, chipNote, chipAsk, chipCard, chipRemove, closeChips, stepHistory,
    onReaderDown, onReaderClick, offerLive, saveNote, replyNote, dropMark,
  };
}
