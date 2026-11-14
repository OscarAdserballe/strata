import { useEffect, useLayoutEffect, useRef } from "react";
import { StrataAPI, StrataAnswer, StrataWhy } from "../../data/api.ts";
import { store as roomStore } from "../../data/store.ts";
import { applyBoardState, boardKey, marksKey, useBoardView } from "../../data/entities/boards.ts";
import type { HtmlEngine } from "../../engines/html/HtmlEngine.ts";
import { sourceAdapters } from "../../engines/source/adapter.ts";
import { toast } from "../../shell/layers.ts";
import { marksOn, useMarks } from "../annotate/useMarks.ts";
import SelectionMenu from "../annotate/SelectionMenu.tsx";
import { paintFolds, type FoldHost } from "../fold/folds.ts";
import { switches } from "../fold/switches.ts";
import HtmlSource from "./HtmlSource.tsx";
import { liveEngine, liveUrlOf, noteFolds, NOTES_ONLY, paintLiveMarks, type LiveAt } from "./live.ts";

export interface LivePageProps {
  board: string;
  resource: string;
  /** the room's zoom the page sits under, which it undoes to draw at the browser's own scale */
  scale?: number;
  /** how tall the page draws itself, for a host that fits its sheet to it */
  onHeight?(h: number): void;
}

const NO_EL = { current: null };
const NO_DOC = { current: { maps: [] as number[][], text: "" } };

/** One live HTML source, read for its notes outside the room: the room's reader wiring with no deck, asks or chapters. */
export default function LivePage({ board, resource, scale = 1, onHeight }: LivePageProps) {
  const view = useBoardView(board);
  useEffect(() => {
    if (roomStore.entry(boardKey(board))?.held) return;
    StrataAPI.getBoard(board).then((st) => { applyBoardState(st, StrataAnswer(st) ?? {}); }).catch(() => {});
  }, [board]);
  const src = view?.resources?.find((r) => r.id === resource) ?? null;
  const at = useRef<LiveAt>({ bid: null, src: null });
  at.current = { bid: board, src };
  const pageRef = useRef<HTMLDivElement | null>(null);
  const marksRef = useRef<ReturnType<typeof useMarks> | null>(null);
  const engineRef = useRef<HtmlEngine | null>(null);
  const heightRef = useRef(onHeight);
  heightRef.current = onHeight;
  engineRef.current ??= liveEngine(() => at.current, () => marksRef.current, (h) => heightRef.current?.(h / scaleRef.current));
  const engine = engineRef.current;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => () => engine.dispose(), [engine]);

  const marks = useMarks({
    pageRef, proseRef: NO_EL, pdfHostRef: NO_EL, docRef: NO_DOC, pageIndex: () => null,
    live: () => ({ activeId: board, src: at.current.src, onHome: false, treeOpen: false }),
    toast, toastWhy: (e, said) => toast(StrataWhy(e, said), 4200),
    reread: (b) => { StrataAPI.getBoard(b).then((st) => { applyBoardState(st, StrataAnswer(st) ?? {}); }).catch(() => {}); },
    clearLive: () => engine.clearSelection(),
  }, { pairIdx: 0, loading: !src });
  marksRef.current = marks;

  const hostRef = useRef<FoldHost | null>(null);
  hostRef.current ??= (() => {
    const adapter = sourceAdapters({
      scroller: () => pageRef.current, ensureDrawn: () => {}, proseDoc: () => null, pdfText: () => null,
      revealLive: (q, slug) => engine.reveal(q, slug),
      layersLive: (items, on, fresh) => engine.layers(items, on, scaleRef.current, fresh),
    })("html");
    return { ...NOTES_ONLY, ...noteFolds(() => at.current, () => marksRef.current), adapter: () => adapter, drawn: () => {} };
  })();
  const paint = () => { paintLiveMarks(engine, at.current, marksRef.current?.openMarkRef.current?.id); paintFolds(hostRef.current!); };

  const url = liveUrlOf({ bid: board, src });
  useLayoutEffect(paint, [url, marks.openMark?.id, scale]);
  // marks and replies repaint from the store and a layer switch in place, never by rendering what holds the page
  useEffect(() => {
    const paintable = () => marksOn(board, at.current.src).map((m) => JSON.stringify([m.id, m.note, (m.replies ?? []).map((r) => r.id)])).join("|");
    let last = paintable();
    const offMarks = roomStore.subscribe(marksKey(board), () => { const now = paintable(); if (now !== last) { last = now; paint(); } });
    let was = switches.getSnapshot().on;
    const offSwitch = switches.subscribe(() => { const now = switches.getSnapshot().on; if (now !== was) { was = now; paint(); } });
    return () => { offMarks(); offSwitch(); };
  }, [board]);

  return (
    <div className="livepage" ref={pageRef} onMouseDown={marks.onReaderDown} onClick={marks.onReaderClick}>
      {url && src ? <HtmlSource engine={engine} url={url} title={src.filename} scale={scale} bare /> : null}
      {marks.selMenu ? <SelectionMenu at={marks.selMenu} onNote={() => void marks.markSelection(true)} /> : null}
    </div>
  );
}
