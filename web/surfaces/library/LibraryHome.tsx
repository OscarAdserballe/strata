import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { StrataWhy } from "../../data/api.ts";
import { PHONE } from "../../platform/device.js";
import { courseOf } from "../../shell/format.js";
import Suggest from "../../capabilities/feedback/Suggest.tsx";
import HomeTools, { type Compose } from "./HomeTools.tsx";
import Ask from "../../capabilities/ask/Ask.tsx";
import { useProvideHere } from "../../shell/here.ts";
import { sinceLoad } from "../../platform/rum.ts";
import { useBoardList, useRegister } from "../../data/entities/register.ts";
import type { RegisterEntry } from "../../../shared/types/index.ts";
import Timeline from "../../capabilities/progress/Timeline.tsx";
import { useSourceActions } from "../../capabilities/sources/useSourceActions.ts";
import type { ReviewStrip } from "../../data/entities/review.ts";
import type { BoardActions } from "../../capabilities/sources/useBoardActions.ts";
import BoardVerbs from "../../capabilities/sources/BoardVerbs.tsx";
import { ImportActivity } from "../../capabilities/sources/ImportsPanel.tsx";
import { AddSourceForm, UNFILED, addSource } from "../../capabilities/sources/AddSource.tsx";
import TopNav from "../../shell/TopNav.tsx";
import type { LibraryTab } from "../../shell/routes.ts";
import Today from "./Today.tsx";
import ProjectsIndex from "./ProjectsIndex.tsx";
import NewProject from "./NewProject.tsx";

const BOOTED_HOME = typeof location !== "undefined" && !new URLSearchParams(location.search).get("board");
let homeTimed = false;

function until(ts: number | null | undefined) {
  if (!ts) return "";
  const h = Math.max(0, (ts - Date.now()) / 36e5);
  if (h < 20) return "later today";
  if (h < 40) return "tomorrow";
  return `in ${Math.round(h / 24)} days`;
}

function PhoneDoor({ review, onReview }: { review: ReviewStrip | null; onReview: () => void }) {
  const from: string[] = [];
  if (review && review.cards) for (const c of review.cards) { const t = courseOf(c.courseTitle); if (t && !from.includes(t)) from.push(t); }
  const fromLine = from.slice(0, 3).join(" · ") + (from.length > 3 ? ` +${from.length - 3} more` : "");
  return (
    <div className="pdoor">
      {!review ? null
        : review.total ? <>
            <div className="pdoor-overline">today’s review</div>
            <div className="pdoor-n">{review.total}</div>
            <div className="pdoor-line">kept card{review.total === 1 ? "" : "s"} due</div>
            {fromLine ? <div className="pdoor-from">{fromLine}</div> : null}
            <button className="pdoor-go" onClick={onReview}>review →</button>
          </>
        : <>
            <div className="pdoor-mark">✓</div>
            <div className="pdoor-line">{review.nextDueAt ? "reviewed — nothing owed" : "nothing kept on the ladder yet"}</div>
            <div className="pdoor-from">{review.nextDueAt ? `next cards ${until(review.nextDueAt)}` : "cards you keep at the desk return here"}</div>
          </>}
    </div>
  );
}

export interface LibraryHomeProps {
  covered?: boolean;
  q: string;
  setQ: (q: string) => void;
  onOpen: (boardId: string, sourceId?: string) => void;
  onResume?: ((boardId: string, sourceId?: string) => void) | null;
  onWarm?: ((boardId: string, resume?: boolean) => void) | null;
  onNew: () => void;
  onClose?: (() => void) | null;
  boardActions: BoardActions;
  onSourceMutation?: ((boardId: string, state: unknown, verb: string) => void) | null;
  review: ReviewStrip | null;
  onReview: () => void;
  onLogout: () => void;
  adminPath?: string | null;
  onCardsChanged?: () => void;
  tab: LibraryTab;
  onTab(tab: LibraryTab): void;
  onAdd(kind: "file" | "link", study?: boolean): void;
}

