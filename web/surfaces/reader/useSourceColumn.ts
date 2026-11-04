import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { StrataAPI, StrataSourceText } from "../../data/api.ts";
import { store as roomStore } from "../../data/store.ts";
import { marksKey } from "../../data/entities/boards.ts";
import { pageState } from "../../data/entities/pagestate.ts";
import { marksOn, useMarks } from "../../capabilities/annotate/useMarks.ts";
import { PdfEngine } from "../../engines/pdf/PdfEngine.ts";
import { HtmlEngine } from "../../engines/html/HtmlEngine.ts";
import { drawnAs } from "../../engines/html/drawn.ts";
import { mdRender } from "../../engines/prose/render.ts";
import { paintProseMarks, reconcileProseMarks } from "../../engines/prose/paint.ts";
import { claimsIn } from "../../engines/tree/claims.ts";
import { litClaims as litBands, paintClaims as paintBands } from "../../engines/tree/claimBands.ts";
import { sourceAdapters } from "../../engines/source/adapter.ts";
import { paintFolds } from "../../capabilities/fold/folds.ts";
import { switches } from "../../capabilities/fold/switches.ts";
import { PZ_STEPS, ROOM, readPz } from "../../engines/zoom/zoom.ts";
import { pageTop } from "../../engines/pdf/landing.ts";
import { glideTo, landOnPageNow, restoreScroll } from "../../engines/position/scroll.ts";
import { anchorOf } from "../../../shared/reading/anchors.ts";
import { cardPrompt } from "../../capabilities/card/drill-order.ts";
import { answered } from "../../capabilities/fold/answered.ts";
import { quoteOfAnchor } from "../../../shared/reading/compile-quote.ts";
import { turned } from "../../capabilities/fold/turned.ts";
import { handSlot } from "../../capabilities/fold/hand.ts";
import { says } from "../../capabilities/fold/says.ts";
import { composerNow, setComposer, subscribeComposer } from "../../capabilities/card/composing.ts";
import { openComposer, saveComposed } from "../../capabilities/card/doors.ts";
import { asking } from "../../capabilities/fold/asking.ts";
import { loadThread, onTurn, sendTurn, storeKeyOf, turnOf } from "../../capabilities/ask/useThread.ts";
import { here as hereNow } from "../../shell/here.ts";
import { asksKey } from "../../data/entities/boards.ts";
import type { ThreadEntity } from "../../data/entities/threads.ts";
import type { Ask } from "../../../shared/types/index.ts";
import { placeByQuote } from "../../../shared/reading/quote.ts";
import { bindGesturePinch, bindWheelPinch } from "../../engines/zoom/pinch.ts";
import { begin as journey, end as arrived } from "../../platform/rum.ts";
import { useChapters } from "./useChapters.ts";
import { useFind } from "./useFind.ts";
import type { BoardState, ResourceMeta, Section } from "../../../shared/types/index.ts";
import type { TreeState } from "../../engines/tree/TreeView.tsx";
import type { DrillCard, HeldPair } from "./useDrill.ts";

const sourceThread = (board: string, source: string): string => `board:${board}/source:${source}`;

// these layout effects must stay in one hook: splitting them reorders writes, paints and the scroll restore

export interface SourceRoom {
  live(): SourceColumnView & { treeOpen: boolean; cards: DrillCard[]; pairs: HeldPair[] };
  standOn(i: number): void;
  openPair(i: number): void;
  toast(t: string, ms?: number): void;
  toastWhy(e: unknown, said: string): void;
  reread(boardId: string): void;
  redistil(boardId: string, resourceId: string): Promise<unknown>;
  panelOpen(what: string): void;
}

// a card's answer as text, for a live page whose sheets can't take the reader's face
const answerText = (c: DrillCard): string =>
  c.type === "flashcard" ? c.back || "" : c.type === "trick" ? [c.title, c.trick, c.solution].filter(Boolean).join("\n\n") : c.type === "mcq" ? c.explanation || "" : "";

/** What the reader's folds may do to the deck in hand. */
export interface CardActs { seek(i: number): void; reveal(): void; grade(got: boolean): void; gradeAt(i: number, got: boolean): void; move(d: number): void }
export interface SourceColumnView {
  activeId: string | null; board: BoardState | null; src: ResourceMeta | null; onHome: boolean; pairIdx: number; pair: HeldPair;
  card: DrillCard | null; cardsAll: DrillCard[]; pos: number; solo: boolean; qDeck: unknown;
  done?: boolean; cardActs?: CardActs;
  splitW: number; ui: number; loading: boolean;
  sectionsHere: Section[]; openSection: Section | null; followChapters: boolean;
}

export type Trees = Record<string, TreeState>;

