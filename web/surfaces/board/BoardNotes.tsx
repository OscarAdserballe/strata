import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ChangeEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import { StrataAPI, StrataFromShelf, StrataWhy, StrataWireDown } from "../../data/api.ts";
import { srcOffsetAt } from "../../engines/prose/offsets.ts";
import { zoomOf } from "../../engines/zoom/zoom.ts";
import { mdRender } from "../../engines/prose/render.ts";
import { boardNotes, notesSave, useBoardNotes } from "./boardNotes.ts";

function NoteSavedMark({ onTheirs }: { onTheirs(): void }) {
  const notes = notesSave();
  const s = useSyncExternalStore(notes.subscribe, notes.getSnapshot);
  if (s.conflict) return <span className="saved" role="alert">changed elsewhere —{" "}
    <button className="seg" onClick={() => notes.keepMine()}>Keep mine</button>{" "}
    <button className="seg" onClick={onTheirs}>Use theirs</button></span>;
  return <span className="saved" title={s.error ? StrataWhy(s.error, "the log didn't save") : undefined}>
    {s.error ? "not saved" : s.saved ? "saved" : "…"}</span>;
}

// one mirror div for the page's lifetime; one per editor leaked a node into <body> on every mount
let mirror: HTMLDivElement | null = null;

export interface BoardNotesProps {
  current(): string | null;
  leftRef: RefObject<HTMLElement | null>;
  pageRef: RefObject<HTMLElement | null>;
  toast(msg: string, ms?: number): void;
  toastWhy(e: unknown, said: string): void;
  onBoardState(st: unknown): void;
  children?: ReactNode;
}

