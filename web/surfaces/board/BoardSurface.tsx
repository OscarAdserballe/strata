import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { StrataAPI, StrataWhy, StrataWireDown } from "../../data/api.ts";
import { store as roomStore, useEntity } from "../../data/store.ts";
import { boardKey, marksKey, planKey } from "../../data/entities/boards.ts";
import { plan as planOps, planCalls } from "../../data/entities/plan.ts";
import { decks as wholeDecks } from "../../data/entities/decks.ts";
import { pageCount } from "../../engines/pdf/thumbnails.ts";
import DistilProgress from "../../capabilities/progress/DistilProgress.tsx";
import type { DistilWork } from "../../capabilities/progress/distil.ts";
import BoardVerbs from "../../capabilities/sources/BoardVerbs.tsx";
import ResplitDialog, { warmResplit } from "../../capabilities/sources/Resplit.tsx";
import type { useSourceActions } from "../../capabilities/sources/useSourceActions.ts";
import BoardPage from "./BoardPage.jsx";
import BookRoom from "./BookRoom.tsx";
import BoardNotes from "./BoardNotes.tsx";
import { useBoardNotes } from "./boardNotes.ts";
import { boardTiles, type BoardState, type DeckRow, type Pair, type QGroup, type Tile, type Touch } from "./boardTiles.ts";
import { useBoardPageUp } from "./summon.ts";

export type { DistilWork };
const asTouch = (t: unknown) => t as Record<string, Touch>;
type Board = BoardState & { board: { id: string; title?: string }; plan?: unknown; pairs?: Pair[] };

export interface BoardSurfaceProps {
  boardId: string | null;
  board: Board | null;
  title: string;
  decks: DeckRow[];
  pairs: Pair[];
  pairIdx: number;
  qDeck: { kind?: string; name?: string } | null;
  qGroups: QGroup[];
  solo: boolean;
  driftSection: { id: string } | null;
  deskHome: boolean;
  distilWork: DistilWork;
  sourceActions: ReturnType<typeof useSourceActions>;
  boardActions: ComponentProps<typeof BoardVerbs>["actions"];
  tools: ReactNode;
  logExtra?: ReactNode;
  pageRef: RefObject<HTMLElement | null>;
  current(): string | null;
  onBoardState(st: unknown): void;
  onReread(boardId: string): void;
  toast(msg: string, ms?: number): void;
  toastWhy(e: unknown, said: string): void;
  onBack(): void;
  onBoards(): void;
  onWarm(t: Tile): void;
  onCram(): void;
  onCramWarm(): void;
  onAdd(kind: "file" | "link"): void;
  onRetryDistil(r: { id: string }): void;
  onOpenTile(t: Tile): void;
  onKeep(t: Tile): void;
  onKeepWarm(): void;
  onRedistilled(): void;
  onAsideDone(slugs: string[], restore: boolean): void;
}

