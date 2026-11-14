import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { StrataAPI, StrataAnswer, StrataWhy, whenQuiet, wireQuiet } from "../data/api.ts";
import { store as roomStore } from "../data/store.ts";
import { applyBoardState, boardKey, useBoardView } from "../data/entities/boards.ts";
import { AddSourceHost, ImportReceipt, captureOpen, closeCapture } from "../capabilities/sources/AddSource.tsx";
import { DropZone, filesDrop } from "../capabilities/sources/drop.tsx";
import StatusBar, { signOut as leaveRoom } from "./StatusBar.tsx";
import ReaderBar from "../surfaces/reader/ReaderBar.tsx";
import Layers from "./Layers.tsx";
import { toast } from "./layers.ts";
import { BoardPickerHost, addSourceFrom, pickerNow, setPicker } from "../capabilities/sources/BoardPicker.tsx";
import Ask from "../capabilities/ask/Ask.tsx";
import { askIsOpen, closeAsk, openAsk } from "../capabilities/ask/control.ts";
import { threadFor } from "../capabilities/ask/useThread.ts";
import { DownloadButton, downloadBoard } from "../capabilities/offline/DownloadBoard.tsx";
import BoardSurface from "../surfaces/board/BoardSurface.tsx";
import { boardNotes, installNotesLeave } from "../surfaces/board/boardNotes.ts";
import { boardPage as sheets } from "../surfaces/board/summon.ts";
import { useSourceActions } from "../capabilities/sources/useSourceActions.ts";
import { useBoardActions } from "../capabilities/sources/useBoardActions.ts";
import { boardContainment, mintedToCards } from "../capabilities/card/authored.ts";
import Composer from "../capabilities/card/Composer.tsx";
import { setComposer, useComposer } from "../capabilities/card/composing.ts";
import { bindCardRoom, captureReply, openComposer, saveComposed } from "../capabilities/card/doors.ts";
import { closeTopLayer, openKeysSheet } from "../capabilities/keys/registry.ts";
import { navigation } from "./routes.ts";
import { CRAM, KEEPS, LIBRARY, REVIEW, closeKeeps, hideBoardPage, openCram, openLibrary, panelOpen, screensNow, setKeeps, setKeepsEditing, setLibrary, showBoardPage, toggleKeeps, useScreensUp } from "./screens.ts";
import { bindRoom, holdBoard, roomHost, type RoomHostName } from "./room.ts";
import { useAdminPath } from "./session.ts";
import { useBoardNavigation } from "./boardNavigation.ts";
import { choosePair, pairIdNow, pairIndex, usePairInHand } from "./pair.ts";
import { ROOM } from "../engines/zoom/zoom.ts";
import { useRoomScale } from "./scale.ts";
import { drill, drillNow, readerNow, useShown } from "../surfaces/reader/handle.ts";
import { boardNow, holdBoardHand, type BoardHand } from "../surfaces/board/handle.ts";
import ReaderSurface from "../surfaces/reader/ReaderSurface.tsx";
import { readAt, type HeldPlace, type useSourceColumn } from "../surfaces/reader/useSourceColumn.ts";
import type { HeldPair } from "../surfaces/reader/useDrill.ts";
import type { ResourceMeta, Section } from "../../shared/types/index.ts";
import { useRoomKeys, type RoomKeyActions } from "../capabilities/keys/room-keys.ts";
import { distilWorkOf, generateCards, isUnstudied, kickDistil, retryDistil, useDistilPoll } from "../capabilities/progress/distil.ts";
import { sourceAnswers } from "../capabilities/sources/answers.ts";
import { warmKeeps } from "../surfaces/keeps/keeps-load.ts";
import { warmCram } from "../surfaces/cram/cram-load.ts";

