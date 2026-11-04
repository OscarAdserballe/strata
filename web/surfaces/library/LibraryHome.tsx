import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import type { RegisterEntry } from "../../../shared/types/index.ts";
import { StrataWhy } from "../../data/api.ts";
import { PHONE } from "../../platform/device.js";
import { courseOf, ago } from "../../shell/format.js";
import Timeline from "../../capabilities/progress/Timeline.tsx";
import KeptChart from "../../capabilities/progress/KeptChart.tsx";
import Suggest from "../../capabilities/feedback/Suggest.tsx";
import CardIcon from "../../shell/CardIcon.tsx";
import HomeTools, { type Compose } from "./HomeTools.tsx";
import Ask from "../../capabilities/ask/Ask.tsx";
import { useProvideHere } from "../../shell/here.ts";
import { sinceLoad } from "../../platform/rum.ts";
import { refreshRegister, useBoardList, useRegister } from "../../data/entities/register.ts";
import type { ReviewStrip } from "../../data/entities/review.ts";
import { useSourceActions } from "../../capabilities/sources/useSourceActions.ts";
import type { BoardActions } from "../../capabilities/sources/useBoardActions.ts";
import BoardVerbs from "../../capabilities/sources/BoardVerbs.tsx";
import { ImportActivity } from "../../capabilities/sources/ImportsPanel.tsx";
import { AddSourceForm, UNFILED, addSource } from "../../capabilities/sources/AddSource.tsx";

const BOOTED_HOME = typeof location !== "undefined" && !new URLSearchParams(location.search).get("board");
let homeTimed = false;

type Cut = "all" | "waiting" | "unfiled" | "to-review";

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
  onResume?: ((boardId: string) => void) | null;
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
}

