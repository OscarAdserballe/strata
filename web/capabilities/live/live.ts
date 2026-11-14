// A live HTML page and the reader's notes on it: the one wiring the room's reader and the dashboard both read pages through.
import { StrataAPI } from "../../data/api.ts";
import { pageState } from "../../data/entities/pagestate.ts";
import { HtmlEngine } from "../../engines/html/HtmlEngine.ts";
import { drawnAs } from "../../engines/html/drawn.ts";
import { marksOn, type LiveSelection, type OpenMark } from "../annotate/useMarks.ts";
import type { FoldHost } from "../fold/folds.ts";

/** The page open now: its board and source, read fresh on every call because the engine outlives renders. */
export interface LiveAt { bid: string | null; src: { id: string; kind: string; generation?: number } | null }

/** What of the reader's marks the page needs: its selections offered, a mark opened, and the notes' writes. */
export interface LiveMarks {
  offerLive(sel: LiveSelection | null, at: { left: number; top: number; width: number } | null): void;
  setOpenMark(m: OpenMark | null): void;
  openMarkRef: { current: OpenMark | null };
  saveNote(id: string, text: string): Promise<unknown> | unknown;
  replyNote(id: string, text: string): Promise<unknown> | unknown;
  dropMark(id: string): Promise<unknown> | unknown;
}

export const liveUrlOf = (at: LiveAt): string | null =>
  at.bid && at.src && drawnAs(at.src.kind) === "html" ? StrataAPI.resourceLiveUrl(at.bid, at.src.id, at.src.generation) : null;

/** The sandboxed page's engine, its selections and saved state routed to the source still open when they arrive. */
export function liveEngine(at: () => LiveAt, marks: () => LiveMarks | null, onHeight?: (h: number) => void): HtmlEngine {
  // the source whose frame asked, only while it is still the one open: a frame left over from the last source gets nothing
  const page = (url: string): { bid: string; rid: string } | null => {
    const a = at();
    return a.bid && a.src && url === liveUrlOf(a) ? { bid: a.bid, rid: a.src.id } : null;
  };
  return new HtmlEngine({
    onSelect: (sel, box) => marks()?.offerLive(sel, box),
    onMark: (id) => {
      const a = at(), m = marksOn(a.bid, a.src).find((x) => x.id === id);
      marks()?.setOpenMark({ id, draft: (m && m.note) || "" });
    },
    onPress: () => marks()?.offerLive(null, null),
    onLoad: (url) => { const p = page(url); return p ? pageState.load(p.bid, p.rid) : Promise.reject(new Error("the page was closed")); },
    onSave: (url, value) => { const p = page(url); return p ? pageState.save(p.bid, p.rid, value) : Promise.reject(new Error("the page was closed")); },
    onHeight,
  });
}

/** Hands the open page its marks, and which one is open. */
export function paintLiveMarks(engine: HtmlEngine, at: LiveAt, open: string | null | undefined): void {
  if (!at.src || drawnAs(at.src.kind) !== "html") return;
  engine.paint(marksOn(at.bid, at.src).map((m) => ({ id: m.id, start: m.start, end: m.end, quote: m.quote, note: !!m.note, box: m.box ?? null })), open ?? null);
}

/** The notes half of a fold host: the reader's marks on the open source, and writing, replying and removing them. */
export function noteFolds(at: () => LiveAt, marks: () => LiveMarks | null): Pick<FoldHost, "marks" | "writing" | "write" | "save" | "remove" | "reply"> {
  const on = () => { const a = at(); return marksOn(a.bid, a.src); };
  return {
    marks: on,
    writing: () => marks()?.openMarkRef.current?.id ?? null,
    write: (id) => {
      const m = id ? on().find((x) => x.id === id) : null;
      marks()?.setOpenMark(id ? { id, draft: (m && m.note) || "" } : null);
    },
    save: (id, text) => {
      const m = on().find((x) => x.id === id);
      if (m && text !== (m.note || "")) void marks()?.saveNote(id, text);
      marks()?.setOpenMark(null);
    },
    remove: (id) => void marks()?.dropMark(id),
    reply: (id, text) => void marks()?.replyNote(id, text),
  };
}

/** A fold host with no deck, no conversations and no card being written: a page read for its notes alone. */
export const NOTES_ONLY: Pick<FoldHost, "asks" | "ask" | "capture" | "cards" | "show" | "later" | "grade" | "draft" | "keep" | "discard"> = {
  asks: () => [], ask: () => {}, capture: () => {},
  cards: () => [], show: () => {}, later: () => {}, grade: () => {},
  draft: () => null, keep: () => {}, discard: () => {},
};