export interface HeldPlace {
  pageRef: MutableRefObject<HTMLDivElement | null>;
  pendingScroll: MutableRefObject<number | null>;
  landOnPage: MutableRefObject<number | null>;
  readerTop: MutableRefObject<number>;
}

const atKey = (id: string) => "strata.at." + id;
export interface AtMemory { pairId?: string | null; cardId?: string | null; scroll?: number; cards?: Record<string, string> }
export const readAt = (id: string): AtMemory => { try { return JSON.parse(localStorage.getItem(atKey(id)) || "{}"); } catch { return {}; } };

const EMPTY_DOC = () => ({ html: "", maps: [] as number[][], text: "" });

export function useSourceColumn(room: SourceRoom, v: SourceColumnView, { pageRef, pendingScroll, landOnPage, readerTop }: HeldPlace) {
  const { activeId, board, src, onHome, pairIdx, pair, card, cardsAll: cards, pos, solo, qDeck, splitW, ui, loading, sectionsHere, openSection } = v;
  const pdfHostRef = useRef<HTMLDivElement | null>(null);
  // the prose column is written by hand, not React: marks split its text nodes
  const proseRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef(EMPTY_DOC());
  const [docHtml, setDocHtml] = useState("");
  const [treeOpen, setTreeOpen] = useState(false);
  const [trees, setTrees] = useState<Trees>({});
  const [pz, setPz] = useState(readPz);
  const pzRef = useRef(pz);
  pzRef.current = pz;

  // the engine outlives every closure: it reads refs through getters, and pdfPaint points at fresh painters
  const pdfRef = useRef<PdfEngine | null>(null);
  const engine = () => pdfRef.current as PdfEngine;
  function ensureDrawn() { engine().ensureDrawn(); }

  const saveAt = (patch: AtMemory) => {
    const id = room.live().activeId; if (!id) return;
    try {
      const cur = JSON.parse(localStorage.getItem(atKey(id)) || "{}");
      localStorage.setItem(atKey(id), JSON.stringify({ ...cur, ...patch }));
    } catch { /* private mode, quota: losing the position is survivable */ }
  };
  // a hidden scroller clamps scrollTop to 0 at once, so track the position live and restore it on return
  const readerShown = useRef(false);
  // read synchronously: a keypress beats the next-frame scroll event, and a non-painting tab never gets it
  const keepReaderTop = () => {
    const sc = pageRef.current;
    if (sc && readerShown.current) readerTop.current = sc.scrollTop;
  };
  function landNow() {
    if (!landOnPageNow(pageRef.current, landOnPage.current)) return false;
    landOnPage.current = null;
    ensureDrawn();
    return true;
  }
  function settleRestore() {
    const sc = pageRef.current, want = pendingScroll.current;
    if (!sc || want == null) return;
    readerTop.current = restoreScroll(sc, want);
    pendingScroll.current = null;
    ensureDrawn();
  }
  const pdfPaint = useRef<{ laid(): void; drawn(n: number): void; text(n: number): void } | null>(null);
  if (!pdfRef.current) pdfRef.current = new PdfEngine({
    scroller: () => pageRef.current,
    pageZoom: () => pzRef.current || 1,
    readerShown: () => readerShown.current,
    landOnPage: () => landOnPage.current,
    landed: () => { landOnPage.current = null; },
    pendingScroll: () => pendingScroll.current,
    onLaid: () => pdfPaint.current!.laid(),
    onPageDrawn: (n) => pdfPaint.current!.drawn(n),
    onPageText: (n) => pdfPaint.current!.text(n),
  });
  useEffect(() => () => engine().dispose(), []);

  // a live HTML source: the page draws itself in a sandbox; the bridge carries selections, marks and jumps
  const liveRef = useRef<HtmlEngine | null>(null);
  const liveMarks = useRef<ReturnType<typeof useMarks> | null>(null);
  if (!liveRef.current) liveRef.current = new HtmlEngine({
    onSelect: (sel, at) => liveMarks.current?.offerLive(sel, at),
    onMark: (id) => {
      const m = marksOn(room.live().activeId, room.live().src).find((x) => x.id === id);
      liveMarks.current?.setOpenMark({ id, draft: (m && m.note) || "" });
    },
    onPress: () => liveMarks.current?.offerLive(null, null),
    onLoad: (url) => { const at = livePage(url); return at ? pageState.load(at.bid, at.rid) : Promise.reject(new Error("the page was closed")); },
    onSave: (url, value) => { const at = livePage(url); return at ? pageState.save(at.bid, at.rid, value) : Promise.reject(new Error("the page was closed")); },
  });
  // the source whose frame asked, only while it is still the one open: a frame left over from the last source gets nothing
  function livePage(url: string): { bid: string; rid: string } | null {
    const { activeId: bid, src: s } = room.live();
    return bid && s && drawnAs(s.kind) === "html" && url === StrataAPI.resourceLiveUrl(bid, s.id, s.generation) ? { bid, rid: s.id } : null;
  }
  const live = liveRef.current;
  useEffect(() => () => live.dispose(), []);
  const adapterRef = useRef<ReturnType<typeof sourceAdapters> | null>(null);
  adapterRef.current ??= sourceAdapters({
    scroller: () => pageRef.current, ensureDrawn, revealLive: (q, slug) => live.reveal(q, slug),
    proseDoc: () => (docRef.current.text ? { text: docRef.current.text, maps: docRef.current.maps } : null),
    pdfText: (n) => engine().text?.get(n) ?? null,
    // the page draws at the browser's own scale, so its folds are scaled back up to the room's
    layersLive: (items, on, fresh) => live.layers(items, on, room.live().ui * ROOM * (pzRef.current || 1), fresh),
  });
  const adapterOf = adapterRef.current;
  const shownKind = useRef<string | null>(null);
  const liveUrl = src && drawnAs(src.kind) === "html" && activeId ? StrataAPI.resourceLiveUrl(activeId, src.id, src.generation) : null;

  const pageIndex = (page: number) => engine().text?.get(page);
  const marks = useMarks({ ...room, pageRef, proseRef, pdfHostRef, docRef, pageIndex, clearLive: () => live.clearSelection() }, { pairIdx, loading });
  liveMarks.current = marks;
  function paintLive() {
    const { activeId: bid, src: s } = room.live();
    if (!s || drawnAs(s.kind) !== "html") return;
    const om = marks.openMarkRef.current;
    live.paint(marksOn(bid, s).map((m) => ({ id: m.id, start: m.start, end: m.end, quote: m.quote, note: !!m.note, box: m.box ?? null })), om && om.id);
  }
  const { openMark, paintPdfMarks } = marks;
  // where a kind opens its layers in folds, notes no longer hang in the margin
  const foldHost = {
    adapter: () => { const s = room.live().src; return s ? adapterOf(drawnAs(s.kind)) : null; },
    marks: () => marksOn(room.live().activeId, room.live().src),
    writing: () => marks.openMarkRef.current?.id ?? null,
    write: (id: string | null) => {
      const m = id ? marksOn(room.live().activeId, room.live().src).find((x) => x.id === id) : null;
      marks.setOpenMark(id ? { id, draft: (m && m.note) || "" } : null);
    },
    save: (id: string, text: string) => {
      const m = marksOn(room.live().activeId, room.live().src).find((x) => x.id === id);
      if (m && text !== (m.note || "")) void marks.saveNote(id, text);
      marks.setOpenMark(null);
    },
    remove: (id: string) => void marks.dropMark(id),
    reply: (id: string, text: string) => void marks.replyNote(id, text),
    // the deck, card by card: each sheet is turned and graded on its own; the card in hand is also the keys'
    cards: () => {
      const v = room.live(), s = v.src;
      if (!s || v.solo) return [];
      const kind = drawnAs(s.kind), face = kind !== "html", deck = v.pair.deck;
      return (v.cards || []).map((c) => {
        const hand = !!v.card && c.id === v.card.id, at = quoteOfAnchor(c.source), got = answered.of(deck, c.id);
        const up = (hand && v.done) || turned.has(deck, c.id);
        return { id: c.id, q: String(cardPrompt(c) ?? ""), where: at?.page ? `page ${at.page}` : "", at, face, held: hand, a: answerText(c),
          state: got !== null ? "done" as const : up ? "revealed" as const : "asking" as const,
          got, mcq: c.type === "mcq" };
      });
    },
    show: (id: string) => {
      const v = room.live(), i = v.cards.findIndex((c) => c.id === id);
      if (i < 0 || !v.cardActs) return;
      // an MCQ is answered by picking: it has to be in hand for its options to take the pick
      if (v.cards[i].type === "mcq" && (!v.card || v.card.id !== id)) { v.cardActs.seek(i); return; }
      turned.add(v.pair.deck, id);
      if (v.card && v.card.id === id) v.cardActs.reveal();
    },
    later: (id: string) => { const v = room.live(); if (v.card && v.card.id === id) v.cardActs?.move(1); },
    grade: (id: string, got: boolean) => {
      const v = room.live(), i = v.cards.findIndex((c) => c.id === id);
      if (i < 0) return;
      if (v.card && v.card.id === id) v.cardActs?.grade(got);
      else v.cardActs?.gradeAt(i, got);
    },
    // conversations at words on this source: its thread's turns that name them, and the one being started
    asks: () => {
      const v = room.live(), s = v.src, bid = v.activeId;
      if (!s || !bid || v.solo) return [];
      const key = sourceThread(bid, s.id);
      const msgs = roomStore.get<ThreadEntity>(storeKeyOf(key))?.messages ?? [];
      const turn = turnOf(key), maps = docRef.current.maps;
      const prose = drawnAs(s.kind) !== "pdf" && drawnAs(s.kind) !== "html";
      // the block holding an offset, by the blocks' source ranges
      const blockAt = (n: number) => { if (!prose) return null; const b = maps.findIndex((m) => m.length > 0 && m[0] <= n && n < m[m.length - 1]); return b < 0 ? null : b; };
      const held: Ask[] = (roomStore.get<Ask[]>(asksKey(bid)) ?? []).filter((a) => a.resourceId === s.id);
      const fresh = asking.now();
      const places = [...held.map((a) => ({ ...a, box: a.box ?? null, block: blockAt(a.start) })),
        ...(fresh && fresh.resourceId === s.id && !held.some((a) => a.id === fresh.id) ? [{ ...fresh, block: fresh.block ?? blockAt(fresh.start) }] : [])];
      return places.map((a) => {
        const turns = msgs.filter((m) => m.ask === a.id && m.text).map((m) => ({ who: m.role === "user" ? "you" as const : "claude" as const, text: m.text }));
        const mine = turn.ask === a.id;
        return { id: a.id, quote: a.quote, start: a.start, end: a.end, page: a.page, rects: a.rects, box: a.box ?? null, block: a.block,
          turns, writing: mine && turn.sending ? turn.reply : null, error: mine ? turn.error : "", again: mine && !turn.sending && turn.error ? turn.text : "",
          rich: drawnAs(s.kind) !== "html" };
      }).filter((a) => a.turns.length || a.writing !== null || a.error || (fresh && a.id === fresh.id));
    },
    ask: (id: string, text: string) => {
      const v = room.live(), s = v.src, bid = v.activeId;
      if (!s || !bid) return;
      const fresh = asking.now();
      const held = (roomStore.get<Ask[]>(asksKey(bid)) ?? []).find((a) => a.id === id);
      const at = held ?? (fresh && fresh.id === id ? fresh : null);
      if (!at) return;
      void sendTurn(sourceThread(bid, s.id), text, hereNow(),
        { id, start: at.start, end: at.end, quote: at.quote, page: at.page, rects: at.rects, box: at.box ?? null });
    },
    capture: (id: string, turn: number) => {
      const turns = foldHost.asks().find((a) => a.id === id)?.turns ?? [];
      const answer = turns[turn];
      if (!answer || answer.who !== "claude") return;
      const question = [...turns.slice(0, turn)].reverse().find((t) => t.who === "you")?.text ?? "";
      openComposer(question, answer.text);
    },
    draft: () => { const f = composerNow()?.fold; return f && f.resourceId === room.live().src?.id ? f : null; },
    // the save path toasts a refusal and keeps the draft, so what was written isn't lost
    keep: (front: string, back: string) => { const c = composerNow(); if (c?.fold) saveComposed({ front, back, source: c.source }).catch(() => {}); },
    discard: () => { if (composerNow()?.fold) setComposer(null); },
    drawn: () => slotsDrawn(),
  };
  // an answer's text by its slot: `ask:turn`, or `ask:w` for the one streaming in
  function sayOf(asks: ReturnType<typeof foldHost.asks>, key: string): string | null {
    const cut = key.lastIndexOf(":"), id = key.slice(0, cut), at = key.slice(cut + 1);
    const a = asks.find((x) => x.id === id);
    if (!a) return null;
    return at === "w" ? a.writing : a.turns[Number(at)]?.text ?? null;
  }
  function paintLayer() { paintFolds(foldHost); slotsDrawn(); }
  function slotsDrawn() {
    handSlot.find(pageRef.current);
    const asks = foldHost.asks();
    says.find(pageRef.current, (k) => sayOf(asks, k));
  }
  // a live page's marks hold offsets into the page, not its twin: read as an article, they land by their words
  function proseMarks<M extends { start: number; end: number; quote: string }>(s: ResourceMeta | null | undefined, ms: readonly M[]): readonly M[] {
    return s && s.kind === "html" ? placeByQuote(docRef.current.text, ms) : ms;
  }

  pdfPaint.current = {
    // a page drawing repaints its own marks; the layers lie over the pages, so they draw once the pages are laid out
    laid: () => { paintClaims(); paintLayer(); },
    drawn: (n) => {
      if (pendingScroll.current != null && readerShown.current) settleRestore();
      paintPdfMarks(n);
    },
    // a card is placed by its words, which a page has once its text is in: that page's layers draw again
    text: (n) => { paintPdfMarks(n); if (adapterOf("pdf").pageDrawn?.(n)) paintLayer(); },
  };

  const showTree = treeOpen && !onHome && !!src;
  // paintClaims also runs from the PDF render loop, whose closure is stale
  const treeDataRef = useRef<{ trees: Trees; sections: Section[] }>({ trees: {}, sections: [] });
  treeDataRef.current = { trees, sections: sectionsHere };
  // from the store, not the board: a stale board read can't drop a fresh highlight; not subscribed here
  const marksHere = marksOn(activeId, src);

  function renderPdf() {
    const host = pdfHostRef.current; if (!host || !src || !activeId) return;
    void engine().open(host, { key: activeId + ":" + src.id, rid: src.id, filename: src.filename, url: StrataAPI.resourceRawUrl(activeId, src.id) });
  }

  // read live state: this also runs from the async PDF render loop, whose closure is stale
  // cards sit in their passages' folds now: an old pin is only taken down

  function claimsOfSource() {
    const { trees: tr, sections } = treeDataRef.current;
    return claimsIn(tr, sections);
  }
  function goToClaimCard(id: string) {
    const i = room.live().cards.findIndex((x) => x.id === id);
    if (i >= 0) room.standOn(i);
  }
  const litNode = () => { const cur = room.live().card; return (cur && cur.node) || null; };
  function litClaims() { litBands(pageRef.current, litNode()); }
  function paintClaims() {
    const { src: s, cards: deck } = room.live();
    paintBands(pageRef.current, s ? drawnAs(s.kind) : null, s ? claimsOfSource() : [], deck, goToClaimCard, litNode());
  }

  useEffect(() => {
    // the sheets lie on a plane that outlives the source: the one left takes its sheets with it
    if (shownKind.current) adapterOf(shownKind.current).forgetLayers();
    shownKind.current = src && !onHome ? drawnAs(src.kind) : null;
    if (src) adapterOf(drawnAs(src.kind)).forgetLayers();
    if (onHome || !src || !activeId) { engine().forget(); docRef.current = EMPTY_DOC(); setDocHtml(""); return; }
    if (src.kind === "pdf") { docRef.current = EMPTY_DOC(); setDocHtml(""); renderPdf(); return; }
    engine().forget();
    if (drawnAs(src.kind) === "html") { docRef.current = EMPTY_DOC(); setDocHtml(""); return; }
    let dead = false;
    journey("prose.open");
    StrataSourceText(activeId, src.id, src.generation).then((t: string) => {
      if (dead) return;
      const r = mdRender(t, false);
      docRef.current = { html: r.html, maps: r.maps, text: t };
      setDocHtml(r.html);
    }).catch(() => { docRef.current = EMPTY_DOC(); setDocHtml(""); });
    return () => { dead = true; };
  }, [src && src.id, src && src.kind, src && src.generation, activeId]);

  // written by hand, not React (marks split text nodes), and only when the document or the div is new
  const proseWritten = useRef<{ col: HTMLElement | null; src: string | null; html: string | null; layout: string }>({ col: null, src: null, html: null, layout: "" });
  useLayoutEffect(() => {
    const col = proseRef.current;
    if (!col) return;
    const was = proseWritten.current;
    const fresh = was.col !== col || was.src !== (src && src.id) || was.html !== docHtml;
    const layout = [splitW, ui, pz].join();
    if (fresh) {
      col.innerHTML = docHtml;
      if (docHtml) { paintProseMarks(col, docRef.current.maps, proseMarks(src, marksHere), openMark && openMark.id); arrived("prose.open"); }
    }
    paintClaims();
    if (fresh || was.layout !== layout) paintLayer();
    proseWritten.current = { col, src: src && src.id, html: docHtml, layout };
    // treeOpen is a dep because flipping back from the tree remounts this div empty
  }, [docHtml, src && src.id, pos, cards, pairIdx, splitW, ui, pz, treeOpen]);

  // marks repaint from a store subscription, without rendering the room
  useEffect(() => {
    if (!activeId) return;
    const paintable = () => marksOn(room.live().activeId, room.live().src).map((m) => JSON.stringify([m.id, m.note, (m.replies ?? []).map((r) => r.id)])).join("|");
    let last = paintable();
    return roomStore.subscribe(marksKey(activeId), () => {
      const now = paintable();
      if (now === last) return;
      last = now;
      const s = room.live().src, om = marks.openMarkRef.current;
      if (!s) return;
      if (drawnAs(s.kind) === "html") { paintLive(); paintLayer(); return; }
      if (s.kind === "pdf") { paintPdfMarks(); paintLayer(); return; }
      const col = proseRef.current;
      if (!col || !docRef.current.html) return;
      reconcileProseMarks(col, docRef.current.maps, proseMarks(s, marksOn(room.live().activeId, s)), om && om.id);
      paintLayer();
    });
  }, [activeId]);

  useLayoutEffect(() => { paintLive(); paintLayer(); }, [openMark && openMark.id, liveUrl, ui, pz]);

  // a card begun or let go under a selection repaints the folds, not the room
  useEffect(() => subscribeComposer(() => { if (room.live().src) paintLayer(); }), []);

  // the open source's conversations at words: read once it opens, and repainted (a frame at a time) as answers stream
  const askSrc = src && !onHome ? src.id : null;
  useEffect(() => {
    if (!activeId || !askSrc) return;
    const key = sourceThread(activeId, askSrc);
    void loadThread(key).catch(() => {});
    let frame = 0;
    const soon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; paintLayer(); }); };
    const offs = [roomStore.subscribe(storeKeyOf(key), soon), roomStore.subscribe(asksKey(activeId), soon), onTurn(key, soon), asking.subscribe(soon)];
    return () => { cancelAnimationFrame(frame); offs.forEach((off) => off()); };
  }, [activeId, askSrc]);

  // the deck moving (a card turned, graded, or another in hand) repaints the folds, not the room
  useLayoutEffect(() => { if (src && !onHome) paintLayer(); }, [card && card.id, v.done, cards, solo]);

  // a card turned over in its sheet repaints the sheets
  useEffect(() => turned.subscribe(() => { if (room.live().src) paintLayer(); }), []);

  // a layer switch repaints the page's layers in place
  useEffect(() => {
    let was = switches.getSnapshot().on;
    return switches.subscribe(() => {
      const now = switches.getSnapshot().on;
      if (now === was) return;
      was = now;
      paintLayer();
    });
  }, []);

  useLayoutEffect(() => {
    const col = proseRef.current;
    if (!col || !docHtml) return;
    reconcileProseMarks(col, docRef.current.maps, proseMarks(src, marksHere), openMark && openMark.id);
    paintLayer();
  }, [openMark && openMark.id]);

  // pdf.js owns these pages, so marks repaint as each page draws and when the marks change
  useLayoutEffect(() => {
    if (!src || src.kind !== "pdf") return;
    paintPdfMarks();
    paintLayer();
  }, [src && src.id, pairIdx, splitW, ui, pz]);
  useLayoutEffect(() => {
    if (!src || src.kind !== "pdf") return;
    marks.lightPdfMarks(openMark ? openMark.id : null);
    paintLayer();
  }, [openMark && openMark.id]);

  useLayoutEffect(() => {
    if (!src || showTree || solo) return;
    paintClaims();
  }, [trees, src && src.id, pairIdx, cards, splitW, ui, pz, showTree, solo]);

  useLayoutEffect(() => { if (src && !showTree && !solo) litClaims(); }, [card && card.id, showTree, solo]);

  // re-rasterise only once the pinch settles; CSS zoom already shows each step
  useEffect(() => {
    const t = setTimeout(() => engine().redraw(), 250);
    return () => clearTimeout(t);
  }, [pz]);

  // the window size decides whether a note fits, and it isn't state
  useEffect(() => {
    const sc = pageRef.current; if (!sc || typeof ResizeObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(paintLayer, 120);
    });
    ro.observe(sc);
    // the pages settling their sizes (a PDF's are guessed, then measured) move every passage under the sheets
    for (const el of [pdfHostRef.current, proseRef.current]) if (el) ro.observe(el);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, [src && src.id, pairIdx, docHtml]);

  useEffect(() => {
    if (!activeId || !board) return;
    const patch: AtMemory = { pairId: onHome ? null : pair.id, cardId: card ? card.id : null };
    if (pendingScroll.current != null) patch.scroll = pendingScroll.current;
    // skipped while shuffling and for minted cards: their ids aren't in the pair's deck
    if (card && !card.mintId && !solo && !qDeck && pair && pair.deck) {
      patch.cards = { ...(readAt(activeId).cards || {}), [pair.deck]: card.id };
    }
    saveAt(patch);
  }, [activeId, pairIdx, card && card.id, board && board.pairs && board.pairs.length]);
  useEffect(() => {
    const sc = pageRef.current; if (!sc) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    // only the reader's own scroll: the tree flip fires a scroll to 0 as the scroller collapses
    const flush = () => {
      clearTimeout(t);
      if (readerShown.current && pendingScroll.current == null && landOnPage.current == null)
        saveAt({ scroll: Math.round(sc.scrollTop) });
    };
    const onScroll = () => { clearTimeout(t); t = setTimeout(flush, 350); };
    sc.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", flush);          // a reload mid-scroll still lands right
    return () => { clearTimeout(t); sc.removeEventListener("scroll", onScroll); window.removeEventListener("pagehide", flush); };
  }, [activeId, pairIdx, loading]);

  // emitted per 15s of active scrolling, not on an interval, so an idle tab isn't counted as reading
  useEffect(() => {
    const sc = pageRef.current; if (!sc || !src || onHome) return;
    let last = 0, deepest = 0;
    const beat = () => {
      const h = sc.scrollHeight - sc.clientHeight;
      const pct = h > 0 ? Math.min(100, Math.round((sc.scrollTop / h) * 100)) : 100;
      deepest = Math.max(deepest, pct);
      const t = Date.now();
      if (last && t - last < 15000) return;
      const ms = last ? t - last : 0;
      last = t;
      if (ms) StrataAPI.log("read_progress", { board: activeId, resource: src.id, kind: src.kind, pct, deepest, ms });
    };
    last = Date.now();
    sc.addEventListener("scroll", beat, { passive: true });
    return () => sc.removeEventListener("scroll", beat);
  }, [activeId, pairIdx, src && src.id, onHome]);

  const chapters = useChapters({ pageRef, landOnPage, openPair: room.openPair, toast: room.toast, live: room.live }, v);

  useEffect(() => {
    const want = landOnPage.current; if (!want) return;
    let tries = 0;
    const h = setInterval(() => {
      const sc = pageRef.current;
      if (landOnPage.current !== want) { clearInterval(h); return; }
      if (!sc || ++tries > 40) { clearInterval(h); landOnPage.current = null; return; }
      const el = sc.querySelector<HTMLElement>("#pg-" + want);
      if (!el) return;
      // flush to the top: even a small lead-in shows the bottom of the previous page
      sc.scrollTop = pageTop(el);
      clearInterval(h); landOnPage.current = null;
      ensureDrawn();
    }, 120);
    return () => clearInterval(h);
  }, [activeId, pairIdx]);

  // a reload during loading must keep the pending position, not save the empty reader's zero
  useEffect(() => {
    const want = pendingScroll.current; if (want == null || !src) return;
    let h: ReturnType<typeof setInterval> | undefined;
    const restore = () => {
      const sc = pageRef.current;
      if (pendingScroll.current !== want) { clearInterval(h); return true; }
      if (!sc || !readerShown.current) return;
      // prose waits for its fonts: a font landing after the restore reflows the text, and the place drifts with it
      const ready = src.kind === "pdf"
        ? engine().isOpen(activeId + ":" + src.id) && sc.querySelector(".slide canvas")
        : !!docHtml && document.fonts?.status !== "loading";
      if (!ready) return;
      readerTop.current = restoreScroll(sc, want);
      clearInterval(h); pendingScroll.current = null;
      if (src.kind === "pdf") ensureDrawn();
      return true;
    };
    if (restore()) return;
    h = setInterval(restore, 250);
    void document.fonts?.ready.then(() => { if (h !== undefined) restore(); });
    return () => { clearInterval(h); h = undefined; };
  }, [activeId, pairIdx, docHtml, loading, src && src.id]);

  // unthrottled: a debounce would lose the last position before the reader hides
  useEffect(() => {
    const sc = pageRef.current; if (!sc) return;
    const note = () => { if (readerShown.current) readerTop.current = sc.scrollTop; };
    sc.addEventListener("scroll", note, { passive: true });
    return () => sc.removeEventListener("scroll", note);
  }, [loading]);

  // layout effect, so the page is never seen at the top first; the next frame is only a second attempt
  useLayoutEffect(() => {
    const sc = pageRef.current; if (!sc) return;
    const shown = !showTree && !solo;
    if (shown === readerShown.current) return;
    readerShown.current = shown;
    // a jump zeroes this on its way out: it is already saying where you are going
    if (!shown || !readerTop.current) return;
    if (landOnPage.current || pendingScroll.current) return;   // a landing outranks a return
    const want = readerTop.current;
    sc.scrollTop = want;
    requestAnimationFrame(() => {
      const el = pageRef.current;
      if (el && readerShown.current && Math.abs(el.scrollTop - want) > 2) el.scrollTop = want;
    });
  }, [showTree, solo, loading]);

  // file trees under the section id their readers look up; keyed by resource id this refetched forever
  async function loadTree(sid: string, rid: string, id: string) {
    if (!sid || !rid || !id) return;
    try {
      const data = await StrataAPI.tree(id, rid, sid);
      setTrees((m) => ({ ...m, [sid]: { data } }));
    } catch (e) {
      // 404 is the ordinary never-distilled case, not a failure
      const err = e as { status?: number; message?: string };
      setTrees((m) => ({ ...m, [sid]: err.status === 404 ? { missing: true } : { data: { status: "error", error: err.message } } }));
    }
  }
  useEffect(() => {
    if (!treeOpen || !src || !activeId || !openSection) return;
    const st = trees[openSection.id];
    if (!st) { loadTree(openSection.id, src.id, activeId); return; }
    const status = st.data && st.data.status;
    if (status !== "pending" && status !== "running" && status !== "carding") return;
    const h = setTimeout(() => loadTree(openSection.id, src.id, activeId), 3500);
    return () => clearTimeout(h);
  }, [treeOpen, src && src.id, activeId, openSection && openSection.id, trees]);

  // only sections the board says are ready, so this cannot loop or 404
  const treeAsked = useRef(new Set<string>());
  useEffect(() => {
    if (!src || !activeId || !board) return;
    const st = board.trees || {};
    for (const s of sectionsHere) {
      const row = st[s.id] || {};
      if (row.status !== "ready") continue;
      // keyed by the row's own clock, so distilling a chapter again fetches the new tree
      const k = activeId + ":" + s.id + ":" + (row.at || 0);
      if (treeAsked.current.has(k)) continue;
      treeAsked.current.add(k);
      loadTree(s.id, src.id, activeId);
    }
  }, [src && src.id, activeId, sectionsHere.map((s) => s.id).join(), board && board.trees, trees]);

  async function distilNow() {
    const s = room.live().src, id = room.live().activeId;
    if (!s || !id) return;
    if (!(await room.redistil(id, s.id))) return;
    setTrees((m) => ({ ...m, [s.id]: { data: { status: "running" } } }));
    room.toast("distilling " + s.filename);
  }

  function scrollTo(el: Element, pad: number) { glideTo(pageRef.current, el, pad); }

  function jumpToAnchor(anchor: string) {
    const s = room.live().src; if (!s) return;
    readerTop.current = 0;         // a jump already says where you are going: do not put you back first
    setTreeOpen(false);
    // the reader has to be back on screen before we can measure anything in it
    requestAnimationFrame(async () => {
      if (!pageRef.current) return;
      if (!(await adapterOf(drawnAs(s.kind)).reveal(anchorOf({ source: anchor })))) room.toast("that part of the source isn't marked up");
    });
  }

  function goToCard(c: { id: string }) {
    const i = room.live().cards.findIndex((x) => x.id === c.id);
    if (i < 0) return;
    room.standOn(i);
  }

  async function jumpToCard() {
    const c = room.live().card, s = room.live().src; if (!c || !s) return;
    // a card's place is its quote, and nothing else stands in for it
    const at = quoteOfAnchor(c.source); if (!pageRef.current) return;
    if (!at) { room.toast("this card has no place in the source"); return; }
    if (room.live().treeOpen) { readerTop.current = 0; setTreeOpen(false); }
    if (await adapterOf(drawnAs(s.kind)).reveal(anchorOf({ source: c.source }))) return;
    room.toast("that part isn't in this source");
  }

  useEffect(() => {
    const offWheel = bindWheelPinch(pageRef.current, stepPz), offGesture = bindGesturePinch(pageRef.current, stepPz);
    return () => { offWheel(); offGesture(); };
  }, [loading]);
  const finder = useFind({ here: room.live, pageRef, proseRef, pdfHostRef, docRef, pageIndex, ensureDrawn, scrollTo, panelOpen: room.panelOpen },
    [pairIdx, activeId, treeOpen, solo]);

  const flipTree = (on: boolean | ((was: boolean) => boolean)) => { keepReaderTop(); setTreeOpen(on); };

  function stepPz(d: number) {
    setPz((was) => {
      const i = Math.max(0, Math.min(PZ_STEPS.length - 1, PZ_STEPS.indexOf(was) + d));
      const next = PZ_STEPS[i];
      try { localStorage.setItem("strata.pz", String(next)); } catch { /* private mode */ }
      room.toast("page " + Math.round(next * 100) + "%");
      if (next !== was) StrataAPI.log("page_scale", { board: room.live().activeId, pz: next, dir: d });
      return next;
    });
  }

  return {
    pageRef, proseRef, pdfHostRef, docRef, pdfRef, ensureDrawn,
    live: { engine: live, url: liveUrl },
    pz, stepPz, treeOpen, setTreeOpen, flipTree, trees, showTree,
    marks, chapters, finder,
    place: { pageRef, pendingScroll, landOnPage, readerTop, keepReaderTop, landNow },
    tree: { jumpToAnchor, jumpToCard, goToCard, distilNow },
  };
}