function LibraryHome({ covered = false, q, setQ, onOpen, onResume, onWarm, onNew, onClose, boardActions, onSourceMutation, review, onReview, onLogout, adminPath, onCardsChanged }: LibraryHomeProps) {
  useProvideHere(() => ({ surface: "library" }));
  const composeRef = useRef<Compose | null>(null);
  const libraryAsk = covered ? null : <Ask thread="library" lazy name="the library’s thread" placeholder="ask anything, or paste a passage to talk about…"
    onCompose={(q, a) => composeRef.current?.(q, a)} feedback={{ board: null, context: { surface: "library" } }} />;
  const [err, setErr] = useState("");
  const { register: reg, error: regError } = useRegister();
  const boards = useBoardList();
  useEffect(() => { if (reg && BOOTED_HOME && !homeTimed) { homeTimed = true; sinceLoad("home"); } }, [reg]);
  useEffect(() => { if (regError) setErr(StrataWhy(regError, "couldn't read the register")); }, [regError]);
  const sourceActions = useSourceActions({
    onState: (id, state, verb) => { if (onSourceMutation) onSourceMutation(id, state, verb); },
    onError: (x, said) => setErr(StrataWhy(x, said)),
  });
  const [cut, setCut] = useState<Cut>("all");
  const [filing, setFiling] = useState<string | null>(null);
  const [boardsOpen, setBoardsOpen] = useState(false);
  const askEl = useRef<HTMLInputElement>(null);
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

  const reload = () => refreshRegister();

  const threads = (boards || []).filter((b) => b.type !== "inbox");
  const keptBy = new Map<string, number>();
  for (const e of (reg ? reg.entries : [])) if (e.kept) keptBy.set(e.boardId, (keptBy.get(e.boardId) || 0) + e.kept);
  const hero = threads[0] || null;
  // warm only after home's own reads, so warming never queues ahead of them on the server
  useEffect(() => { if (hero && onWarm && reg && review) onWarm(hero.id, true); }, [hero && hero.id, !!reg, !!review]);
  const warmOn = (id: string, resume: boolean) => (onWarm ? { onPointerEnter: () => onWarm(id, resume), onPointerDown: () => onWarm(id, resume) } : {});

  function file(e: RegisterEntry, to: string | null) {
    setFiling(null); setErr("");
    const dest = to ? boards.find((b) => b.id === to) : null;
    void sourceActions.file(e, to ? { id: to, title: dest ? dest.title : "" } : null);
  }
  function renameSource(e: RegisterEntry, name: string) { setErr(""); void sourceActions.rename(e.boardId, e.resourceId, name); }
  function deleteSource(e: RegisterEntry) { setErr(""); void sourceActions.remove(e.boardId, e.resourceId); }

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

  const ov = reg ? reg.overview : null;
  const all = reg ? reg.entries : [];
  const waiting = all.filter((e) => e.waiting);

  const cutOf = (e: RegisterEntry) => cut === "all" ? true
    : cut === "unfiled" ? e.waiting && e.unfiled
    : cut === "to-review" ? e.status === "to-review"
    : e.waiting;
  const shown = all.filter(cutOf);

  const counts: Record<Cut, number> = {
    all: all.length,
    waiting: waiting.length,
    unfiled: waiting.filter((e) => e.unfiled).length,
    "to-review": all.filter((e) => e.status === "to-review").length,
  };
  const CUTS: [Cut, string][] = [
    ["all", "everything"],
    ["waiting", "not gone through"],
    ["unfiled", "unfiled"],
    ["to-review", "to review"],
  ];



  return (
    <div className="veil launcher calm-home" {...fileDrop}>
      {dropHint}
      <div className="lwrap">
        <header className="lhead">
          <span className="ltitle">Strata</span>
          <span className="lsub">the reading room</span>
          <span className="grow" />
          <Suggest />
          {adminPath ? <button className="home-quiet" onClick={() => location.assign(adminPath)}>Admin</button> : null}
          <button className="home-quiet" onClick={onLogout}>Log out</button>
          {onClose ? <button className="home-quiet" aria-label="Close library" onClick={onClose}>✕</button> : null}
        </header>

        <main className="home-content">
          <HomeTools onCardsChanged={onCardsChanged} composeRef={composeRef} />
          {libraryAsk}
          <section className="home-doors" aria-label="Continue and review">
            <div className="home-continue">
              <div className="home-eyebrow">Pick up where you left off</div>
              <h1>{hero ? hero.title : "Your reading room"}</h1>
              <p>{hero?.lastRead
                ? <>{hero.lastRead.filename}{hero.lastRead.deepest > 0 && hero.lastRead.deepest < 100 ? ` · ${hero.lastRead.deepest}% in` : ""}</>
                : hero ? `${(hero.resources || []).length} sources${keptBy.get(hero.id) ? ` · ${keptBy.get(hero.id)} cards kept` : ""}` : "A place for what you want to understand."}</p>
              {hero ? <button className="home-primary" {...warmOn(hero.id, true)} onClick={() => (onResume || onOpen)(hero.id)}>Continue board <span aria-hidden="true">→</span></button>
                : <button className="home-primary" onClick={() => setBoardsOpen(true)}>Create your first board <span aria-hidden="true">→</span></button>}
              <button className="home-quiet home-all-boards" aria-expanded={boardsOpen} aria-controls="home-boards" onClick={() => setBoardsOpen(!boardsOpen)}>All boards <span>{threads.length}</span></button>
            </div>
            <div className="home-review">
              <div className="home-eyebrow">A little, every day</div>
              <h2>Review</h2>
              <p>{!review ? "Checking your cards…" : review.total ? `Kept card${review.total === 1 ? "" : "s"} ready to revisit.` : review.nextDueAt ? `All caught up. Next cards ${until(review.nextDueAt)}.` : "Cards you keep return here."}</p>
              <button className="home-primary home-secondary" disabled={!review} onClick={onReview}><CardIcon />{review?.total ? `Review ${review.total} card${review.total === 1 ? "" : "s"}` : "Open review"}<span aria-hidden="true">→</span></button>
              {reg ? <div className="home-review-chart"><KeptChart times={(reg.keptRecent || []).map((k) => k.at)} days={7} compact label="Cards kept" /></div> : null}
            </div>
          </section>

          <section id="home-boards" className="home-boards" aria-label="All boards" hidden={!boardsOpen}>
            <div className="home-section-head"><h2>Your boards</h2><button className="home-quiet" onClick={() => setBoardsOpen(false)}>Close</button></div>
            {threads.map((b) => <div className="home-board-row" key={b.id}>
              <BoardVerbs board={b} actions={boardActions}
                name={<button className="home-board-name" {...warmOn(b.id, false)} onClick={() => onOpen(b.id)}>{b.title}</button>}
                between={<span className="home-board-age">{ago(b.touchedAt)}</span>} />
            </div>)}
            <form className="home-new-board" onSubmit={(e) => { e.preventDefault(); if (q.trim()) onNew(); }}>
              <input ref={askEl} aria-label="New board name" value={q} placeholder="Name a new board…" onChange={(e) => setQ(e.target.value)} />
              <button className="rg-take-b" disabled={!q.trim()}>Create board</button>
            </form>
          </section>

          <ImportActivity onOpen={onOpen} />
          <section className="reg home-library" aria-label="Your library">
            <div className="home-section-head"><h2>Library</h2><span className="home-note">Everything you’ve brought into the room</span></div>
            <AddSourceForm />
            {err ? <div className="rg-err" role="alert">{err}</div> : null}
            <div className="rg-cuts" aria-label="Library filters">
              {CUTS.map(([k, label]) => <button key={k} className={"rg-cut" + (cut === k ? " on" : "")} aria-pressed={cut === k} onClick={() => setCut(k)}>{label}<b>{counts[k]}</b></button>)}
            </div>
            {reg === null ? <div className="rg-wait">Reading the library…</div>
              : <Timeline entries={shown} boards={threads} onOpen={onOpen} onFile={file}
                  onRename={renameSource} onDelete={deleteSource} filing={filing} setFiling={setFiling}
                  empty={!all.length ? "Save a link or add a file. You can choose a board later."
                    : cut === "unfiled" ? "Nothing unfiled — everything has a board."
                    : cut === "to-review" ? "Every deck you’ve been through has been curated."
                    : "Nothing waiting. Everything has been gone through."} />}
          </section>

          <section className="home-history" aria-label="Reading timeline">
            <div className="home-section-head"><h2>Your reading, lately</h2>
              {ov ? <span className="rg-week">{ov.landed} landed<i>·</i>{ov.through} gone through<i>·</i><b><CardIcon /> {ov.kept} cards kept</b><span className="home-week-label"> this week</span></span> : null}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

export default LibraryHome;
