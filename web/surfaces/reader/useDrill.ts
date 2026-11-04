import { answered } from "../../capabilities/fold/answered.ts";
import { turned } from "../../capabilities/fold/turned.ts";
import { useEffect, useRef, useState } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import { StrataAPI } from "../../data/api.ts";
import { levelOf, byStage, passesOf } from "../../capabilities/card/drill-order.ts";
import { grades, drillGradeRequest } from "../../data/entities/grades.ts";
import { dropCard, restoreCard as putCardBack, deckOf, type CardRef } from "../../capabilities/card/saveCard.ts";
import { warmPdf } from "../../engines/pdf/runtime.ts";
import { TOUCH, PHONE } from "../../platform/device.js";
import { begin as journey, end as arrived } from "../../platform/rum.ts";
import type { BoardState, Card, DeckSummary, Pair, Section } from "../../../shared/types/index.ts";
import type { KeepsFrame, Navigation } from "../../shell/routes.ts";
import type { AuthoredCard } from "../../capabilities/card/authored.ts";
import type { FrameCard } from "../../capabilities/card/CardFrame.tsx";

// a grade, from the keys or a sheet: the sheet shuts on it and the deck passes it over
function graded(deck: string | null | undefined, id: string, got: boolean): void {
  answered.set(deck, id, got);
  turned.drop(deck, id);
}

export type DrillCard = (Card | AuthoredCard) & FrameCard & { pairId?: string | null };
type Ref<T> = { current: T };

export type HeldPair = Pick<Pair, "id" | "label" | "resourceId" | "deck"> & Partial<Pick<Pair, "ord" | "sectionId">> & { isHome?: boolean };

export interface DrillLive {
  activeId: string | null;
  board: BoardState | null;
  pairs: HeldPair[];
  pairIdx: number;
  pair: HeldPair;
  mine: AuthoredCard[];
  card: DrillCard | null;
  cards: DrillCard[];
  pos: number;
  done: boolean;
  solo: boolean;
  passNo: number;
  passes: number[];
  qDeck: { kind: string; name: string } | null;
}

export interface DrillRoom {
  toast(t: string, ms?: number): void;
  toastWhy(e: unknown, said: string): void;
  hideShelf(): void;
  setSheetsPin(on: boolean): void;
  setSheetsDone(on: boolean): void;
  setBench(frames: KeepsFrame[]): void;
  setPairIdx(i: number): void;
  setEditingNote(on: boolean): void;
  setTreeOpen(on: boolean): void;
  benchDeckChanged(slug: string, standOn: string | null): void;
  mintOpenCard(c: DrillCard): void;
  jumpToCard(): void;
  keepReaderTop(): void;
  landNow(): boolean;
  pageRef: Ref<HTMLElement | null>;
  pendingScroll: Ref<number | null>;
  landOnPage: Ref<number | null>;
  readerTop: Ref<number>;
  sectionOfPair(p: HeldPair): Section | null;
  readAt(id: string | null): { cards?: Record<string, string> };
}

export const cardsOnlyKey = (id: string) => "strata.cardsonly." + id;