// Warm the keeps and cram chunks only once the wire is quiet, so they don't compete with a board's own reads.
const warmKeyed = (): void => { warmKeeps(); warmCram(); };
/** Falls back to running at once where requestIdleCallback is missing (Safari). */
function warmWhenQuiet(): () => void {
  let stop = (): void => {};
  const wait = (): void => {
    stop = whenQuiet(() => {
      if (typeof requestIdleCallback !== "function") { warmKeyed(); return; }
      const h = requestIdleCallback(() => (wireQuiet() ? warmKeyed() : wait()), { timeout: 2000 });
      stop = () => cancelIdleCallback(h);
    });
  };
  wait();
  return () => stop();
}

type Wire = any;

function feedBoard(st: Wire): void {
  if (!st || !st.board || typeof st.board.id !== "string") return;
  const meta = StrataAnswer(st);
  applyBoardState(st, meta ?? { epoch: roomStore.entry(boardKey(st.board.id))?.epoch ?? "" });
}

function RoomAsk({ askKey, onHome, onCompose, boardId, name }: { askKey: string | null; onHome: boolean; onCompose: (question: string, answer: string) => void; boardId: string | null; name: string }) {
  const solo = useShown("solo"), splitW = useShown("splitW");
  return <Ask frame="room" thread={askKey} solo={solo} splitW={splitW}
    placeholder={solo ? "ask about the card…" : onHome ? "ask about this board…" : "ask about the page…"}
    onCompose={onCompose} feedback={{ board: boardId || null }} name={name} />;
}