export default function BoardSurface(p: BoardSurfaceProps) {
  const { boardId, board, pairIdx } = p;
  const { pin, done } = useBoardPageUp();
  const up = p.deskHome || pin || done;
  const over = up && (pin || done);

  // board state is fetched once on open, so refetch the drill counts each time the page comes up
  const [touchLive, setTouchLive] = useState<Record<string, Touch> | null>(null);
  useEffect(() => { setTouchLive(null); }, [boardId]);
  useEffect(() => {
    if (!up || !boardId) return;
    let dead = false;
    StrataAPI.touched(boardId).then((j) => { if (!dead && j && j.touched) setTouchLive(asTouch(j.touched)); }).catch(() => {});
    return () => { dead = true; };
  }, [up, boardId]);
  const [bookView, setBookView] = useState<{ rid?: string; top?: boolean } | null>(null);
  useEffect(() => { setBookView(null); }, [boardId, pairIdx]);
  const [hushed, setHushed] = useState<string[]>(() => { try { const v = JSON.parse(localStorage.getItem("strata.distilHushed") || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } });
  const { text: notes } = useBoardNotes();
  const [resplit, setResplit] = useState<Tile | null>(null);
  useEffect(() => { setResplit(null); }, [boardId]);
  const leftRef = useRef<HTMLElement | null>(null);
  const livePlan = useEntity<unknown>(planKey(boardId || ""));
  if (!up || !board || !boardId) return null;
  const activeId = boardId;

  const tiles = boardTiles({ board: { ...board, ...roomStore.get<Board>(boardKey(boardId)), marks: roomStore.get<Board["marks"]>(marksKey(boardId)) }, touchLive, decks: p.decks, pairs: p.pairs, pairIdx, bookView, qDeck: p.qDeck, solo: p.solo, activeId, driftSection: p.driftSection, notes, qGroups: p.qGroups,
    pageCount });
  const { toast, toastWhy, sourceActions } = p;

  async function deleteTile(t: Tile) {
    if (!t.del) return;
    if (t.del.res) await sourceActions.remove(activeId, t.del.res);
    else await sourceActions.removePair(activeId, t.del.pair!);
  }
  async function redistilTile(t: Tile) {
    if (!t.rid) return;
    if ((t.sections || 0) > 1) { setResplit(t); return; }
    if (!(await sourceActions.redistil(activeId, t.rid))) return;
    toast("re-distilling " + (t.label || "that source") + ((t.sections || 0) > 1 ? " — " + t.sections + " sections" : ""));
    p.onRedistilled();
  }
  async function asideTile(t: Tile, restore: boolean) {
    const asked = ((t.aside || { slugs: [] }).slugs || []).filter(Boolean);
    if (!asked.length) return;
    // only decks whose op succeeded are treated as changed
    const results = await Promise.allSettled(asked.map((sl) => wholeDecks.setAside(sl, restore)));
    const refused = results.find((r) => r.status === "rejected");
    if (refused) toastWhy(refused.reason, restore ? "couldn't put those back" : "couldn't set those aside");
    const slugs = asked.filter((_, i) => results[i].status === "fulfilled");
    if (!slugs.length) return;
    p.onAsideDone(slugs, restore);
    StrataAPI.touched(activeId).then((j) => { if (j && j.touched) setTouchLive(asTouch(j.touched)); }).catch(() => {});
  }
  function renameTile(t: { rid?: string | null; label?: string }, name: string) {
    if (!t.rid) return;
    void sourceActions.rename(activeId, t.rid, name);
  }
  async function doneTile(t: Tile, isDone: boolean) {
    if (!t.rid) return;
    if (!(await sourceActions.done(activeId, t.rid, !!isDone))) return;
    toast(isDone ? (t.label || "that source") + " — done" : (t.label || "that source") + " — back in the queue", 1600);
  }
  function openTile(t: Tile) {
    if (t.enter) { setBookView({ rid: t.enter }); return; }
    if (t.root) { setBookView({ top: true }); return; }
    p.onOpenTile(t);
  }

  const work = p.distilWork;
  const shownFailed = work.failed.filter((w) => !hushed.includes(w.r.id + "|" + w.error));
  const hush = (w: DistilWork["failed"][number]) => setHushed((list) => {
    const next = list.filter((k) => !k.startsWith(w.r.id + "|")).concat(w.r.id + "|" + w.error).slice(-200);
    try { localStorage.setItem("strata.distilHushed", JSON.stringify(next)); } catch (e) { /* private window */ }
    return next;
  });
  const failVerb = (w: DistilWork["failed"][number]) => /budget/i.test(w.error)
    ? <button className="bh-retry" onClick={() => p.onAdd("file")}>add the file again</button>
    : <button className="bh-retry" onClick={() => p.onRetryDistil(w.r)}>try again</button>;
  const issues = Object.fromEntries(work.failed.map((w) => [w.r.id, { error: w.error, verb: failVerb(w) }]));
  const workLines = work.busy.length || shownFailed.length ? (
    <div className="dk-work">
      {work.busy.map((w) => (
        <DistilProgress key={w.r.id} work={w} compact />
      ))}
      {shownFailed.map((w) => (
        <div className="bh-distil err" key={w.r.id}>
          <span className="bh-dname">{w.name}</span>
          <span className="bh-dwhat">{w.error}</span>
          {failVerb(w)}
          <button className="bh-retry bh-hush" aria-label={"Dismiss the message about " + w.name} onClick={() => hush(w)}>dismiss</button>
        </div>
      ))}
    </div>
  ) : null;

  function planWrite(w: Parameters<Parameters<typeof planCalls>[0]>[0]) {
    if (StrataWireDown()) { toast("offline — the plan needs the wire"); return Promise.resolve(null); }
    const bid = activeId;
    return planOps.write(bid, w).catch((e: { retryable?: boolean } | undefined) => {
      toast(StrataWhy(e, "couldn't save that"));
      // out of retries: release the plan lane and refetch, or it holds the lane with its guess showing
      if (e && e.retryable) { planOps.abandon(bid); p.onReread(bid); }
      return null;
    });
  }
  const planApi = planCalls(planWrite);

  const log = (
    <BoardNotes current={p.current} leftRef={leftRef} pageRef={p.pageRef}
      toast={toast} toastWhy={toastWhy} onBoardState={p.onBoardState}>{p.logExtra}</BoardNotes>
  );
  const verbs = { onOpen: openTile, onDel: deleteTile, onAside: asideTile, onDistil: redistilTile, onKeep: p.onKeep, onKeepWarm: p.onKeepWarm, onRenamed: renameTile, onDone: doneTile };
  const resplitting = resplit && resplit.rid ? (
    <ResplitDialog board={activeId} rid={resplit.rid} onClose={() => setResplit(null)} onError={toastWhy}
      onDone={(r) => {
        setResplit(null);
        toast((r.queued ? "re-distilling " : "re-sectioned ") + (resplit.label || "that source") + " — " + r.sections + " sections"
          + (r.refiled ? ", " + r.refiled + " kept card" + (r.refiled === 1 ? "" : "s") + " moved with their text" : ""));
        p.onRedistilled();
      }} />
  ) : null;

  if (!tiles.some((t) => t.gap)) return (
    <div className="desk-at">
      <BoardPage boardId={activeId} tiles={tiles} plan={livePlan ?? board.plan} planApi={planApi}
        head={p.title} over={over} onBack={p.onBack} onBoards={p.onBoards} onWarm={p.onWarm}
        {...verbs} onDistilWarm={(t: Tile) => { if (t.rid) warmResplit(activeId, t.rid); }}
        onAdd={p.onAdd} issues={issues} onCram={p.onCram} onCramWarm={p.onCramWarm}
        boardVerbs={<BoardVerbs board={{ id: activeId, title: p.title }} actions={p.boardActions} className="bp-link" />}
        log={log} work={workLines} tools={p.tools} leftRef={leftRef} />
      {resplitting}
    </div>
  );

  return (
    <div className="desk-at">
      <BookRoom tiles={tiles} {...verbs} head={p.title} over={over} onBack={p.onBack} />
      {resplitting}
    </div>
  );
}
