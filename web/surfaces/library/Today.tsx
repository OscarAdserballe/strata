import { useEffect, useMemo, useState } from "react";
import type { RegisterResponse } from "../../../shared/types/index.ts";
import type { ReviewStrip } from "../../data/entities/review.ts";
import { refreshRegister } from "../../data/entities/register.ts";
import { plan, planGestures } from "../../data/entities/plan.ts";
import { StrataWhy } from "../../data/api.ts";
import { foldDays } from "../../capabilities/today/days.ts";
import DayGrid from "../../capabilities/today/DayGrid.tsx";
import { endLabel, projectView, readingList, starCount, STAR_CAP, type ProjectView, type ReadingRow } from "../../capabilities/today/projects.ts";
import { courseOf } from "../../shell/format.js";
import "./today.css";

// A kept star is this device's: "still reading this?" is asked again a fortnight after it was answered.
const keptKey = (id: string) => `strata.starKept.${id}`;
const keptAt = (id: string): number => { try { return Number(localStorage.getItem(keptKey(id)) || 0); } catch { return 0; } };

export const minutesFor = (cards: number): number => Math.max(1, Math.round(cards / 2));
const dateLine = (d = new Date()) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

export interface TodayProps {
  reg: RegisterResponse | null;
  review: ReviewStrip | null;
  onReview(): void;
  onOpen(board: string, source?: string): void;
  onWarm?: (board: string) => void;
  onProjects(): void;
  error: string;
}