export default function BoardRoute() {
  const adminPath = useAdminPath();
  const up = useScreensUp();
  const launcher = !!(up & LIBRARY), reviewing = !!(up & REVIEW), cramming = !!(up & CRAM), keepsUp = !!(up & KEEPS);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Read from the store, so a stale answer for another board can't overwrite this one.
  const board: Wire = useBoardView(activeId);
  const nav = useRef(navigation);
  function setBoard(next: Wire) { feedBoard(next); }
  const heldPair = usePairInHand();
  const [followChapters, setFollowChapters] = useState(()=>localStorage.getItem("strata.followChapters")==="1");
  const [loading, setLoading] = useState(true);
  const composer = useComposer();
  const deckRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<Wire>({});
  const current = () => stateRef.current.activeId;
  const [ui, stepUi] = useRoomScale(current, deckRef, loading);
  const solo = useShown("solo");
  const soloLine = useShown("soloLine");
  const { openPair, toggleCardsOnly } = drill;
  const HOME = { id: "home", label: "home", isHome: true, resourceId: null, deck: null };
  const pairs = [HOME, ...((board && board.pairs) || [])];
  const pairIdx = pairIndex(pairs, heldPair);
  const pair = pairs[pairIdx] || HOME;
  const onHome = !!pair.isHome;
  const src: ResourceMeta | null = pair.resourceId && board
    ? (board.resources || []).find((r: ResourceMeta) => r.id === pair.resourceId) || null
    : null;
  const sectionOfPair = (p: HeldPair | null | undefined): Section | null => (p && p.sectionId && board)
    ? ((board.sections || []).find((s: Section) => s.id === p.sectionId) || null) : null;
  const sectionsHere: Section[] = (src && board)
    ? (board.sections || []).filter((s: Section) => s.resourceId === src.id).sort((a: Section, b: Section) => a.ord - b.ord)
    : [];
  const openSection = sectionOfPair(pair);
  const mine = mintedToCards((board && board.minted) || [], activeId as string);
  const { qGroups, inDrill } = boardContainment(mine);
  const mintOpenCard = (c: Wire) => openComposer(c.front, (c.meta && c.meta.answer) || "", c);
  const threadRid = (!onHome && pair.resourceId) || null;
  const askKey = activeId ? threadFor(threadRid ? "source" : "board", { surface: onHome ? "board" : "reader", board: activeId, source: threadRid }) : null;
  const hand: BoardHand & Record<string, unknown> = stateRef.current = { activeId, board, pairs, pair, pairIdx, onHome, src, composer,
    get go() { return pickerNow(); }, get capture() { return captureOpen(); }, get launcher() { return screensNow().library; },
    get bench() { const f = screensNow().keeps; return f.length ? f : null; }, get benchEdit() { return screensNow().keepsEditing; },
    get sheetsOver() { return sheets.over(); },
    ui, mine, openSection, sectionsHere, loading, followChapters };
  holdBoardHand(hand);

  const reader = useRef<HeldPlace & { col?: ReturnType<typeof useSourceColumn>; acts: Record<string, unknown> }>({ pageRef: { current: null }, pendingScroll: { current: null }, landOnPage: { current: null }, readerTop: { current: 0 }, acts: {} }).current;
  const { pageRef } = reader;

  const { openBoard, newBoard, warmBoard, warmTile } = useBoardNavigation({
    nav, stateRef, activeId, place: reader, setActiveId, setBoard, setLoading, toast, make: (q) => boardActions.create(q) });

  useEffect(() => { boardNotes.onFailed((e) => toastWhy(e, "the log didn't save")); return installNotesLeave(); }, []);
  const boardDrawn = !!board;
  useEffect(() => (boardDrawn ? warmWhenQuiet() : undefined), [boardDrawn]);
  useEffect(() => {
    let stop: (() => void) | undefined;
    const first = (): void => { removeEventListener("pointerdown", first, true); stop = warmWhenQuiet(); };
    addEventListener("pointerdown", first, true);
    return () => { removeEventListener("pointerdown", first, true); stop?.(); };
  }, []);

  const sourceRoom = {
    live: () => stateRef.current,
    standOn: (i: number) => { drill.setPos(i); drill.setRevealed(false); drill.setPicked(null); },
    openPair,
    toast, toastWhy, reread: rereadBoard,
    redistil: (id: string, rid: string) => sourceActions.redistil(id, rid), panelOpen,
  };
  const jumpToAnchor = (a: string) => reader.col!.tree.jumpToAnchor(a);

  // A write abandoned after retries may still have landed, so re-read what the server holds.
  function rereadBoard(bid: string) {
    StrataAPI.getBoard(bid).then((st) => { if (current() === bid) setBoard(st); }).catch(() => {});
  }
  function toastWhy(e: unknown, said: string) { console.warn("[strata]", said, e); toast(StrataWhy(e, said), 4200); }

  const signOut = () => leaveRoom((e) => toastWhy(e, "couldn't sign out"));
  const keepBoardOffline = () => downloadBoard(current(), stateRef.current.board, { toast, toastWhy });
  const benchRestoreCard = (c: Wire) => drill.undeleteCard(c, null);
  const deskHome = (emptyColumn: boolean) => onHome && emptyColumn && !composer;

  const { syncSourceMutation, landCapture, benchDeckChanged, boardState: benchBoardState, asideDone, keepTile, openTile } = sourceAnswers({
    now: () => stateRef.current, drill, deckCache: () => drillNow()?.deckCacheRef.current ?? null,
    setBoard, setPairIdx: choosePair, pairId: pairIdNow, hideShelf: hideBoardPage, setBench: setKeeps, jumpToAnchor,
    libraryUp: () => screensNow().library,
  });
  const sourceActions = useSourceActions({ onState: syncSourceMutation, onError: toastWhy });
  const boardActions = useBoardActions({
    onState: (id, st) => { if (id === current()) setBoard(st); },
    onError: toastWhy,
    onDeleted: (id) => { if (id === current()) { setActiveId(null); setLibrary(true); } },
  });

  useRoomKeys({
    board: boardNow, reader: readerNow, pageRef,
    driftRef: { get current() { return reader.col && reader.col.chapters.driftRef.current; } },
    actions: Object.assign(reader.acts, {
      setCapture: closeCapture, openKeysSheet, setGo: setPicker, setComposer, openAsk, closeAsk, askIsOpen,
      setRevealed: drill.setRevealed, setLauncher: setLibrary,
      panelOpen, hideShelf: hideBoardPage, showShelf: showBoardPage, toggleCardsOnly, stepUi,
      mintCapture: captureReply, mintOpenCard, move: drill.move, answer: drill.answer, gradeCard: drill.gradeCard, goToCardSource: drill.goToCardSource,
      setEditing: drill.setEditing, setBenchEdit: setKeepsEditing, toggleBench: toggleKeeps, closeBench: closeKeeps, closeTopLayer,
      logCard: drill.logCard, openCram, log: StrataAPI.log, warmKeyed,
    }) as unknown as RoomKeyActions,
  }, () => stateRef.current);

  const addSourceHere = (kind: "file" | "link") => addSourceFrom(kind, { activeId: current(), libraryUp: false, newBoard });
  const pickAddSource = (kind: "file" | "link", study = true) => addSourceFrom(kind, { activeId: current(), libraryUp: screensNow().library, newBoard }, study);

  const distilWork = distilWorkOf(board);
  useDistilPoll(activeId, distilWork, launcher || reviewing, { pair: () => stateRef.current.pair, setBoard, drill });

  const drillRoom = { toast, toastWhy, hideShelf: hideBoardPage, setSheetsPin: (on: boolean) => (on ? sheets.show(true) : sheets.unpin()), setSheetsDone: (done: boolean) => sheets.finished(done), setBench: setKeeps, setPairIdx: choosePair, setEditingNote: (on: boolean) => boardNotes.setEditing(on),
    benchDeckChanged, mintOpenCard, sectionOfPair, readAt };

  const panesRef = useRef<HTMLDivElement | null>(null);
  const panesDrag = useRef(filesDrop(() => panesRef.current, current)).current;
  bindCardRoom({
    activeId: current, setBoard, patchCard: drill.patchCardEverywhere, clearColumn: hideBoardPage,
    deckGrew: (deck) => { if ((stateRef.current.pair || {}).deck === deck) void drill.loadDeck(deck, null, true); },
    at: () => ({ pair: stateRef.current.pair, askKey, page: pageRef.current, prose: reader.col?.proseRef.current ?? null }),
  });
  bindRoom({
    activeId: current,
    openBoard, newBoard, warmBoard, sourceMutated: syncSourceMutation, boardState: benchBoardState,
    deckChanged: benchDeckChanged, deleteCard: drill.reviewDeleteCard, restoreCard: benchRestoreCard,
    goToCardSource: drill.goToCardSource, deckCards: drill.deckCards,
    boardActions, panesDrag, toastWhy,
  });
  useLayoutEffect(() => { holdBoard({ id: activeId, board }); }, [activeId, board]);

  if (loading) return <div className="boot">Loading…</div>;

  const boardTitle = (board && board.board && board.board.title) || "Strata";
  // a source open with no screen over it gets the reader's bar; everything else keeps the room's
  const reading = !onHome && !solo && !launcher && !reviewing && !cramming && !keepsUp;
  const deskTools = <DownloadButton boardId={activeId} onDownload={keepBoardOffline} />;
  const cardWork = src && distilWork.busy.find((w) => w.r.id === src.id);
  const onGenerate = src && !cardWork && isUnstudied(board, src.id) ? () => generateCards(current(), src, sourceActions.redistil) : null;

  const roomComposer = composer && !composer.fold && !reviewing && !cramming && !keepsUp
    ? <Composer front0={composer.front} answer={composer.answer} anchor={composer.anchor}
        closing={!!composer.mintId} review={false} onSave={saveComposed} onCancel={() => setComposer(null)} /> : null;
  const host = (name: RoomHostName) => <div ref={roomHost(name)} className="room-host" data-host={name} style={{ display: "contents" }} />;

  // `--room` is published so the chat can counter-zoom itself out of the room's scale.
  return (
    <div className="app" style={{ zoom: String(ui * ROOM), "--room": String(ROOM) } as React.CSSProperties}>
      {reading && src
        ? <ReaderBar board={boardTitle} file={src.filename} kind={src.kind} onHome={() => openPair(0)}
        onBoards={openLibrary}
        onAdd={pickAddSource}
        imports={!keepsUp && !cramming && !launcher} onImport={(b, r) => openBoard(b, r)}
        follow={!onHome && openSection ? followChapters : null}
        onFollow={() => setFollowChapters(on=>{localStorage.setItem("strata.followChapters",on?"0":"1");return !on;})}
        onNewCard={() => openComposer("", "")} adminPath={adminPath} onSignOut={signOut} />
        : <StatusBar onBoards={openLibrary}
        homeOff={onHome && !solo} onHome={() => { if (stateRef.current.solo) toggleCardsOnly(false); openPair(0); }}
        onAdd={pickAddSource}
        solo={soloLine}
        imports={!keepsUp && !cramming && !launcher} onImport={(b, r) => openBoard(b, r)}
        follow={!onHome && openSection ? followChapters : null}
        onFollow={() => setFollowChapters(on=>{localStorage.setItem("strata.followChapters",on?"0":"1");return !on;})}
        onNewCard={() => openComposer("", "")} adminPath={adminPath} onSignOut={signOut} />}

      <div className={"panes" + (solo ? " solo" : "")} ref={panesRef}
        onDragOver={panesDrag.onDragOver} onDragLeave={panesDrag.onDragLeave} onDrop={panesDrag.onDrop}>
        <DropZone />

        <ReaderSurface live={stateRef} nav={nav} boardId={activeId} board={board} src={src} pair={pair} ui={ui}
          inDrill={inDrill} qGroups={qGroups} deckRef={deckRef}
          composer={roomComposer} cardWork={cardWork ?? null} onGenerate={onGenerate}
          onMintOpen={mintOpenCard} onBench={toggleKeeps} onBenchWarm={warmKeeps}
          source={sourceRoom} held={reader} room={drillRoom} onHome={onHome} openSection={openSection}
          overlays={(col, d) => <>
        <BoardSurface boardId={activeId} board={board} title={boardTitle} decks={d.decks} pairs={pairs} pairIdx={pairIdx}
          qDeck={d.qDeck} qGroups={d.qGroups} solo={d.solo} driftSection={col.chapters.driftSection} deskHome={deskHome(d.emptyColumn)}
          distilWork={distilWork}
          sourceActions={sourceActions} boardActions={boardActions} tools={deskTools} pageRef={pageRef}
          current={current} onBoardState={setBoard} onReread={rereadBoard} toast={toast} toastWhy={toastWhy}
          onBack={hideBoardPage} onBoards={openLibrary} onWarm={warmTile} onCram={openCram} onCramWarm={warmCram}
          onAdd={addSourceHere} onRetryDistil={(r: Wire) => retryDistil(current(), r, sourceActions.redistil)} onOpenTile={openTile} onKeep={keepTile} onKeepWarm={warmKeeps}
          onRedistilled={kickDistil} onAsideDone={asideDone} />
        {host("panes")}
          </>} />

        {/* a source open asks under its words, in its folds: the dock is the board's */}
        {launcher || reviewing || cramming || keepsUp || (!onHome && src) ? null : <RoomAsk askKey={askKey} onHome={onHome}
          onCompose={openComposer} boardId={activeId}
          name={threadRid && src ? `${src.filename} — its thread` : "this board’s thread"} />}
      </div>

      <Layers slots={{
        veil: <>
          {host("library")}
          <BoardPickerHost />
          {host("veil")}
        </>,
        "bench-lib": host("bench-lib"),
        capture: <AddSourceHost current={current} landed={landCapture} toast={toast} toastWhy={toastWhy} />,
        receipt: <ImportReceipt onOpen={(b, r) => void openBoard(b, r)} />,
      }} esc={{
        "ask-dock": { open: askIsOpen, close: closeAsk },
      }} />
    </div>
  );
}
