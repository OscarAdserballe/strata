import { ensureFoldStyle } from "../../engines/fold/view.ts";
import type { LayerItem } from "../../engines/fold/layers.ts";
import { anchorOf, quoteAnchor } from "../../../shared/reading/anchors.ts";
import type { FoldPlace } from "../card/composing.ts";
import type { SourceAdapter } from "../../engines/source/adapter.ts";
import { switches } from "./switches.ts";
import { asking } from "./asking.ts";

export interface FoldMark {
  id: string; quote: string; start: number; end: number; box?: string | null; note?: string | null;
  page?: number | null; rects?: readonly (readonly number[])[];
  replies?: readonly { author: "you" | "agent"; text: string }[];
}
/** A card of the deck in hand, as its fold shows it. */
export interface FoldDeckCard {
  id: string; q: string; where: string;
  /** the card's quote and the page it compiled to; a card placed by anything else sits nowhere on the page */
  at: { quote: string; page: number | null } | null;
  /** the reader draws its face into a slot; a live page can't */
  face: boolean;
  /** the card in hand */
  held: boolean;
  /** the answer as text, for a page with no slot */
  a: string;
  state: "asking" | "revealed" | "done"; got: boolean | null; mcq: boolean;
}
/** A conversation at words on the open source, as its fold shows it. */
export interface FoldAskAt {
  id: string; quote: string; start: number; end: number; page: number | null; rects: number[][]; box: string | null; block: number | null;
  turns: { who: "you" | "claude"; text: string }[]; writing: string | null; error: string; again: string; rich: boolean;
}
export interface FoldHost {
  asks(): readonly FoldAskAt[];
  ask(id: string, text: string): void;
  capture(id: string, turn: number): void;
  cards(): readonly FoldDeckCard[];
  show(id: string): void;
  later(id: string): void;
  grade(id: string, got: boolean): void;
  /** the card being written under a selection of this source, if one is */
  draft(): FoldPlace | null;
  keep(front: string, back: string): void;
  discard(): void;
  adapter(): SourceAdapter | null;
  marks(): readonly FoldMark[];
  /** the mark whose note is open for writing, with or without a note yet */
  writing(): string | null;
  write(id: string | null): void;
  save(id: string, text: string): void;
  remove(id: string): void;
  reply(id: string, text: string): void;
  /** the sheets were drawn again: the reader finds the slots it draws faces and answers into */
  drawn(): void;
}

const said = (m: FoldMark) => !!(m.note && m.note.trim());

/** The layers of the open source, handed to its adapter: which are shown is decided here, where they go is the adapter's. */
export function paintFolds(h: FoldHost): void {
  const a = h.adapter();
  if (!a) return;
  ensureFoldStyle(document);
  const writing = h.writing(), notes = switches.on("notes"), cards = switches.on("cards");
  const all = h.marks();
  switches.count("notes", all.filter(said).length);
  const items: LayerItem[] = all.filter((m) => m.id === writing || (notes && said(m))).map((m) => ({
    id: m.id, kind: "note", quote: m.quote, text: m.note || "", editing: m.id === writing,
    replies: (m.replies ?? []).map((r) => ({ who: r.author, text: r.text })),
    anchor: { start: m.start, end: m.end, quote: m.quote, box: m.box ?? null, page: m.page ?? null, rects: m.rects ?? [] },
  }));
  if (cards) for (const c of h.cards()) {
    if (!c.at) continue;
    items.push({ kind: "card", id: c.id, q: c.q, where: c.where, face: c.face, held: c.held, a: c.a, state: c.state, got: c.got, mcq: c.mcq,
      anchor: { start: 0, end: 0, quote: c.at.quote, page: c.at.page } });
  }
  const asks = h.asks();
  switches.count("ask", asks.filter((x) => x.turns.length).length);
  const askOn = switches.on("ask");
  for (const x of asks) {
    // one being asked or answered shows even with the layer off: you just asked it
    if (!askOn && x.turns.length && x.writing === null) continue;
    items.push({ kind: "ask", id: x.id, quote: x.quote, turns: x.turns, writing: x.writing, error: x.error, again: x.again, rich: x.rich,
      anchor: { start: x.start, end: x.end, quote: x.quote, box: x.box, page: x.page, rects: x.rects, block: x.block,
        legacy: anchorOf({ source: quoteAnchor(x.quote) }) } });
  }
  const d = h.draft();
  if (d) items.push({ kind: "draft", id: "draft", quote: d.quote,
    anchor: { start: d.start, end: d.end, quote: d.quote, box: d.box, page: d.page, rects: d.rects, block: d.block ?? null, legacy: anchorOf({ source: quoteAnchor(d.quote) }) } });
  a.drawLayers(items, {
    edit: (id) => h.write(id),
    leave: (id, text) => h.save(id, text),
    remove: (id) => h.remove(id),
    reply: (id, text) => h.reply(id, text),
    show: (id) => h.show(id),
    later: (id) => h.later(id),
    grade: (id, got) => h.grade(id, got),
    keep: (_id, front, back) => h.keep(front, back),
    discard: (id) => { if (asking.now()?.id === id) asking.set(null); else h.discard(); },
    ask: (id, text) => h.ask(id, text),
    capture: (id, turn) => h.capture(id, turn),
    drawn: () => h.drawn(),
  });
}
