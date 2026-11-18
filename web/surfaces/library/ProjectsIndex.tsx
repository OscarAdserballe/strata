import { useMemo, useState } from "react";
import type { RegisterResponse } from "../../../shared/types/index.ts";
import StarProject from "../../capabilities/today/StarProject.tsx";
import { activeProjects, daysUntil, projectView, shortDay, type ProjectView } from "../../capabilities/today/projects.ts";
import "./projects.css";

export interface ProjectsIndexProps {
  reg: RegisterResponse | null;
  onOpen(board: string): void;
  onWarm?: (board: string) => void;
  onNew(): void;
}

function ends(v: ProjectView): string {
  const p = v.project;
  if (!p.endsAt) return "no end";
  const n = daysUntil(p.endsAt);
  return `ends ${shortDay(p.endsAt)}${n !== null && n >= 0 ? ` · ${n} day${n === 1 ? "" : "s"}` : ""}`;
}

/** one segment per unit: green finished, blue started, grey not yet */
const Segments = ({ v }: { v: ProjectView }) => v.units.length ? <div className="pj-segs" aria-hidden="true">
  {v.units.map((u) => <i key={u.id} className={u.sources.length && u.done === u.sources.length ? "done" : u.done || u.sources.some((s) => s.pct > 0) ? "on" : ""} />)}
</div> : null;

export default function ProjectsIndex({ reg, onOpen, onWarm, onNew }: ProjectsIndexProps) {
  const [shelf, setShelf] = useState<"active" | "archived">("active");
  const views = useMemo<ProjectView[]>(() => (reg ? reg.projects.map((p) => projectView(p, reg.entries)) : []), [reg]);
  const active = activeProjects(views);
  const anyStar = active.some((v) => v.project.starredAt);
  const archived = views.filter((v) => v.project.archivedAt).sort((a, b) => (b.project.archivedAt ?? 0) - (a.project.archivedAt ?? 0));
  const shown = shelf === "active" ? active : archived;
  return (
    <div className="projects">
      <div className="pj-head">
        <div>
          <div className="td-eyebrow">Projects</div>
          <h1>What you’re working through</h1>
        </div>
        <div className="pj-shelves">
          <button className={"pj-pill" + (shelf === "active" ? " on" : "")} aria-pressed={shelf === "active"} onClick={() => setShelf("active")}>Active {active.length}</button>
          <button className={"pj-pill" + (shelf === "archived" ? " on" : "")} aria-pressed={shelf === "archived"} onClick={() => setShelf("archived")}>Archived {archived.length}</button>
          <button className="td-primary small" onClick={onNew}>New project</button>
        </div>
      </div>
      {reg === null ? <p className="td-quiet">Reading the room…</p>
        : !shown.length ? <p className="td-quiet">{shelf === "active" ? "No projects yet. Start one with New project." : "Nothing archived. A finished project goes here, and its kept cards keep coming back on Review."}</p>
        : <div className="pj-grid">
          {shown.map((v) => <div key={v.project.id} className={"pj-cell" + (shelf === "active" && anyStar && !v.project.starredAt ? " quiet" : "")}>
            {shelf === "active" ? <StarProject className="pj-star" board={v.project.id} title={v.project.title} starred={!!v.project.starredAt} /> : null}
            <button className={"pj-card" + (v.project.starredAt && shelf === "active" ? " starred" : "")} onClick={() => onOpen(v.project.id)}
            {...(onWarm ? { onPointerEnter: () => onWarm(v.project.id), onPointerDown: () => onWarm(v.project.id) } : {})}>
            <span className="td-eyebrow">{v.project.archivedAt ? `archived ${new Date(v.project.archivedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ends(v)}</span>
            <span className="pj-title">{v.project.title}</span>
            {v.project.purpose ? <span className="pj-goal">{v.project.purpose}</span> : null}
            <span className="td-prog"><span className="td-bar"><b style={{ width: `${v.total ? (100 * v.done) / v.total : 0}%` }} /></span><span>{v.done} of {v.total}</span></span>
            <Segments v={v} />
            {v.next || v.loose.length ? <span className="pj-next">{v.next ? <>Next: <b>{v.next}</b></> : null}
              {v.units.length && v.loose.length ? `${v.next ? " · " : ""}${v.loose.length} in loose ends` : ""}</span> : null}
          </button></div>)}
        </div>}
    </div>
  );
}