const shuffled = <T,>(xs: readonly T[]): T[] => { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function drillView(v: { openQ: { cards: DrillCard[] } | null; inDrill: DrillCard[]; solo: boolean; mixed: DrillCard[]; cards: DrillCard[]; pos: number; revealed: boolean; picked: number | null; decks: DeckSummary[]; pair: HeldPair }) {
  const { openQ, inDrill, solo, mixed, cards, pos, revealed, picked, decks, pair } = v;
  const deck = openQ ? openQ.cards : inDrill.concat(solo ? mixed : cards);
  const card = deck[pos] || null;
  const done = revealed || picked !== null;
  const passes = passesOf(deck);
  const passNo = card ? passes.indexOf(levelOf(card)) + 1 : 0;
  const cardKeep = (() => {
    const slug = openQ ? null : (!solo && pair.deck) || (card && card.deck ? String(card.deck).split("/")[0] : null);
    const d = slug ? decks.find((x) => x.slug === slug) : null;
    return d ? { kept: d.kept || 0, total: d.total || 0, benched: !!d.benched } : null;
  })();
  return { deck, card, done, passes, passNo, cardKeep };
}

export function useDrill(room: DrillRoom, { stateRef, nav, activeId, board }: { stateRef: Ref<DrillLive>; nav: Ref<Navigation>; activeId: string | null; board: BoardState | null }) {
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [deckError, setDeckError] = useState<string | null>(null);
  const [cards, setCards] = useState<DrillCard[]>([]);
  const [pos, setPos] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  // a Set in state, replaced rather than mutated, so React sees the change
  const [seenIds, setSeenIds] = useState<Set<string>>(() => new Set());
  const [cardsOnly, setCardsOnly] = useState(() => { try { return !!activeId && localStorage.getItem(cardsOnlyKey(activeId)) === "1"; } catch { return false; } });
  const [mixed, setMixed] = useState<DrillCard[]>([]);
  const [mixing, setMixing] = useState(false);
  const [qDeck, setQDeck] = useState<{ kind: string; name: string } | null>(null);
  const [ignoredPile, setIgnoredPile] = useState<{ board: string | null; cards: DrillCard[] } | null>(null);
  // the card's id, not a boolean, so moving the deck closes the editor
  const [editing, setEditing] = useState<string | null>(null);
  const deckRequest = useRef(0);
  const deckCacheRef = useRef<Record<string, DrillCard[]>>({});
  const shownAt = useRef(0);
  const swipeRef = useRef<{ x: number; y: number; at: number } | null>(null);

  // log props are free-form
  function logCard(event: string, extra?: Record<string, unknown>) {
    const s = stateRef.current, c = s.card; if (!c) return;
    StrataAPI.log(event, {
      board: s.activeId, deck: c.deck || null, card: c.id, type: c.type,
      pass: s.passNo, passes: (s.passes || []).length, solo: !!s.solo, pos: s.pos,
      // dwell is measured from the card appearing, so card_show is its zero and carries none
      ...(event === "card_show" || !shownAt.current ? {} : { ms: Date.now() - shownAt.current }),
      ...(extra || {}),
    });
    // same Set back when nothing changed, so an already-seen card causes no repaint
    if (event === "card_show") setSeenIds((was) => (was.has(c.id) ? was : new Set(was).add(c.id)));
  }
  function answer(i: number) {
    const c = stateRef.current.card; if (!c) return;
    room.hideShelf();
    setPicked(i);
    logCard("card_answer", { picked: i, hit: i === c.correct });
  }

  function openPair(i: number, wantCard?: string) {
    const p = stateRef.current.pairs[i]; if (!p) return;
    if (!PHONE) warmPdf();
    room.pendingScroll.current = null;
    room.landOnPage.current = null;
    room.setPairIdx(i); setPos(0); setRevealed(false); setPicked(null); room.setEditingNote(false);
    room.setBench([]);
    room.readerTop.current = 0;
    const sec = room.sectionOfPair(p);
    const same = stateRef.current.pairIdx === i;
    if (sec && sec.firstPage > 1) {
      room.landOnPage.current = sec.firstPage;
      // clicking the chapter you're in doesn't change pairIdx, so the landing poll won't fire: land now
      // a timer, not a frame: this has to fire even when the tab is not painting
      if (same) setTimeout(() => room.landNow(), 0);
    } else if (room.pageRef.current) room.pageRef.current.scrollTop = 0;
    room.setTreeOpen(false);
    // reopen on the card you left: wantCard, then this device's memory, then the server's touched[deck].last
    const back = wantCard || (p.deck
      ? (room.readAt(stateRef.current.activeId).cards || {})[p.deck] || stateRef.current.board?.touched?.[p.deck]?.last
      : undefined);
    if (p.deck && (wantCard || p.deck !== (stateRef.current.pair || {}).deck)) { journey("deck.open"); loadDeck(p.deck, back); }
    else if (!p.deck) { setCards([]); }
    StrataAPI.log("pair_open", { board: stateRef.current.activeId, label: p.label });
  }
  async function loadDeck(slug: string, wantCard?: string | null, quiet = false) {
    const version = nav.current.version, request = ++deckRequest.current;
    const current = () => nav.current.current(version) && request === deckRequest.current;
    try {
      const d = await StrataAPI.deck(slug);
      if (!current()) return;
      const cs = (d.cards || []).slice().sort(byStage);
      const at = wantCard ? cs.findIndex((c: DrillCard) => c.id === wantCard) : -1;
      setCards(cs);
      if (!quiet) { setPos(at > 0 ? at : 0); setRevealed(false); setPicked(null); }
    } catch {
      if (!current()) return;
      setCards([]); setDeckError("error");
    }
  }

  // replace every copy the drill holds: one card can be in up to four lists at once
  function patchCardEverywhere(slug: string, id: string, merged: Card) {
    const put = (x: DrillCard) => (x.id === id ? { ...x, ...merged } : x);
    setCards((cs) => cs.map(put));
    setMixed((ms) => ms.map(put));
    setIgnoredPile((ip) => (ip ? { ...ip, cards: ip.cards.map(put) } : ip));
    const cached = deckCacheRef.current[slug];
    if (cached) deckCacheRef.current[slug] = cached.map(put);
  }

  async function reviewDeleteCard(c: CardRef) {
    await dropCard(c);
    const s = stateRef.current;
    const at = s.cards.findIndex((x: DrillCard) => x.id === c.id);
    if (at >= 0) {
      setPos(Math.max(0, at < s.pos ? s.pos - 1 : Math.min(s.pos, s.cards.length - 2)));
      if (at === s.pos) { setRevealed(false); setPicked(null); }
    }
    setCards((cs) => cs.filter((x) => x.id !== c.id));
    setMixed((ms) => ms.filter((x) => x.id !== c.id));
    delete deckCacheRef.current[deckOf(c)];
    StrataAPI.decks().then((cs) => setDecks(cs || [])).catch(() => {});
  }
  async function undeleteCard(c: CardRef, standOn: string | null = c.id) {
    await putCardBack(c);
    room.benchDeckChanged(deckOf(c), standOn);
  }

  // fetched fresh on every open: the pile changes under you
  async function openIgnored() {
    const s = stateRef.current;
    const slugs: string[] = Array.from(new Set<string>((s.pairs || []).map((p2) => p2.deck).filter((d): d is string => !!d)));
    try {
      const lists = await Promise.all(slugs.map((sl) => StrataAPI.deckIgnored(sl).then((j) => j.cards || []).catch(() => [])));
      setIgnoredPile({ board: s.activeId, cards: lists.flat() });
      setQDeck({ kind: "ignored", name: "ignored" }); room.setPairIdx(0); setPos(0); setRevealed(false); setPicked(null);
    } catch (e) { room.toastWhy(e, "couldn't read the ignored pile"); }
  }
  function restoreCard() {
    const s = stateRef.current, c = s.card;
    if (!c || !deckOf(c)) return;
    const was = s.cards.length;
    setIgnoredPile((ip) => (ip ? { ...ip, cards: ip.cards.filter((x) => x.id !== c.id) } : ip));
    setPos((p) => Math.max(0, Math.min(p, was - 2)));
    setRevealed(false); setPicked(null);
    undeleteCard(c, null).catch((e) => room.toastWhy(e, "couldn't put that card back"));
  }

  function move(d: number) {
    journey("flip"); arrived("flip");
    const n = Math.max(1, stateRef.current.cards.length);
    const at = stateRef.current.pos, deck = stateRef.current.pair?.deck, cards = stateRef.current.cards;
    // a card graded in its sheet is passed over, until every card of the deck is
    let step = d;
    if (d && deck) for (let k = 1; k < n; k++) {
      const i = (((at + Math.sign(d) * k) % n) + n) % n;
      if (cards[i] && answered.of(deck, cards[i].id) === null) { step = Math.sign(d) * k; break; }
    }
    const finished = d > 0 && n > 2 && at + step >= n;
    room.setSheetsPin(false);
    const p = stateRef.current.pair;
    const slug = finished && !stateRef.current.qDeck && !stateRef.current.solo && p && p.deck ? p.deck : null;
    room.setBench(slug ? [{ slug, title: p.label || slug }] : []);
    room.setSheetsDone(finished && !slug);
    setPos((((at + step) % n) + n) % n); setRevealed(false); setPicked(null);
  }
  function seek(i: number) {
    const n = stateRef.current.cards.length;
    if (!(i >= 0 && i < n) || i === stateRef.current.pos) return;
    room.setSheetsPin(false); room.setSheetsDone(false); room.setBench([]);
    setPos(i); setRevealed(false); setPicked(null);
  }

  // wired only on coarse pointers, so a mouse click on the card still does nothing
  function touchAdvance() {
    const c = stateRef.current.card, isDone = stateRef.current.done;
    if (!c) return;
    if (c.mintOpen) { room.mintOpenCard(c); return; }
    room.hideShelf();
    if (!isDone && c.type !== "mcq") { setRevealed(true); logCard("card_reveal"); }
  }
  // grades are saved on the save path's grades lane; the deck moves on without waiting
  const gradeDropped = (e: unknown) => {
    const status = e ? (e as { status?: unknown }).status : undefined;
    return status === 0 ? room.toast("offline — grades aren't saved (read only)", 2400)
      : status === 404 ? room.toast("that card is no longer in its deck — its grade wasn't saved", 4200)
      : room.toastWhy(e, "a grade wasn't saved");
  };
  function gradeCard(got: boolean) {
    const s = stateRef.current, c = s.card; if (!c) return;
    graded(s.pair?.deck, c.id, got);
    const request = drillGradeRequest(c, got, { board: s.activeId, pass: s.passNo, passes: (s.passes || []).length,
      solo: !!s.solo, pos: s.pos, ms: shownAt.current ? Date.now() - shownAt.current : undefined });
    if (!request) logCard("card_grade", { got });
    else grades.grade(request, gradeDropped);
    move(1);
  }
  // a card graded in its own sheet, not the one in hand: the hand stays where it is
  function gradeAt(i: number, got: boolean) {
    const s = stateRef.current, c = s.cards[i];
    if (!c) return;
    if (i === s.pos) { gradeCard(got); return; }
    graded(s.pair?.deck, c.id, got);
    const request = drillGradeRequest(c, got, { board: s.activeId, pass: s.passNo, passes: (s.passes || []).length, solo: !!s.solo, pos: i });
    if (request) grades.grade(request, gradeDropped);
  }
  function jumpCard() {
    const c = stateRef.current.card;
    if (!c || !stateRef.current.done) return;
    StrataAPI.log("jump_to_source", { board: stateRef.current.activeId, card: c.id, solo: !!stateRef.current.solo });
    if (stateRef.current.solo) void goToCardSource(c); else room.jumpToCard();
  }
  function deckTouchStart(e: ReactTouchEvent) {
    if (!TOUCH || !stateRef.current.card || e.touches.length > 1) { swipeRef.current = null; return; }
    const t = e.touches[0];
    swipeRef.current = { x: t.clientX, y: t.clientY, at: Date.now() };
  }
  function deckTouchEnd(e: ReactTouchEvent) {
    const s = swipeRef.current; swipeRef.current = null;
    if (!s || !stateRef.current.card) return;
    const t = e.changedTouches[0]; if (!t) return;
    const dx = t.clientX - s.x, dy = t.clientY - s.y, ms = Date.now() - s.at;
    if (ms < 600 && Math.abs(dx) > 56 && Math.abs(dx) > 2 * Math.abs(dy)) { move(dx < 0 ? 1 : -1); return; }
    if (ms < 350 && Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const el = e.target as Element | null;
      if (el && el.closest && el.closest("button, a, input, textarea, .opt, .openq")) return;
      touchAdvance();
    }
  }

  function toggleCardsOnly(v?: boolean) {
    const id = stateRef.current.activeId;
    room.keepReaderTop();

    setCardsOnly((cur) => {
      const next = v === undefined ? !cur : v;
      try { if (id) localStorage.setItem(cardsOnlyKey(id), next ? "1" : "0"); } catch { /* private mode */ }
      StrataAPI.log("cards_only", { board: id, on: next });
      if (!next) { setPos(0); setRevealed(false); setPicked(null); }
      return next;
    });
  }

  async function deckCards(slug: string): Promise<DrillCard[]> {
    if (!slug) return [];
    if (deckCacheRef.current[slug]) return deckCacheRef.current[slug];
    try {
      const d = await StrataAPI.deck(slug);
      deckCacheRef.current[slug] = d.cards || [];
      return deckCacheRef.current[slug];
    } catch { deckCacheRef.current[slug] = []; return []; }
  }
  async function mixBoard() {
    const bd = stateRef.current.board, ps = stateRef.current.pairs;
    if (!bd) return;
    setMixing(true);
    const out: DrillCard[] = [];
    for (const p of ps) {
      if (p.isHome || !p.deck) continue;
      for (const c of await deckCards(p.deck)) out.push({ ...c, pairId: p.id, pairLabel: p.label || "" });
    }
    for (const mc of (stateRef.current.mine || [])) out.push({ ...mc, pairLabel: "yours" });
    const passes = passesOf(out);
    setMixed(passes.flatMap((L) => shuffled(out.filter((c) => levelOf(c) === L))));
    setMixing(false);
    setPos(0); setRevealed(false); setPicked(null);
  }
  const pairsSig = (board && board.pairs || []).map((p) => p.id + ":" + p.deck).join();
  useEffect(() => {
    if (!cardsOnly || !board) { if (!cardsOnly && mixed.length) setMixed([]); return; }
    void mixBoard();
  }, [cardsOnly, activeId, pairsSig]);

  async function goToCardSource(c: DrillCard) {
    const i = stateRef.current.pairs.findIndex((p) => (c.pairId ? p.id === c.pairId : p.deck === deckOf(c)));
    if (i < 0) { room.toast("that card's page has left this board"); return; }
    toggleCardsOnly(false);
    openPair(i, c.id);
    for (let t = 0; t < 30; t++) {
      await new Promise((r) => setTimeout(r, 100));
      const cur = stateRef.current.card;
      if (cur && cur.id === c.id) { room.jumpToCard(); return; }
    }
  }

  return {
    decks, setDecks, deckError, setDeckError, cards, setCards, pos, setPos, revealed, setRevealed, picked, setPicked,
    seenIds, setSeenIds, cardsOnly, setCardsOnly, mixed, setMixed, mixing, qDeck, setQDeck, ignoredPile, setIgnoredPile,
    editing, setEditing, deckCacheRef, shownAt,
    logCard, answer, openPair, loadDeck, patchCardEverywhere, reviewDeleteCard, undeleteCard, openIgnored, restoreCard,
    move, seek, touchAdvance, gradeCard, gradeAt, jumpCard, deckTouchStart, deckTouchEnd, toggleCardsOnly, deckCards, goToCardSource,
  };
}

export function useCardInHand(drill: ReturnType<typeof useDrill>, card: DrillCard | null, solo: boolean) {
  const { shownAt, logCard, setEditing } = drill;
  useEffect(() => {
    shownAt.current = Date.now();
    if (card) { logCard("card_show"); arrived("continue"); arrived("deck.open"); }
  }, [card && card.id, solo]);
  useEffect(() => { setEditing((id) => (card && id === card.id ? id : null)); }, [card && card.id]);
}
