import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { BoardPlan, RegisterResponse, ResourceMeta } from "../../../shared/types/index.ts";
import { useEntity } from "../../data/store.ts";
import { REGISTER } from "../../data/entities/sources.ts";
import { plan as planWrites, planGestures, type planCalls } from "../../data/entities/plan.ts";
import { refreshRegister } from "../../data/entities/register.ts";
import Verbs from "../../capabilities/sources/SourceVerbs.tsx";
import type { BoardActions } from "../../capabilities/sources/useBoardActions.ts";
import { boardProject, shortDay, STAR_CAP, type ProjectSource, type ProjectUnit } from "../../capabilities/today/projects.ts";
import { openTab } from "../../shell/screens.ts";
import type { Tile } from "./boardTiles.ts";
import "./project-page.css";

type PlanApi = ReturnType<typeof planCalls>;
type Verb<A extends unknown[] = []> = ((t: Tile, ...a: A) => void) | undefined;

export interface ProjectPageProps {
  boardId: string;
  head: string;
  tiles: Tile[];
  plan: BoardPlan | null;
  planApi: PlanApi;
  resources: ResourceMeta[];
  over: boolean;
  onBack(): void;
  onOpen(t: Tile): void;
  onWarm?: (t: Tile) => void;
  onDel?: Verb; onAside?: Verb<[boolean]>; onDistil?: Verb; onDistilWarm?: Verb; onKeep?: Verb; onKeepWarm?: () => void;
  onRenamed?: (t: Tile, name: string) => void; onDone?: Verb<[boolean]>;
  issues: Record<string, { error: string; verb: ReactNode }>;
  work: ReactNode;
  onCram?: () => void; onCramWarm?: () => void;
  boardActions: BoardActions;
  tools?: ReactNode;
}

const EMPTY: BoardPlan = { purpose: "", endsAt: "", archivedAt: null, groups: [], milestones: [], places: {} };
const dayLong = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "long" });

function Dot({ s }: { s: ProjectSource }) {
  return <i className={"pp-dot" + (s.finished ? " done" : s.pct > 0 || s.lastAt ? " half" : "")} />;
}
function UnitDot({ u }: { u: ProjectUnit }) {
  const all = u.sources.length > 0 && u.done === u.sources.length;
  return <i className={"pp-dot" + (all ? " done" : u.done || u.sources.some((s) => s.pct > 0) ? " half" : "")} />;
}

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Says what goes with a source and what stays before it is deleted. */
function DeleteAsk({ name, notes, kept, onDelete, onCancel }: { name: string; notes: number; kept: number; onDelete(): void; onCancel(): void }) {
  return <div className="pp-delask" role="alertdialog" aria-label={"Delete " + name}
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
    <span><b>Delete “{name}”?</b> {notes ? `Its ${count(notes, "note")} ${notes === 1 ? "goes" : "go"} with it. ` : ""}
      {kept ? `Its ${count(kept, "kept card")} ${kept === 1 ? "stays" : "stay"} in Review.` : notes ? "" : "No notes or kept cards on it."}</span>
    <button className="pp-delgo" onClick={onDelete}>Delete</button>
    <button className="pp-link" autoFocus onClick={onCancel}>Cancel</button>
  </div>;
}

/** A field that saves on blur or Enter and puts itself back on Escape. */
function Ghost({ value, onCommit, className, label, placeholder }: { value: string; onCommit(v: string): void; className: string; label: string; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return <input className={className} aria-label={label} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)}
    onBlur={() => { if (v.trim() !== value) onCommit(v.trim()); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") { setV(value); e.currentTarget.blur(); }
    }} />;
}