export default function BoardNotes({ current, leftRef, pageRef, toast, toastWhy, onBoardState, children }: BoardNotesProps) {
  const { text: notes, editing: editingNote } = useBoardNotes();
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const selRef = useRef<[number, number] | null>(null);
  const scrollRef = useRef<number | null>(null);

  const noteView = useMemo(
    () => (!editingNote && notes.trim() ? mdRender(notes, true) : { html: "", maps: [] }),
    [editingNote, notes]);

  // don't open the editor on a service-worker copy: typing would save stale notes over newer ones
  function liveNotesFirst() {
    const id = current(); if (!id) return;
    toast("this log is a saved copy — reading the live one first", 2400);
    StrataAPI.getBoard(id).then((st) => {
      if (current() !== id) return;
      if (StrataFromShelf(st)) { toast("the live log didn't come — this is still the saved copy", 3000); return; }
      boardNotes.seed(id, st);
      onBoardState(st);
    }).catch((e: unknown) => toastWhy(e, "couldn't read the live log"));
  }

  const noteScroller = (): HTMLElement | null => {
    let el = noteRef.current ? noteRef.current.parentElement : null;
    while (el && el !== document.body) {
      const o = getComputedStyle(el).overflowY;
      if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return leftRef.current || pageRef.current;
  };
  // measuring collapses the textarea for one layout, which clamps scrollTop; restore it if it moved up
  function sizeNote(el: HTMLTextAreaElement | null) {
    if (!el) return;
    const sc = noteScroller(), top = sc ? sc.scrollTop : 0;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
    if (sc && sc.scrollTop < top) sc.scrollTop = top;
  }

  // the box never scrolls itself, so measure the caret with a mirror and scroll the page
  function caretTop(el: HTMLTextAreaElement) {
    const m = mirror ??= document.body.appendChild(document.createElement("div"));
    const cs = getComputedStyle(el);
    m.style.cssText = "position:absolute;visibility:hidden;left:-9999px;top:0;padding:0;border:0;"
      + "white-space:pre-wrap;overflow-wrap:break-word;"
      + `width:${el.clientWidth}px;font-family:${cs.fontFamily};font-size:${cs.fontSize};`
      + `font-weight:${cs.fontWeight};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};tab-size:${cs.tabSize};`;
    m.textContent = el.value.slice(0, el.selectionStart);
    const mark = document.createElement("span");
    mark.textContent = "​";
    m.appendChild(mark);
    return mark.offsetTop;
  }
  function revealCaret(el: HTMLTextAreaElement | null) {
    const sc = noteScroller(); if (!el || !sc) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const pad = 96;
    const z = zoomOf(sc);                  // rects are painted px, scrollTop/offsetTop are layout px
    const y = (el.getBoundingClientRect().top - sc.getBoundingClientRect().top) / z + sc.scrollTop + caretTop(el);
    if (y + line + pad > sc.scrollTop + sc.clientHeight) sc.scrollTop = y + line + pad - sc.clientHeight;
    else if (y < sc.scrollTop + 24) sc.scrollTop = Math.max(0, y - 24);
  }

  // swapping views changes height and clamps the scroller; restore the position after sizing
  const keepScroll = () => { const sc = noteScroller(); scrollRef.current = sc ? sc.scrollTop : null; };

  // focus without scrolling: the box is taller than the window and would jump to its top
  const flipped = useRef(false);
  useLayoutEffect(() => {
    if (!flipped.current) { flipped.current = true; return; }
    const el = editingNote ? noteRef.current : null;
    if (el) {
      sizeNote(el);
      el.focus({ preventScroll: true });
      const c = caretRef.current; caretRef.current = null;
      if (c != null) { const p = Math.max(0, Math.min(c, el.value.length)); el.setSelectionRange(p, p); }
    }
    const sc = noteScroller(), was = scrollRef.current; scrollRef.current = null;
    if (sc && was != null) sc.scrollTop = was;
    if (el) revealCaret(el);
  }, [editingNote]);

  useLayoutEffect(() => {
    const s = selRef.current; if (!s) return; selRef.current = null;
    const el = noteRef.current; if (!el) return;
    el.setSelectionRange(s[0], s[1]); sizeNote(el); revealCaret(el);
  }, [notes]);

  function openNoteAt(e: MouseEvent) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;                 // a text selection, not a click to edit
    if (StrataWireDown()) { toast("offline — the log needs the wire (read only)"); return; }
    if (notesSave().stale) { liveNotesFirst(); return; }
    caretRef.current = srcOffsetAt(e, noteView.maps, notes.length);
    keepScroll();
    boardNotes.setEditing(true);
  }

  function noteKeys(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget, v = el.value, s = el.selectionStart, t = el.selectionEnd;
    const apply = (text: string, a: number, b?: number) => { e.preventDefault(); selRef.current = [a, b == null ? a : b]; boardNotes.edit(text); };
    const lineStart = v.lastIndexOf("\n", s - 1) + 1;

    if (e.key === "Escape") { e.preventDefault(); el.blur(); return; }

    if (e.key === "Tab") {
      const head = v.slice(0, lineStart), sel = v.slice(lineStart, t), tail = v.slice(t);
      if (e.shiftKey) {
        let first = 0, all = 0;
        const out = sel.split("\n").map((l, i) => {
          const m = l.match(/^ {1,2}/); if (!m) return l;
          all += m[0].length; if (!i) first = m[0].length;
          return l.slice(m[0].length);
        }).join("\n");
        return apply(head + out + tail, Math.max(lineStart, s - first), Math.max(lineStart, t - all));
      }
      const eol = v.indexOf("\n", s), inList = /^\s*([-*]|\d+\.)\s/.test(v.slice(lineStart, eol < 0 ? v.length : eol));
      if (s === t && !inList) return apply(v.slice(0, s) + "  " + v.slice(s), s + 2);
      const rows = sel.split("\n");
      return apply(head + rows.map((l) => "  " + l).join("\n") + tail, s + 2, t + 2 * rows.length);
    }

    if (e.key === "Enter" && !e.shiftKey && s === t) {
      const line = v.slice(lineStart, s);
      const m = line.match(/^(\s*)([-*]|\d+\.)(\s+)(.*)$/);
      if (m) {
        if (!m[4].trim()) return apply(v.slice(0, lineStart) + v.slice(s), lineStart);
        const mark = /^\d/.test(m[2]) ? (parseInt(m[2], 10) + 1) + "." : m[2];
        const ins = "\n" + m[1] + mark + m[3];
        return apply(v.slice(0, s) + ins + v.slice(t), s + ins.length);
      }
    }

    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "b" || e.key === "i")) {
      const w = e.key === "b" ? "**" : "*", sel = v.slice(s, t);
      if (!sel) return apply(v.slice(0, s) + w + w + v.slice(s), s + w.length);
      if (v.slice(s - w.length, s) === w && v.slice(t, t + w.length) === w)
        return apply(v.slice(0, s - w.length) + sel + v.slice(t + w.length), s - w.length, t - w.length);
      return apply(v.slice(0, s) + w + sel + w + v.slice(t), s + w.length, t + w.length);
    }
  }

  return (
    <>
      <div className="note-head">
        <span>the log</span>
        <NoteSavedMark onTheirs={() => boardNotes.set(notesSave().useTheirs())} />
      </div>
      {editingNote || !notes.trim()
        ? <textarea className="note-edit prose" ref={noteRef} value={notes}
            onFocus={(e: FocusEvent<HTMLTextAreaElement>) => {
              if (StrataWireDown()) { toast("offline — the log needs the wire (read only)"); e.target.blur(); return; }
              if (notesSave().stale) { e.target.blur(); liveNotesFirst(); return; }
              boardNotes.setEditing(true);
            }}
            placeholder={"Write. Markdown works — # headings, **bold**, - lists.\n\nThis is the board’s running log: it lives here, on the desk."}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => { sizeNote(e.target); revealCaret(e.target); boardNotes.edit(e.target.value); }}
            onKeyDown={noteKeys}
            onBlur={() => { keepScroll(); boardNotes.setEditing(false); notesSave().flush(); }} />
        : <div className="prose note-read" title="click to write"
            onClick={openNoteAt}
            dangerouslySetInnerHTML={{ __html: noteView.html }} />}
      {children}
    </>
  );
}
