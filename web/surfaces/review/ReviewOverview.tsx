import { useMemo } from "react";
import type { RegisterResponse, ReviewCard, ReviewState } from "../../../shared/types/index.ts";
import { useEntity } from "../../data/store.ts";
import { REGISTER } from "../../data/entities/sources.ts";
import { dayKey, foldDays } from "../../capabilities/today/days.ts";
import DayGrid from "../../capabilities/today/DayGrid.tsx";
import { courseOf } from "../../shell/format.js";
import "./review-overview.css";

export const projectOf = (c: Pick<ReviewCard, "project" | "courseTitle">): string => c.project || courseOf(c.courseTitle) || "Unfiled";
export const minutesFor = (cards: number): number => Math.max(1, Math.round(cards / 2));

export interface ReviewOverviewProps {
  state: ReviewState | null;
  cards: readonly ReviewCard[];
  skip: readonly string[];
  onSkip(project: string, skip: boolean): void;
  onStart(): void;
}

/** The tab before the cards: one start, which projects are in it, the coming week and where the kept cards stand. */
export default function ReviewOverview({ state, cards, skip, onSkip, onStart }: ReviewOverviewProps) {
  const reg = useEntity<RegisterResponse>(REGISTER);
  const days = useMemo(() => (reg && reg.hours ? foldDays(reg.hours) : null), [reg && reg.hours]);
  const by = new Map<string, ReviewCard[]>();
  for (const c of cards) { const k = projectOf(c); by.set(k, (by.get(k) ?? []).concat(c)); }
  const rows = [...by].sort((a, b) => b[1].length - a[1].length);
  const most = Math.max(1, ...rows.map(([, l]) => l.length));
  const n = cards.filter((c) => !skip.includes(projectOf(c))).length;
  const projects = rows.filter(([k]) => !skip.includes(k)).length;

  // the coming week, in the reader's own days: today's queue, then what arrives each day after
  const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return { key: dayKey(d), label: i ? d.toLocaleDateString(undefined, { weekday: "short" }) : "today", n: i ? 0 : n }; });
  for (const t of state?.ahead ?? []) { const w = week.find((x) => x.key === dayKey(new Date(t))); if (w && w.label !== "today") w.n++; }
  const peak = Math.max(1, ...week.map((w) => w.n));
  const rungs = state?.rungs ?? [], ladder = state?.ladder ?? [];
  const keptN = rungs.reduce((a, b) => a + b, 0), shelf = Math.max(1, ...rungs);

  return (
    <div className="rv">
      <main className="rv-main">
        <div className="rv-eyebrow">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div>
        <h1>Review</h1>
        <div className="rv-start">
          <div>
            <div className="rv-min">About {minutesFor(n)} minute{minutesFor(n) === 1 ? "" : "s"}</div>
            <p>{n} card{n === 1 ? " is" : "s are"} due today{projects > 1 ? `, from ${projects} projects` : ""}. Then you’re done: the rest wait for their day.</p>
          </div>
          <button className="rv-go" disabled={!n} onClick={onStart}>Start <kbd>space</kbd></button>
        </div>

        <div className="rv-head"><h2>Today’s cards</h2><span>untick a project to leave its cards for tomorrow</span></div>
        {rows.map(([k, list]) => {
          const off = skip.includes(k);
          return <label key={k} className={"rv-proj" + (off ? " off" : "")}>
            <input type="checkbox" checked={!off} onChange={(e) => onSkip(k, !e.target.checked)} />
            <span className="rv-pname">{k}</span>
            <span className="rv-pbar"><b style={{ width: `${(100 * list.length) / most}%` }} /></span>
            <span className="rv-pn">{list.length}</span>
          </label>;
        })}

        <div className="rv-head"><h2>The coming week</h2><span>what comes back each day</span></div>
        <div className="rv-week" aria-label="Cards due each day this week">
          {week.map((w, i) => <div key={w.key} className="rv-day">
            <span className={"rv-col" + (i ? "" : " now")} style={{ height: `${8 + (52 * w.n) / peak}px` }} />
            <span className="rv-dlabel">{w.label} {w.n}</span>
          </div>)}
        </div>
      </main>

      <aside className="rv-side">
        {days ? <>
          <div className="rv-eyebrow">Your days</div>
          <div className="rv-nums"><div><b>{days.total}</b><span>days</span></div><div className="streak"><b>{days.streak}</b><span>in a row</span></div></div>
          <DayGrid days={days} />
        </> : null}
        {keptN ? <>
          <div className="rv-eyebrow gap">Where your {keptN.toLocaleString()} kept cards are</div>
          {rungs.map((r, i) => <div key={i} className="rv-shelf">
            <span>{ladder[i] ?? "?"} days</span><span className="rv-sbar"><b style={{ width: `${(100 * r) / shelf}%` }} /></span><span>{r}</span>
          </div>)}
          <p className="rv-note">A card climbs one rung each time you get it and drops one when you miss it; each date carries a little jitter so cards don’t bunch. The higher the shelf, the longer you’ve held it.</p>
        </> : null}
      </aside>
    </div>
  );
}
