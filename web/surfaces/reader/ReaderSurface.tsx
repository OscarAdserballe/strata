import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import { StrataWhy } from "../../data/api.ts";
import { grades } from "../../data/entities/grades.ts";
import CardFrame, { type FrameCard } from "../../capabilities/card/CardFrame.tsx";
import type { FaceCard } from "../../capabilities/card/CardFace.tsx";
import type { CardFaces } from "../../../shared/cards/card-tidy.ts";
import { editCard } from "../../capabilities/card/doors.ts";
import type { BoardState, DeckSummary, ResourceMeta } from "../../../shared/types/index.ts";
import type { Navigation } from "../../shell/routes.ts";
import CardProgress, { type DistilBusy } from "../../capabilities/progress/DistilProgress.tsx";
import { TreeView } from "../../engines/tree/TreeView.tsx";
import { FIND_CAP } from "../../engines/find/find.ts";
import SelectionMenu from "../../capabilities/annotate/SelectionMenu.tsx";
import { drillView, useCardInHand, useDrill } from "./useDrill.ts";
import type { DrillCard, DrillLive, DrillRoom, HeldPair } from "./useDrill.ts";
import { useSplit } from "./split.ts";
import { bindDrill, drillMounted, holdReaderHand, publishShown } from "./handle.ts";
import { holdDecks } from "../../shell/room.ts";
import { useSourceColumn } from "./useSourceColumn.ts";
import type { HeldPlace, SourceRoom } from "./useSourceColumn.ts";
import { useReaderHere } from "./here.ts";
import HtmlSource from "../../capabilities/live/HtmlSource.tsx";
import { drawnAs } from "../../engines/html/drawn.ts";
import { ROOM } from "../../engines/zoom/zoom.ts";
import { switches } from "../../capabilities/fold/switches.ts";
import { handSlot } from "../../capabilities/fold/hand.ts";
import { turned } from "../../capabilities/fold/turned.ts";
import { answered } from "../../capabilities/fold/answered.ts";
import { barSlot } from "./barSlot.ts";
import FoldSays from "../../capabilities/fold/FoldSays.tsx";
import CardFace from "../../capabilities/card/CardFace.tsx";

type Ref<T> = MutableRefObject<T>;

export interface QGroup { kind: string; name: string; cards: DrillCard[] }

export type DrillBoardSide = Omit<DrillRoom, "setTreeOpen" | "jumpToCard" | keyof HeldPlace | "keepReaderTop" | "landNow">;

export interface ReaderOverlaid {
  qDeck: { kind: string; name: string } | null;
  qGroups: QGroup[];
  solo: boolean;
  decks: DeckSummary[];
  emptyColumn: boolean;
}

export interface ReaderSurfaceProps {
  live: Ref<DrillLive>;
  nav: Ref<Navigation>;
  boardId: string | null;
  board: BoardState | null;
  src: ResourceMeta | null;
  pair: HeldPair;
  ui: number;
  inDrill: DrillCard[];
  qGroups: QGroup[];
  deckRef: Ref<HTMLDivElement | null>;
  composer: ReactNode;
  cardWork: DistilBusy | null;
  /** set when the source arrived without cards; the column stays away until there are some */
  onGenerate: (() => Promise<boolean>) | null;
  onMintOpen: (c: FaceCard) => void;
  onBench: () => void;
  onBenchWarm: () => void;
  overlays: (column: ReturnType<typeof useSourceColumn>, drill: ReaderOverlaid) => ReactNode;
  source: SourceRoom;
  held: HeldPlace & { col?: ReturnType<typeof useSourceColumn>; acts: Record<string, unknown> };
  room: DrillBoardSide;
  onHome: boolean;
  openSection: { id: string } | null;
}
function DrillGradeAlert() {
  const s = useSyncExternalStore(grades.subscribe, grades.getSnapshot);
  if (!s.error) return null;
  return <p role="alert" className="drill-grade-alert">
    {StrataWhy(s.error, s.pending > 1 ? `${s.pending} grades haven't saved` : "a grade hasn't saved")}{" "}
    <button className="seg" onClick={() => grades.retry()}>Retry saving grades</button></p>;
}