function LibraryHome({ covered = false, q, setQ, onOpen, onResume, onWarm, onNew, onClose, boardActions, onSourceMutation, review, onReview, onLogout, adminPath, onCardsChanged, tab, onTab, onAdd }: LibraryHomeProps) {
  useProvideHere(() => ({ surface: "library" }));
  const composeRef = useRef<Compose | null>(null);
  const libraryAsk = covered ? null : <Ask thread="library" lazy name="the library’s thread" placeholder="ask anything, or paste a passage to talk about…"
    onCompose={(q, a) => composeRef.current?.(q, a)} feedback={{ board: null, context: { surface: "library" } }} />;
  const [err, setErr] = useState("");
  const { register: reg, error: regError } = useRegister();
  const boards = useBoardList();
  useEffect(() => { if (reg && BOOTED_HOME && !homeTimed) { homeTimed = true; sinceLoad("home"); } }, [reg]);
  useEffect(() => { if (regError) setErr(StrataWhy(regError, "couldn't read the register")); }, [regError]);
  const [boardsOpen, setBoardsOpen] = useState(false);
  const sourceActions = useSourceActions({
    onState: (id, state, verb) => onSourceMutation?.(id, state, verb),
    onError: (x, said) => setErr(StrataWhy(x, said)),
  });
  const [filing, setFiling] = useState<string | null>(null);
  function file(e: RegisterEntry, to: string | null) {
    setFiling(null); setErr("");
    const dest = to ? boards.find((b) => b.id === to) : null;
    void sourceActions.file(e, to ? { id: to, title: dest ? dest.title : "" } : null);
  }
  const dragDepth = useRef(0);
  const [dragHover, setDragHover] = useState(false);
  const fileDrop = {
    onDragEnter(e: DragEvent<HTMLDivElement>) {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault(); dragDepth.current++; setDragHover(true);
    },
    onDragOver(e: DragEvent<HTMLDivElement>) {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave() {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragHover(false);
    },
    onDrop(e: DragEvent<HTMLDivElement>) {
      const files = Array.from(e.dataTransfer.files);
      dragDepth.current = 0; setDragHover(false);
      if (!files.length) return;
      e.preventDefault();
      void addSource.files(files, UNFILED);
    },
  };
  const dropHint = dragHover ? <div className="dropzone">drop to add — files land unfiled</div> : null;

  const threads = (boards || []).filter((b) => b.type !== "inbox");
  const hero = threads[0] || null;
  // warm only after home's own reads, so warming never queues ahead of them on the server
  useEffect(() => { if (hero && onWarm && reg && review) onWarm(hero.id, true); }, [hero && hero.id, !!reg, !!review]);

  const downloaded = boards.filter((b) => {
    try { return !!localStorage.getItem(`strata.offline.${b.id}`); } catch { return false; }
  });
  if (PHONE) return (
    <div className="veil launcher" {...fileDrop}>
      {dropHint}
      <div className="lwrap">
        <div className="lhead">
          <span className="ltitle">Strata</span>
          <span className="lsub">daily review</span>
          <Suggest />
          {adminPath ? <button className="seg" onClick={() => location.assign(adminPath)}>Admin</button> : null}
          <button className="seg" onClick={onLogout}>Log out</button>
        </div>
        <PhoneDoor review={review} onReview={onReview} />
        <HomeTools onCardsChanged={onCardsChanged} composeRef={composeRef} />
        {libraryAsk}
        <button className="seg" aria-expanded={boardsOpen} onClick={() => setBoardsOpen(!boardsOpen)}>All boards</button>
        {boardsOpen ? <section aria-label="All boards">
          {boards.filter(b=>b.type!=="inbox").map(b=><p key={b.id} className="pboard-row">
            <BoardVerbs board={b} actions={boardActions} className="seg" name={<button className="seg" onClick={()=>onOpen(b.id)}>{b.title}</button>} />
          </p>)}
          <form onSubmit={e=>{e.preventDefault();if(q.trim())onNew();}}><input aria-label="New board name" value={q} onChange={e=>setQ(e.target.value)} placeholder="Name a new board…" />
            <button className="seg" disabled={!q.trim()}>Create board</button></form>
        </section> : null}
        {downloaded.length ? <section className="offline-boards" aria-label="Downloaded for offline reading">
          <h2>Downloaded for offline reading</h2>
          {downloaded.map((b) => <button key={b.id} onClick={() => onOpen(b.id)}>{b.title}</button>)}
        </section> : !review && err ? <p className="pdoor-from">No boards downloaded on this device. Reconnect to load your library.</p> : null}
        <section className="reg pdoor-add" aria-label="Add a source"><AddSourceForm /></section>
        <ImportActivity onOpen={onOpen} />
      </div>
    </div>
  );

  const unfiled = (reg ? reg.entries : []).filter((e) => e.unfiled && e.waiting);
  const tabBody = tab === "projects" ? <>
    <ProjectsIndex reg={reg} onOpen={(id) => onOpen(id)} onWarm={onWarm ? (id) => onWarm(id, false) : undefined} onNew={() => onTab("new")} />
    <section className="reg pj-unfiled" aria-label="Unfiled">
      <h2>Unfiled{unfiled.length ? ` · ${unfiled.length}` : ""}</h2>
      <AddSourceForm />
      {err ? <div className="rg-err" role="alert">{err}</div> : null}
      {unfiled.length ? <Timeline entries={unfiled} boards={threads} onOpen={onOpen} onFile={file}
        onRename={(e, name) => { setErr(""); void sourceActions.rename(e.boardId, e.resourceId, name); }}
        onDelete={(e) => { setErr(""); void sourceActions.remove(e.boardId, e.resourceId); }}
        filing={filing} setFiling={setFiling} empty="" /> : null}
    </section>
  </>
    : tab === "new" ? <NewProject onCancel={() => onTab("projects")} onCreated={(id) => onOpen(id)} />
    : <Today reg={reg} review={review} onReview={onReview} onOpen={(id, rid) => (rid ? onOpen(id, rid) : onOpen(id))}
        onResume={(id, rid) => (onResume ? onResume(id, rid) : onOpen(id, rid))}
        onWarm={onWarm ? (id) => onWarm(id, false) : undefined} onProjects={() => onTab("projects")} error={err} />;

  return (
    <div className="veil launcher home2" {...fileDrop}>
      {dropHint}
      <TopNav here={tab === "today" ? "today" : "projects"} onAdd={onAdd} adminPath={adminPath} onSignOut={onLogout}
        tools={onClose ? <button className="tn-more" aria-label="Close library" onClick={onClose}>✕</button> : null} />
      <div className="home2-scroll">
        {tabBody}
        <ImportActivity onOpen={onOpen} />
        {tab !== "new" ? <footer className="home2-foot"><HomeTools onCardsChanged={onCardsChanged} composeRef={composeRef} /></footer> : null}
      </div>
      {libraryAsk}
    </div>
  );
}

export default LibraryHome;
