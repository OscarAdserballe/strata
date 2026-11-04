import { StrataAPI } from "../../data/api.ts";
import { reviewStrip } from "../../data/entities/review.ts";
import { toast } from "../../shell/layers.ts";
import { deckOf } from "../card/saveCard.ts";
import { kickDistil } from "../progress/distil.ts";
import { addSource, showReceipt } from "./AddSource.tsx";

type Wire = any;
type Verb = (...a: any[]) => any;

export interface SourceAnswersRoom {
  now(): { activeId: string | null; pair: Wire; pairIdx: number; solo?: boolean; qDeck?: unknown; card?: Wire };
  drill: Record<"setCards" | "setPos" | "setRevealed" | "setPicked" | "setDecks" | "loadDeck" | "setIgnoredPile" | "setMixed" | "openIgnored" | "setQDeck" | "openPair" | "toggleCardsOnly", Verb>;
  deckCache(): Record<string, unknown> | null;
  setBoard(state: Wire): void;
  setPairIdx(i: number): void;
  /** read as held, not via now().pair, which a store-fed snapshot has already redrawn */
  pairId(): string | null;
  hideShelf(): void;
  setBench(frames: Wire[]): void;
  jumpToAnchor(anchor: string): void;
  libraryUp(): boolean;
}

export function sourceAnswers(room: SourceAnswersRoom) {
  const { now, drill, deckCache, setBoard, setPairIdx, pairId, hideShelf, setBench, jumpToAnchor } = room;
  const firstCard = () => { drill.setPos(0); drill.setRevealed(false); drill.setPicked(null); };
  const blankDrill = () => { drill.setCards([]); firstCard(); };
  const readDecks = () => { StrataAPI.decks().then((cs) => drill.setDecks(cs || [])).catch(() => {}); };

  // asked by the pair's id as held: the store has already redrawn the pairs before this runs
  function syncSourceMutation(id: string, state: Wire, verb: string) {
    if (id === now().activeId) {
      setBoard(state);
      const open = pairId();
      if (open && !(state.pairs || []).some((p: Wire) => p.id === open)) { setPairIdx(0); blankDrill(); }
    }
    if (verb !== "delete" && verb !== "file") return;
    readDecks();
    if (room.libraryUp()) reviewStrip.refresh();
  }

  function landCapture(r: Wire, msg: string | null) {
    setBoard(r.state);
    kickDistil();
    if (!msg) return;
    showReceipt({ board: r.state.board.id, resource: r.resourceId, label: r.title || "Source" });
    toast(msg);
  }

  // the room holds a copy of the deck from before the bench changed it: drop the cache and reload
  function benchDeckChanged(slug: string, standOn?: string | null) {
    const cache = deckCache(); if (cache) delete cache[slug];
    // under a shuffle or question deck, moving the position would move the deck on screen
    const s = now(), cur = s.pair && s.pair.deck, aside = !!(s.solo || s.qDeck);
    if (cur && deckOf({ deck: cur }) === slug) drill.loadDeck(cur, aside ? null : standOn || (s.card && s.card.id), aside);
    readDecks();
  }

  // guarded: a bench opened from the library can stand over a board that is not the open one
  function boardState(st: Wire) {
    if (st && st.board && st.board.id === now().activeId) setBoard(st);
  }

  function asideDone(slugs: string[], restore: boolean) {
    const s = now();
    const cache = deckCache();
    if (cache) for (const sl of slugs) delete cache[sl];
    drill.setIgnoredPile(null);
    if (!restore) drill.setMixed((ms: Wire[]) => ms.filter((c) => !slugs.includes(String(c.deck || "").split("/")[0])));
    readDecks();
    const cur = s.pair && s.pair.deck;
    if (cur && slugs.includes(cur)) {
      if (restore) drill.loadDeck(cur, null);
      else blankDrill();
    }
  }

  function keepTile(t: Wire) {
    if (t.keepBoard) { hideShelf(); setBench([{ board: true }]); return; }
    if (!t.keep) return;
    hideShelf();
    setBench([{ slug: t.keep, title: t.label || t.keep }]);
  }

  function openTile(t: Wire) {
    hideShelf();
    if (t.add === "file") { addSource.file(null); return; }
    if (t.add === "link") { addSource.link(null); return; }
    if (t.ignoredPile) { drill.openIgnored(); return; }
    if (t.qgroup) { drill.setQDeck({ kind: t.qgroup.kind, name: t.qgroup.name }); setPairIdx(0); firstCard(); return; }
    if (t.pair == null) return;
    // the reader's: this closure may be older than its last flip
    const s = now();
    if (s.solo) drill.toggleCardsOnly(false);
    if (s.qDeck) drill.setQDeck(null);
    // a page tile inside the open pair is a jump; re-opening would reset the deck to card one
    if (t.jump && t.pair === s.pairIdx) { jumpToAnchor("p. " + t.jump); return; }
    drill.openPair(t.pair);
    if (t.jump) setTimeout(() => jumpToAnchor("p. " + t.jump), 80);
  }

  return { syncSourceMutation, landCapture, benchDeckChanged, boardState, asideDone, keepTile, openTile };
}
