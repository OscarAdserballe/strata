import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { StrataAPI, StrataWhy, StrataWireDown } from "../data/api.ts";
import { store as roomStore } from "../data/store.ts";
import { BOARDS } from "../data/entities/sources.ts";
import { primeBoards, primeRegister } from "../data/entities/register.ts";
import { closeAsk } from "../capabilities/ask/control.ts";
import { boardNotes } from "../surfaces/board/boardNotes.ts";
import { cardsOnlyKey } from "../surfaces/reader/useDrill.ts";
import { drill } from "../surfaces/reader/handle.ts";
import { readAt, type HeldPlace } from "../surfaces/reader/useSourceColumn.ts";
import { warmPdf } from "../engines/pdf/runtime.ts";
import { PHONE } from "../platform/device.js";
import { begin as journey, end as arrived } from "../platform/rum.ts";
import { keepsFrames, navigate, readRoute, routeBoard, routeSearch, type Navigation } from "./routes.ts";
import { putKeepsAway, screensNow, setKeeps, setLibraryQuery, showCram, showLibrary, showReview } from "./screens.ts";
import { holdPair } from "./pair.ts";
import { DISPATCH } from "./dispatch.ts";

type Wire = any;

export interface BoardNavigationRoom {
  nav: MutableRefObject<Navigation>;
  stateRef: MutableRefObject<Wire>;
  activeId: string | null;
  place: HeldPlace;
  setActiveId(id: string | null): void;
  setBoard(st: Wire): void;
  setLoading(on: boolean): void;
  toast(t: string, ms?: number): void;
  make(question: string): Promise<{ board: { id: string }; state: Wire } | null>;
}