// stays "Starting…" once it worked: the progress over the page takes its place
function GenerateCards({ onGenerate }: { onGenerate: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return <button className="gen-cards" disabled={busy} onClick={() => { setBusy(true); void onGenerate().then((ok) => { if (!ok) setBusy(false); }); }}>
    {busy ? "Starting…" : "Generate flashcards"}</button>;
}

// after the questions: the page where you choose what of this source to keep
function KeepDoor({ keep, done, total, onBench, onBenchWarm }: { keep: { kept?: number; total?: number; benched?: boolean } | null | undefined;
  done: number; total: number; onBench: () => void; onBenchWarm: () => void }) {
  const benched = !!keep?.benched, through = done >= total;
  return (
    <button type="button" className={"rbar-keep jn-rev" + (benched ? " full" : through ? " next" : "")}
      title={benched ? `reviewed — ${keep?.kept ?? 0} kept of ${keep?.total ?? total}` : through ? "every question is answered — choose what to keep (r)" : `${done} of ${total} answered — then choose what to keep (r)`}
      onMouseDown={(e) => e.preventDefault()} onPointerEnter={onBenchWarm} onPointerDown={onBenchWarm} onClick={onBench}>
      {benched ? `★ ${keep?.kept ?? 0} kept` : through ? "choose what to keep" : `${done}/${total} · keep`}
    </button>
  );
}

export default function ReaderSurface(props: ReaderSurfaceProps) {
  const { deckRef, boardId: activeId, board, src, pair, inDrill, composer, cardWork, onGenerate, onMintOpen,
    onBench, onBenchWarm, overlays, source, held, onHome, openSection } = props;
  const drillRoom = useRef({} as DrillRoom).current;
  Object.assign(drillRoom, props.room);
  const drill = useDrill(drillRoom, { stateRef: props.live, nav: props.nav, activeId, board });
  bindDrill(drill);
  const { splitW, startSplit } = useSplit(props.ui);
  const { decks, cards, pos, revealed, picked, cardsOnly: solo, mixed, mixing, qDeck, ignoredPile, editing, deckError } = drill;
  const qGroups = ignoredPile && ignoredPile.board === activeId && ignoredPile.cards.length
    ? [...props.qGroups, { kind: "ignored", name: "ignored", cards: ignoredPile.cards }] : props.qGroups;
  const openQ = qDeck ? (qGroups.find((g) => g.name === qDeck.name) || null) : null;
  const view = drillView({ openQ, inDrill, solo, mixed, cards, pos, revealed, picked, decks, pair });
  const { deck, card, done, passes, passNo, cardKeep } = view;
  const cardActs = { seek: drill.seek, reveal: () => { drill.setRevealed(true); drill.logCard("card_reveal"); }, grade: drill.gradeCard, gradeAt: drill.gradeAt, move: drill.move };
  const here = Object.assign(source.live(), { card, done, revealed, pos, cards: deck, cardsAll: cards, decks, cardsOnly: solo, solo, passNo, passes, qGroups, qDeck, editing, splitW, cardActs });
  const column = held.col = useSourceColumn(source, here, held);
  const { marks, finder, chapters } = column;
  holdReaderHand(Object.assign(here, { treeOpen: column.treeOpen, pz: column.pz, openMark: marks.openMark, find: finder.find }));
  Object.assign(held.acts, { setTreeOpen: column.flipTree, setOpenMark: marks.setOpenMark, openFind: finder.openFind, closeFind: finder.closeFind,
    stepHistory: marks.stepHistory, jumpToCard: column.tree.jumpToCard, adoptDrift: chapters.adoptDrift });
  Object.assign(drillRoom, column.place, { setTreeOpen: column.setTreeOpen, jumpToCard: column.tree.jumpToCard });
  useCardInHand(drill, card, solo);
  const soloLine = solo ? (mixing ? "shuffling…" : `cards only · ${deck.length} cards · esc brings the pages back`) : null;
  useLayoutEffect(() => { publishShown({ solo, soloLine, splitW }); }, [solo, soloLine, splitW]);
  useLayoutEffect(() => { holdDecks(decks); }, [decks]);
  useLayoutEffect(() => { switches.count("cards", src ? deck.length : 0); }, [src && src.id, deck.length]);
  useLayoutEffect(() => { drillMounted(); }, []);
  // start loading the keeps chunk two cards before the end, so draining the deck finds it ready
  const benchAhead = !qDeck && !solo && !!pair.deck && deck.length > 2 && pos >= deck.length - 2;
  useEffect(() => { if (benchAhead) onBenchWarm(); }, [benchAhead, onBenchWarm]);
  useReaderHere(here, chapters, drill.shownAt);
  const { answer, touchAdvance, gradeCard, jumpCard, restoreCard, reviewDeleteCard, undeleteCard,
    seek, seenIds, setEditing, deckTouchStart, deckTouchEnd } = drill;
  const { pageRef, proseRef, pdfHostRef, pz, showTree, trees, tree } = column;
  const { find, findInputRef, findQuery: onFindQuery, findStep, closeFind } = finder;
  // each card is drawn in its passage's sheet; the column holds only cards-only, writing, editing and card work
  const slots = useSyncExternalStore(handSlot.subscribe, handSlot.get);
  useSyncExternalStore(turned.subscribe, turned.getSnapshot);
  // a side turned with the keys stays up in the sheet when the hand moves on, and one turned in a sheet is up for the keys
  useEffect(() => { if (card && revealed) turned.add(pair.deck, card.id); }, [card && card.id, revealed, pair.deck]);
  useEffect(() => { if (card && !revealed && card.type !== "mcq" && turned.has(pair.deck, card.id)) drill.setRevealed(true); }, [card && card.id]);
  const bar = useSyncExternalStore(barSlot.subscribe, barSlot.get);
  const columnUp = solo || !!composer || (!!card && editing === card.id) || !!deckError || (!src && !onHome) || onHome;
  const bare = !columnUp;
  return (
    <>
      {/* minWidth comes along so the stylesheet's 380px floor yields exactly when the clamp does */}
      <div className={"deck" + (solo ? " solo" : "")} style={solo ? undefined : bare ? { display: "none" } : { width: splitW, minWidth: Math.min(380, splitW) }}
        ref={deckRef} onTouchStart={deckTouchStart} onTouchEnd={deckTouchEnd}>
        {composer
          ? composer
          : card && (solo || editing === card.id)
          ? <CardFrame card={card} cards={deck} pos={pos} revealed={revealed} picked={picked}
              src={solo ? null : src} solo={solo} onPick={answer} onMintOpen={onMintOpen}
              onSpace={touchAdvance} onGrade={gradeCard} onJump={jumpCard} boardId={activeId}
              onRestore={openQ && openQ.kind === "ignored" ? restoreCard : null}
              keep={cardKeep}
              editing={editing === card.id} onEditOpen={(c) => setEditing(c ? c.id : null)}
              onEditSave={(c: FrameCard, patch: CardFaces) => editCard(c, patch, drill)}
              onDelete={openQ ? null : reviewDeleteCard} onUndelete={undeleteCard}
              seen={seenIds} onSeek={seek} onBench={onBench} onBenchWarm={onBenchWarm} />
          : solo
            ? <div className="card-empty">{mixing ? "shuffling the board…" : "Nothing to drill — no page on this board has a deck yet."}</div>
          : deckError
            ? <div className="card-empty">Couldn’t load that deck — it may not be in <code>courses/</code>.</div>
            : null}
      </div>
      {bar && pair.deck && deck.length > 0 && !solo ? createPortal(<KeepDoor keep={cardKeep} done={deck.filter((c) => answered.of(pair.deck, c.id) !== null).length}
        total={deck.length} onBench={onBench} onBenchWarm={onBenchWarm} />, bar) : null}
      {solo ? null : [...slots].map(([id, at]) => {
        const c = deck.find((x) => x.id === id);
        if (!c) return null;
        const inHand = !!card && card.id === id;
        return createPortal(<CardFace card={c} revealed={(inHand && revealed) || turned.has(pair.deck, id)} picked={inHand ? picked : null} onPick={inHand ? answer : undefined} />, at, id);
      })}
      {solo ? null : <FoldSays />}

      {overlays(column, { qDeck, qGroups, solo, decks, emptyColumn: !card && !deckError && !solo })}
      {!solo && !bare ? <div className="split" onPointerDown={startSplit} title="drag to resize"><i /></div> : null}

      <div className="pagewrap" style={solo ? { display: "none" } : undefined}>
        {/* zoom sits on the scroll container so scrollTop, offsetTop and clientWidth share one coordinate space */}
        <div className="page" ref={pageRef} data-hand={card ? card.id : undefined} style={pz !== 1 ? ({ zoom: String(pz), "--pz": String(pz) } as CSSProperties) : undefined} onMouseDown={marks.onReaderDown} onClick={marks.onReaderClick}>
          {/* the sheets notes, cards and asks lie on, over the page: filled by the source's adapter, never by React */}
          <div className="layer-plane" style={onHome || showTree ? { display: "none" } : undefined} />
          {showTree
            ? <TreeView state={openSection ? trees[openSection.id] : null} src={src} cards={drill.cards}
                onAnchor={tree.jumpToAnchor} onCards={tree.goToCard} onDistil={tree.distilNow}
                onClose={() => column.flipTree(false)} />
            : null}
          {/* written by useSourceColumn, not React: painted marks split text nodes React would rejoin */}
          {!onHome && !showTree && src && src.kind !== "pdf" && drawnAs(src.kind) !== "html"
            ? <div className="page-col prose marked" ref={proseRef} />
            : null}
          {!onHome && !showTree && src && column.live.url
            ? <HtmlSource engine={column.live.engine} url={column.live.url} title={src.filename} scale={props.ui * ROOM * pz} />
            : null}
          {/* React never renders children here, so pdf.js canvases survive re-renders */}
          <div ref={pdfHostRef} style={{ display: !onHome && !showTree && src && src.kind === "pdf" ? "block" : "none" }} />
          {!onHome && !src ? <div className="page-col prose"><p className="empty">A blank pair — no source. The cards are on the left; drop a PDF or markdown file here, or press <kbd>h</kbd> to capture one from a link.</p></div> : null}
          {marks.selMenu && !solo ? <SelectionMenu at={marks.selMenu} onNote={() => void marks.markSelection(true)} onAsk={marks.askSelection} onCard={marks.cardSelection} /> : null}
        </div>
        {onGenerate && bare && !find && !showTree ? <GenerateCards onGenerate={onGenerate} /> : null}
        {/* the cards being made for this source: over the page they will fold into, not in a column of their own */}
        {cardWork && !solo && !onHome && !showTree ? <div className="gen-progress"><CardProgress key={cardWork.r.id} work={cardWork} compact /></div> : null}
        <DrillGradeAlert />
        {/* nav buttons swallow mousedown so the input keeps focus */}
        {find && !onHome && src
          ? <div className="findbar">
              <input ref={findInputRef} value={find.q} placeholder="find in the source" autoFocus
                spellCheck={false} autoCorrect="off" autoCapitalize="off"
                onChange={(e) => onFindQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
                  else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
                }} />
              <span className="fb-n">{
                find.q.trim().length < 2 ? ""
                : find.missing ? "no text in this source"
                : !find.hits.length ? "0"
                : `${find.at + 1} / ${find.hits.length}${find.hits.length >= FIND_CAP ? "+" : ""}${find.hits[find.at] && find.hits[find.at].page ? " · p. " + find.hits[find.at].page : ""}`
              }</span>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => findStep(-1)} title="previous (⇧↵)">↑</button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={() => findStep(1)} title="next (↵)">↓</button>
              <button onMouseDown={(e) => e.preventDefault()} onClick={closeFind} title="close (esc)">✕</button>
            </div>
          : null}
      </div>
    </>
  );
}