export default function ProjectPage(p: ProjectPageProps) {
  const { boardId, planApi } = p;
  const plan = p.plan || EMPTY;
  const view = useMemo(() => boardProject(boardId, p.head, plan, p.resources), [boardId, p.head, plan, p.resources]);
  const tileOf = useMemo(() => {
    const m = new Map<string, Tile>();
    for (const t of p.tiles) if (t.rid && !t.add && !t.gap && !m.has(t.rid)) m.set(t.rid, t);
    return m;
  }, [p.tiles]);
  const yours = p.tiles.filter((t) => (t.qgroup || t.ignoredPile) && (t.cards || 0) > 0);
  const [open, setOpen] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [arm, setArm] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const drag = useRef<string | null>(null);
  useEffect(() => { setOpen(null); setMenu(false); setRenaming(null); setArm(null); setChoosing(null); setDeleting(null); }, [boardId]);
  useEffect(() => {
    if (!menu) return;
    const shut = () => { setMenu(false); setArm(null); };
    document.addEventListener("click", shut);
    return () => document.removeEventListener("click", shut);
  }, [menu]);
  const shown = open ?? view.current?.id ?? null;
  const first = view.current?.sources.find((s) => !s.finished) ?? view.loose.find((s) => !s.finished) ?? null;
  const firstTile = first ? tileOf.get(first.id) : undefined;
  useEffect(() => { if (firstTile && p.onWarm && !firstTile.enter) p.onWarm(firstTile); }, [firstTile && firstTile.key]);

  // Stars across every project: the register holds the others, this board's live plan holds its own.
  const reg = useEntity<RegisterResponse>(REGISTER);
  const otherStars = (reg?.projects ?? []).filter((x) => x.id !== boardId && !x.archivedAt)
    .flatMap((x) => Object.entries(x.places).filter(([, pl]) => pl.pinned).map(([rid]) => ({ board: x.id, rid,
      name: reg!.entries.find((e) => e.resourceId === rid)?.filename ?? rid })))
    .filter((s) => { const e = reg!.entries.find((x) => x.resourceId === s.rid); return !e || (e.status !== "done" && e.readPct < 90); });
  const ownStars = view.sources.filter((s) => s.pinned && !s.finished).map((s) => ({ board: boardId, rid: s.id, name: s.name }));
  function star(s: ProjectSource) {
    if (s.pinned) { planApi.place(s.id, { pinned: false }); return; }
    if (otherStars.length + ownStars.length >= STAR_CAP) { setChoosing(s.id); return; }
    planApi.place(s.id, { pinned: true });
  }
  function dropStar(drop: { board: string; rid: string }, then: string) {
    setChoosing(null);
    if (drop.board === boardId) planApi.place(drop.rid, { pinned: false });
    else void planWrites.write(drop.board, planGestures.place(drop.rid, { pinned: false })).catch(() => {}).finally(() => refreshRegister());
    planApi.place(then, { pinned: true });
  }

  const members = (gid: string | null) => (gid ? view.units.find((u) => u.id === gid)?.sources ?? [] : view.loose).map((s) => s.id);
  const moveTo = (gid: string | null, item: string) => planApi.order(gid, members(gid).filter((x) => x !== item).concat(item));
  const dropOn = (key: string, gid: string | null) => ({
    onDragOver: (e: DragEvent) => { if (!drag.current) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== key) setOver(key); },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    // dropped files bubble on to the room's drop zone
    onDrop: (e: DragEvent) => { const id = drag.current; if (!id) return; e.preventDefault(); e.stopPropagation(); drag.current = null; setOver(null); moveTo(gid, id); },
  });

  const archived = !!plan.archivedAt;
  const starred = !!plan.starredAt;
  const verbs = { onDel: p.onDel ? (t: Tile) => setDeleting(t.rid ?? null) : undefined, delAsks: true, onAside: p.onAside, onDistil: p.onDistil, onDistilWarm: p.onDistilWarm, onKeep: p.onKeep, onKeepWarm: p.onKeepWarm, onDone: p.onDone };

  const sourceRow = (s: ProjectSource) => {
    const t = tileOf.get(s.id);
    const issue = p.issues[s.id];
    return <li key={s.id} className="pp-src" draggable={!archived}
      onDragStart={(e) => { drag.current = s.id; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", s.id); } catch { /* some engines refuse */ } }}
      onDragEnd={() => { drag.current = null; setOver(null); }}>
      <Dot s={s} />
      {renaming === "src:" + s.id && t && p.onRenamed
        ? <Ghost className="pp-rename" label="Source name" value={s.name} onCommit={(v) => { setRenaming(null); if (v) p.onRenamed!(t, v); }} />
        : <button className="pp-sname" disabled={!t} {...(t && p.onWarm && !t.enter ? { onPointerEnter: () => p.onWarm!(t), onPointerDown: () => p.onWarm!(t) } : {})}
            onClick={() => t && p.onOpen(t)}>{s.name}</button>}
      {t?.busy ? <span className="dk-spin" title="the model is reading this in" /> : null}
      {issue ? <span className="pp-issue">{issue.error} {issue.verb}</span> : null}
      <span className="pp-sright">
        <button className={"pp-star" + (s.pinned ? " on" : "")} aria-pressed={s.pinned} title={s.pinned ? "On Today — click to unstar" : "Star: keep it on Today"}
          aria-label={(s.pinned ? "Unstar " : "Star ") + s.name} onClick={() => star(s)}>{s.pinned ? "★" : "☆"}</button>
        {t ? <Verbs t={t} {...verbs} onRename={p.onRenamed ? () => setRenaming("src:" + s.id) : undefined} /> : null}
        {t?.del && p.onDel ? <button className="pp-del" aria-label={"Delete " + s.name} aria-expanded={deleting === s.id}
          onClick={() => setDeleting(deleting === s.id ? null : s.id)}>Delete</button> : null}
        <span className="pp-state">{s.finished ? "done" : s.pct ? `${s.pct}%` : ""}</span>
      </span>
      {deleting === s.id && t && p.onDel ? <DeleteAsk name={s.name} notes={t.marksN ?? 0} kept={t.kp?.kept ?? 0}
        onDelete={() => { setDeleting(null); p.onDel!(t); }} onCancel={() => setDeleting(null)} /> : null}
      {choosing === s.id ? <div className="pp-choose" role="dialog" aria-label="Five stars already">
        <span>Five stars already. Which one goes?</span>
        {[...ownStars, ...otherStars].map((x) => <button key={x.board + x.rid} className="pp-chip" onClick={() => dropStar(x, s.id)}>{x.name}</button>)}
        <button className="pp-link" onClick={() => setChoosing(null)}>Keep them</button>
      </div> : null}
    </li>;
  };

  const unitRow = (u: ProjectUnit, i: number) => {
    const isOpen = shown === u.id, key = "u:" + u.id;
    return <div key={u.id} className={"pp-unit" + (isOpen ? " open" : "") + (over === key ? " over" : "")} {...(archived ? {} : dropOn(key, u.id))}>
      <div className="pp-urow">
        <button className="pp-uhit" aria-expanded={isOpen} aria-label={`${isOpen ? "Close" : "Open"} unit ${u.n}`} onClick={() => setOpen(isOpen ? "" : u.id)} />
        <UnitDot u={u} />
        <span className="pp-n">{u.n}</span>
        {renaming === u.id
          ? <Ghost className="pp-uname edit" label="Unit name" value={u.name} onCommit={(v) => { setRenaming(null); if (v) planApi.group(u.id, { name: v }); }} />
          : <span className="pp-uname" onDoubleClick={() => !archived && setRenaming(u.id)}>{u.name}</span>}
        {!archived ? <span className="pp-utools">
          <button aria-label="Rename unit" onClick={() => setRenaming(u.id)}>rename</button>
          <button aria-label="Move unit up" disabled={!i} onClick={() => planApi.group(u.id, { move: -1 })}>↑</button>
          <button aria-label="Move unit down" disabled={i === view.units.length - 1} onClick={() => planApi.group(u.id, { move: 1 })}>↓</button>
          <button aria-label="Delete unit" className={arm === key ? "arm" : ""} onBlur={() => setArm(null)}
            onClick={() => { if (arm === key) { setArm(null); planApi.delGroup(u.id); } else setArm(key); }}>{arm === key ? "its sources go to loose ends — delete?" : "×"}</button>
        </span> : null}
        {archived ? null : <label className="pp-udate" title="the date this unit is meant to be done by">
          <span className={u.byDate ? "" : "none"}>{u.byDate ? `by ${shortDay(u.byDate, true)}` : "+ date"}</span>
          <input type="date" aria-label={`Unit ${u.n} date`} value={u.byDate} onChange={(e) => planApi.group(u.id, { byDate: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </label>}
        <span className="pp-ubar"><b style={{ width: `${u.sources.length ? (100 * u.done) / u.sources.length : 0}%` }} className={u.sources.length && u.done === u.sources.length ? "done" : ""} /></span>
        <span className="pp-of">{u.done} of {u.sources.length}</span>
      </div>
      {isOpen ? <ul className="pp-srcs">{u.sources.length ? u.sources.map(sourceRow) : <li className="pp-none">Empty — drag sources here.</li>}</ul> : null}
    </div>;
  };

  const pct = view.total ? (100 * view.done) / view.total : 0;
  const kept = p.tiles.reduce((n, t) => n + (t.kp ? t.kp.kept : 0), 0);
  return (
    <div className={"desk pp" + (p.over ? " over" : "")}>
      <div className="pp-wrap">
        <div className="pp-crumb">
          <button onClick={() => openTab("projects")}>Projects</button> / {archived ? "Archived" : p.head}
          {p.over ? <button className="pp-back" onClick={p.onBack} title="back to the card (esc)">the card ›</button> : null}
        </div>
        <div className="pp-head">
          <div className="pp-titles">
            {renaming === "title"
              ? <Ghost className="pp-title edit" label="Project name" value={p.head} onCommit={(v) => { setRenaming(null); if (v) void p.boardActions.rename(boardId, v); }} />
              : <h1 className="pp-title" onDoubleClick={() => setRenaming("title")}>
                {archived ? null : <button className={"pp-pstar" + (starred ? " on" : "")} aria-pressed={starred} aria-label={starred ? "Unstar this project" : "Star this project"}
                  title={starred ? "Starred: sorts first on Today and Projects. Click to unstar" : "Star: sort it first on Today and Projects"}
                  onClick={() => void planApi.project({ starred: !starred }).finally(() => refreshRegister())}>{starred ? "★" : "☆"}</button>}
                {p.head}</h1>}
            <Ghost className="pp-goal" label="What is it for?" placeholder="What is it for?" value={plan.purpose} onCommit={(v) => planApi.purpose(v)} />
          </div>
          {archived ? null : <div className="pp-total">
            <div><b>{view.done} of {view.total} sources</b>{plan.endsAt ? <span>ends {shortDay(plan.endsAt, true)}</span> : null}</div>
            <span className="pp-tbar"><b style={{ width: `${pct}%` }} /></span>
          </div>}
          <span className="pp-pop">
            <button className="pp-more" aria-label="Project menu" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}>···</button>
            {menu ? <span className="pp-menu" onClick={(e) => e.stopPropagation()}>
              <button onClick={() => { setMenu(false); setRenaming("title"); }}>Rename</button>
              {!archived ? <label className="pp-mrow">Ends <input type="date" value={plan.endsAt} onChange={(e) => planApi.project({ endsAt: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                {plan.endsAt ? <button className="pp-link" onClick={() => planApi.project({ endsAt: "" })}>no end</button> : null}</label> : null}
              {p.onCram && !archived ? <button onPointerEnter={p.onCramWarm} onPointerDown={p.onCramWarm} onClick={() => { setMenu(false); p.onCram!(); }}>Cram these cards</button> : null}
              <button onClick={() => { setMenu(false); void planApi.project({ archived: !archived }).finally(() => refreshRegister()); }}>{archived ? "Bring it back" : "Archive"}</button>
              {p.tools ? <span className="pp-mtools">{p.tools}</span> : null}
              <button className={"bad" + (arm === "board" ? " arm" : "")} onClick={() => { if (arm === "board") { setMenu(false); void p.boardActions.remove(boardId); } else setArm("board"); }}>
                {arm === "board" ? "Delete it, its sources and cards?" : "Delete"}</button>
            </span> : null}
          </span>
        </div>
        {p.work}

        {archived ? <p className="pp-archived">Archived {dayLong(plan.archivedAt!)} · {view.sources.filter((s) => s.finished).length} sources read{kept ? ` · ${kept} cards kept` : ""}</p> : null}
        {view.units.length ? <div className="pp-colhead">sources read</div> : null}
        {view.units.map(unitRow)}
        {!archived ? <button className="pp-add" onClick={() => void planApi.addGroup("New unit").then((id) => { if (id) { setOpen(id); setRenaming(id); } })}>+ unit</button> : null}

        {view.loose.length || !view.units.length ? <div className={"pp-loose" + (over === "loose" ? " over" : "")} {...(archived ? {} : dropOn("loose", null))}>
          <div className="pp-lhead"><b>{view.units.length ? `Loose ends · ${view.loose.length}` : `Sources · ${view.loose.length}`}</b>
            <span>{view.units.length ? "not in a unit yet · drag one into a unit" : view.loose.length ? "add a unit to put them in order" : "add a file or a link with + Add"}</span></div>
          <ul className="pp-srcs">{view.loose.map(sourceRow)}</ul>
        </div> : null}

        {yours.length ? <div className="pp-yours">
          <div className="pp-lhead"><b>Your cards</b></div>
          <ul className="pp-srcs">{yours.map((t) => <li key={t.key} className="pp-src"><i className="pp-dot" />
            <button className="pp-sname" onClick={() => p.onOpen(t)}>{t.label}</button><span className="pp-state">{t.meta}</span></li>)}</ul>
        </div> : null}
        {archived && kept ? <p className="pp-foot">Its {kept} kept cards keep coming back on Review.</p> : null}
      </div>
      <div className="dk-foot"><span>{p.over ? <><kbd>esc</kbd> back to the card · <kbd>b</kbd> all projects</> : <><kbd>h</kbd> this page, from anywhere · <kbd>⌘K</kbd> jump to</>}</span></div>
    </div>
  );
}