export function useBoardNavigation(room: BoardNavigationRoom) {
  const { nav, stateRef, activeId, place: { pendingScroll, landOnPage, readerTop }, setActiveId, setBoard, setLoading, toast, make } = room;
  const bootRoute = useRef(readRoute(location.search));
  const decksRequested = useRef(false);
  useEffect(() => {
    // A deep link needs only the requested board, not the board list or deck catalogue.
    const list = primeBoards().then(() => {
      if (roomStore.entry(BOARDS)?.error && StrataWireDown()) toast("offline — showing what's on the shelf");
    });
    if (bootRoute.current.kind !== "review") void primeRegister();
    const route = restoreRoute();
    (!routeBoard(bootRoute.current) && bootRoute.current.kind !== "review" ? Promise.all([list,route]) : route)
      .catch(()=>showLibrary(true)).finally(()=>setLoading(false));
  }, []);
  useEffect(()=>{
    if (!activeId || decksRequested.current) return;
    decksRequested.current = true;
    StrataAPI.decks().then(cs=>drill.setDecks(cs || [])).catch(()=>{decksRequested.current=false;});
  },[activeId]);
  const landing = useRef<Wire>(null);
  function land(l: Wire) { showCram(!!l.cram); setKeeps(l.bench || []); }
  async function restoreRoute() {
    const route = readRoute(location.search);
    const s = stateRef.current, stack = screensNow().keeps;
    showReview(route.kind === "review");
    const on = routeBoard(route);
    const over = route.kind === "cram" ? { cram: true } : route.kind === "keeps" ? { bench: keepsFrames(route) } : {};
    if (!on) {
      // Dispatch opens its own first page once its threads arrive; the library would only flash over it.
      navigate(route, "none"); showLibrary(!DISPATCH);
      if (route.kind === "keeps") land(over);
      else if (stack.length && stack[0].library) putKeepsAway();
      return;
    }
    const p = s.pair;
    const here = s.activeId === on && !!s.board
      && (route.kind !== "board" || ((route.pair || null) === (p && !p.isHome ? p.id : null)
        && (!route.resource || (!!p && p.resourceId === route.resource))));
    if (here) { navigate(route, "none", true); showLibrary(false); land(over); return; }
    const switching = s.activeId !== on;
    const mine = { ...over, board: on };
    if (switching) landing.current = mine;
    const opened = await openBoard(on, route.kind === "board" ? route.resource : undefined,
      { pair: route.kind === "board" ? route.pair : undefined, resume: route.kind !== "board", history: "none", restorePosition: true });
    // Clear a superseded landing, or it would raise this cram or keeps the next time the board opens.
    if (opened !== true && landing.current === mine) landing.current = null;
    if (opened === false) { navigate({ kind: "library" }, "replace"); showLibrary(true); return; }
    if (opened !== true) return;
    if (route.kind !== "board") navigate(route, "replace", true);
    if (!switching) land(over);
  }
  useEffect(() => {
    const back = () => { void restoreRoute(); };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  async function openBoard(id: string, wantResource?: string, options: { pair?: string; resume?: boolean; history?: "push" | "replace" | "none"; restorePosition?: boolean } = {}): Promise<boolean | undefined> {
    const previous = nav.current.route;
    if (!wantResource && !options.pair) journey("board");
    if (!PHONE) warmPdf();        // the board most likely opens on a page: start pdf.js beside the fetch
    const version = navigate({ kind: "board", board: id, resource: wantResource || undefined, pair: options.pair }, options.history || "push");
    // A board that can't be fetched leaves you where you were instead of an unhandled rejection.
    let st;
    try { st = await StrataAPI.getBoard(id); }
    catch (e) {
      if (!nav.current.current(version)) return;
      navigate(previous, "replace");
      toast(StrataWireDown() ? "offline — this board isn't on this device yet" : StrataWhy(e, "couldn't open that board"), 4200);
      return false;
    }
    if (!nav.current.current(version)) return;
    setActiveId(id); setBoard(st); showLibrary(false); showReview(false);
    arrived("board");
    closeAsk(); drill.setRevealed(false); drill.setPicked(null);
    try { drill.setCardsOnly(localStorage.getItem(cardsOnlyKey(id)) === "1"); } catch (e) { drill.setCardsOnly(false); }
    StrataAPI.log("board_enter", { board: id, cover: wantResource || null });
    boardNotes.seed(id, st); boardNotes.setEditing(false);
    drill.setCards([]); drill.setDeckError(null); drill.setPos(0);
    drill.setSeenIds(new Set());
    StrataAPI.seen(id).then((j) => {
      if (nav.current.current(version)) drill.setSeenIds(new Set(j.seen || []));
    }).catch(() => {});
    const at = readAt(id);
    // Start the deck read alongside the board's, instead of after the reader's first render.
    const warmDeck = (slug: string) => { void StrataAPI.warmDeck(slug).catch(() => {}); };
    // Resume from this device's memory first, then the server's last card_show, so other devices pick up too.
    const resume = (slug: string) => (at.cards || {})[slug] || ((st.touched || {})[slug] || {}).last || null;
    const want = options.pair ? (st.pairs || []).findIndex(p => p.id === options.pair)
      : wantResource ? (st.pairs || []).findIndex((p) => p.resourceId === wantResource) : -1;
    const i = options.resume && at.pairId ? (st.pairs || []).findIndex((p) => p.id === at.pairId) : -1;
    pendingScroll.current = null;
    landOnPage.current = null;
    readerTop.current = 0;
    if (want >= 0) {
      const p = st.pairs[want];
      holdPair(want + 1, p.id);
      nav.current.route = { kind: "board", board: id, pair: p.id, resource: p.resourceId || undefined };
      if (options.history !== "none") history.replaceState(null, "", location.pathname + routeSearch(nav.current.route));
      if (p.deck) { warmDeck(p.deck); drill.loadDeck(p.deck, resume(p.deck)); }
      // Restore position only for the pair the URL names; a link to another chapter wins.
      if (options.restorePosition && at.pairId === p.id && typeof at.scroll === "number" && Number.isFinite(at.scroll) && at.scroll >= 0) {
        pendingScroll.current = at.scroll;
      } else {
        const section = (st.sections || []).find(s => s.id === p.sectionId);
        if (section && section.firstPage > 1) landOnPage.current = section.firstPage;
        else pendingScroll.current = 0;
      }
    } else if (i >= 0) {
      const p = st.pairs[i];
      holdPair(i + 1, p.id);
      nav.current.route = { kind: "board", board: id, pair: p.id, resource: p.resourceId || undefined };
      if (options.history !== "none") history.replaceState(null, "", location.pathname + routeSearch(nav.current.route));
      if (p.deck) { warmDeck(p.deck); drill.loadDeck(p.deck, at.cardId || resume(p.deck)); }
      if (typeof at.scroll === "number" && Number.isFinite(at.scroll) && at.scroll >= 0) pendingScroll.current = at.scroll;
    } else {
      holdPair(0, null);
      nav.current.route = {kind:"board",board:id};
      if (options.history !== "none") history.replaceState(null,"",location.pathname + routeSearch(nav.current.route));
    }
    return true;
  }
  async function newBoard(q: string) {
    const version = nav.current.version;
    const made = await make(q);
    if (!made) return;
    const { board: b, state } = made;
    setLibraryQuery("");
    if (!nav.current.current(version)) return b;
    navigate({ kind: "board", board: b.id });
    setActiveId(b.id); setBoard(state); holdPair(0, null); showLibrary(false);
    boardNotes.seed(b.id, state); boardNotes.setEditing(false);
    drill.setCards([]); drill.setPos(0); drill.setRevealed(false); drill.setPicked(null); drill.setDeckError(null);
    return b;
  }
  // board_leave is sent as a beacon on pagehide/visibilitychange, which fire reliably where unload doesn't.
  const enteredAt = useRef(0);
  useEffect(() => {
    const id = activeId; if (!id) return;
    enteredAt.current = Date.now();
    const leave = (why: string) => {
      if (!enteredAt.current) return;
      StrataAPI.logBeacon("board_leave", { board: id, ms: Date.now() - enteredAt.current, why });
      enteredAt.current = 0;
    };
    const onHide = () => leave("hide");
    // Hidden stops the clock, so a background tab left overnight doesn't report a twelve-hour read.
    const onVis = () => { if (document.visibilityState === "hidden") leave("hidden"); else enteredAt.current = Date.now(); };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
      leave("switch");
    };
  }, [activeId]);

  // Prefetch at idle and on pointerdown, so the click finds the board's answers already here.
  function warmBoard(id: string, resume?: boolean) {
    if (!id || StrataWireDown()) return;
    if (!PHONE) warmPdf();
    StrataAPI.warmSeen(id).catch(() => {});
    StrataAPI.warmBoard(id).then((st) => {
      if (!st || !resume) return;
      const p = (st.pairs || []).find((x) => x.id === readAt(id).pairId);
      if (p && p.deck) StrataAPI.warmDeck(p.deck).catch(() => {});
    }).catch(() => {});
  }
  function warmTile(t: Wire) {
    const p = t && t.pair != null ? (stateRef.current.pairs || [])[t.pair] : null;
    if (!p || StrataWireDown()) return;
    if (p.deck) StrataAPI.warmDeck(p.deck).catch(() => {});
    if (!PHONE && p.resourceId) warmPdf();
  }

  // Not on mount: nothing is open yet, and the boot may already have landed the library's keeps.
  const boardSeen = useRef(false);
  useEffect(() => {
    if (!boardSeen.current) { boardSeen.current = true; return; }
    const l = landing.current, mine = l && l.board === activeId;
    if (mine) landing.current = null;
    land(mine ? l : {});
  }, [activeId]);

  return { openBoard, newBoard, warmBoard, warmTile };
}