export default function Today({ reg, review, onReview, onOpen, onWarm, onProjects, error }: TodayProps) {
  const [unstarred, setUnstarred] = useState<string[]>([]);
  const [anyway, setAnyway] = useState(false);
  const [why, setWhy] = useState("");
  const [, setKept] = useState(0);
  const views = useMemo<ProjectView[]>(() => (reg ? reg.projects.map((p) => projectView(p, reg.entries)) : []), [reg]);
  const days = useMemo(() => (reg ? foldDays(reg.hours ?? []) : null), [reg]);
  useEffect(() => { setUnstarred([]); }, [reg]);
  const reading = readingList(views, keptAt).filter((r) => !unstarred.includes(r.source.id));
  const active = views.filter((v) => !v.project.archivedAt)
    .sort((a, b) => (a.project.endsAt || "9999").localeCompare(b.project.endsAt || "9999") || (b.project.touchedAt ?? 0) - (a.project.touchedAt ?? 0));
  const stars = starCount(views) - unstarred.length;
  const warm = (board: string) => (onWarm ? { onPointerEnter: () => onWarm(board), onPointerDown: () => onWarm(board) } : {});

  function unstar(r: ReadingRow) {
    setUnstarred((x) => x.concat(r.source.id));
    plan.write(r.source.board, planGestures.place(r.source.id, { pinned: false }))
      .catch((e: unknown) => { setUnstarred((x) => x.filter((id) => id !== r.source.id)); setWhy(StrataWhy(e, "couldn't unstar that")); })
      .finally(() => refreshRegister());
  }
  function keep(r: ReadingRow) { try { localStorage.setItem(keptKey(r.source.id), String(Date.now())); } catch { /* private window */ } setKept((n) => n + 1); }

  const due = review ? review.total : 0;
  const byProject = new Map<string, number>();
  for (const c of review?.cards ?? []) { const k = c.project || courseOf(c.courseTitle); byProject.set(k, (byProject.get(k) || 0) + 1); }

  const todayCards = days ? days.today.cards : 0;
  if (review && !due && todayCards > 0 && !anyway && days) {
    const tomorrow = (review.ahead ?? []).filter((t) => t - Date.now() < 864e5 * 1.5).length;
    const read = Math.round(days.today.ms / 60_000);
    return <div className="today clear">
      <div className="td-eyebrow">{dateLine()}</div>
      <h1>You’re clear.</h1>
      <p className="td-sum">{todayCards} card{todayCards === 1 ? "" : "s"}{read ? `, ${read} minute${read === 1 ? "" : "s"} of reading` : ""} today.<br />
        {tomorrow ? `Tomorrow: ${tomorrow} card${tomorrow === 1 ? "" : "s"} (about ${minutesFor(tomorrow)} minute${minutesFor(tomorrow) === 1 ? "" : "s"}).` : "Nothing due tomorrow."}</p>
      <div className="td-clear-row">
        <div className="td-big"><b>{days.total}</b><span>days with Strata</span></div>
        <div className="td-big streak"><b>{days.streak}</b><span>in a row</span></div>
        <div><DayGrid days={days} big /><span className="td-cap">26 weeks · ink = minutes read and reviewed</span></div>
      </div>
      <div className="td-clear-go">
        <button className="td-btn" onClick={() => setAnyway(true)}>Keep reading anyway</button>
        <button className="td-btn" onClick={onProjects}>Projects</button>
      </div>
    </div>;
  }

  return (
    <div className="today">
      <main className="td-main">
        <div className="td-eyebrow">{dateLine()}</div>
        <h1>Today</h1>
        {error || why ? <div className="rg-err" role="alert">{error || why}</div> : null}

        <section className="td-sec" aria-label="Review">
          <div className="td-head"><h2>Review</h2><span>kept cards due today</span></div>
          {due ? <div className="td-review">
            <div>
              <div className="td-min">About {minutesFor(due)} minute{minutesFor(due) === 1 ? "" : "s"}</div>
              <div className="td-from">{due} card{due === 1 ? "" : "s"}{[...byProject].slice(0, 4).map(([k, n]) => ` · ${k} ${n}`).join("")}</div>
            </div>
            <button className="td-primary" onClick={onReview}>Start review</button>
          </div> : <p className="td-quiet">{!review ? "Checking your cards…" : review.nextDueAt ? "Nothing due. Your next cards come back " + until(review.nextDueAt) + "." : "Cards you keep come back here."}</p>}
        </section>

        <section className="td-sec" aria-label="Reading">
          <div className="td-head"><h2>Reading</h2><span>what you starred, and what you’re partway through · {stars} of {STAR_CAP} ★</span></div>
          {reg === null ? <p className="td-quiet">Reading the room…</p>
            : !reading.length ? <p className="td-quiet">Nothing open. Star a source on a project page to keep it here.</p>
            : reading.map((r, i) => <div key={r.source.id} className={"td-row" + (r.stale ? " stale" : "")}>
              <span className="td-meta">{r.source.pinned ? "★ " : ""}{r.stale ? `${Math.round((Date.now() - Math.max(r.source.lastAt, r.source.createdAt)) / 864e5)} d` : r.source.pct ? `${r.source.pct}%` : ""}</span>
              <div className="td-what">
                <div><span className="td-title">{r.source.name}</span> <span className="td-where">{r.project.project.title}{r.unit ? ` · Unit ${r.unit.n}` : ""}</span></div>
                {r.stale ? <div className="td-note">Starred and not opened in a fortnight. Still reading this?</div>
                  : r.source.pct ? <div className="td-bar"><b style={{ width: `${r.source.pct}%` }} /></div>
                  : <div className="td-note">Not started.</div>}
              </div>
              {r.stale ? <span className="td-acts">
                <button className="td-btn" onClick={() => keep(r)}>Keep ★</button>
                <button className="td-link" onClick={() => unstar(r)}>unstar</button>
              </span> : <button className={i === 0 && r.source.pct ? "td-primary small" : "td-btn"} {...warm(r.source.board)}
                onClick={() => onOpen(r.source.board, r.source.id)}>{r.source.pct ? "Resume" : "Open"}</button>}
            </div>)}
          <p className="td-foot">Star any source from its project. Up to {STAR_CAP}; a sixth asks which to drop.</p>
        </section>
      </main>

      <aside className="td-side">
        {days ? <div className="td-counter">
          <div className="td-day"><b>Day {days.total}</b><span>{days.streak} in a row</span></div>
          <DayGrid days={days} />
        </div> : null}
        <div className="td-head small"><span>Projects</span><span>{active.length} active</span></div>
        {active.map((v) => <button key={v.project.id} className="td-proj" {...warm(v.project.id)} onClick={() => onOpen(v.project.id)}>
          <span className="td-proj-top"><span className="td-proj-name">{v.project.title}</span><span className="td-end">{endLabel(v.project)}</span></span>
          {v.next || v.due || v.fresh ? <span className="td-next">{v.next ? <>Next: {v.next}</> : null}
            {v.due ? <i className="td-mark due">due {v.due}</i> : null}{v.fresh ? <i className="td-mark new">{v.fresh} new</i> : null}</span> : null}
          <span className="td-prog"><span className="td-bar"><b style={{ width: `${v.total ? (100 * v.done) / v.total : 0}%` }} /></span><span>{v.done}/{v.total}</span></span>
        </button>)}
        {reg && !active.length ? <p className="td-quiet">No projects yet. <button className="td-link" onClick={onProjects}>Start one</button></p> : null}
      </aside>
    </div>
  );
}

function until(ts: number): string {
  const h = Math.max(0, (ts - Date.now()) / 36e5);
  if (h < 20) return "later today";
  if (h < 40) return "tomorrow";
  return `in ${Math.round(h / 24)} days`;
}
