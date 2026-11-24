// Runs: each routine run Dispatch woke, the threads it was woken for, and how long each took from the press to a page.
import { useState } from "react";
import { useRuns, type RunBlock } from "../../data/entities/dashboard.ts";
import { hm } from "./parts.tsx";

const MIN = 60_000;
const dayOf = (t: number): string => new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
const mins = (b: RunBlock): number | null => (b.posted === null ? null : Math.max(1, Math.round((b.posted - b.pressed) / MIN)));
const LANDED: Record<string, string> = { decide: "a proposal", review: "built", finish: "finished", done: "finished" };

/** Blocks that overlap in time go on separate rows of their run's lane. */
function rows(blocks: RunBlock[], now: number): RunBlock[][] {
  const out: RunBlock[][] = [];
  for (const b of [...blocks].sort((x, y) => x.pressed - y.pressed)) {
    const row = out.find((r) => (r[r.length - 1].posted ?? now) <= b.pressed);
    if (row) row.push(b); else out.push([b]);
  }
  return out;
}

export default function Runs({ onPick }: { onPick(task: string): void }) {
  const r = useRuns(true);
  const now = Date.now();
  const all = (r?.runs ?? []).flatMap((l) => l.blocks);
  const days = [...new Set(all.sort((a, b) => b.pressed - a.pressed).map((b) => dayOf(b.pressed)))];
  const [pick, setPick] = useState<string | null>(null);
  const day = pick && days.includes(pick) ? pick : days[0];
  const lanes = (r?.runs ?? []).map((l) => ({ ...l, blocks: l.blocks.filter((b) => dayOf(b.pressed) === day) })).filter((l) => l.blocks.length)
    .sort((a, b) => Math.min(...a.blocks.map((x) => x.pressed)) - Math.min(...b.blocks.map((x) => x.pressed)));
  const blocks = lanes.flatMap((l) => l.blocks);
  if (!r) return <div className="runs"><p className="runs-none">Loading runs…</p></div>;
  if (!blocks.length) return <div className="runs"><h2>Runs</h2><p className="runs-none">No run in the last 7 days. Each Send wakes one, and it shows here.</p></div>;

  const t0 = Math.min(...blocks.map((b) => b.pressed)) - 5 * MIN;
  const t1 = Math.max(...blocks.map((b) => b.posted ?? now)) + 5 * MIN;
  const pct = (t: number): number => ((t - t0) / (t1 - t0)) * 100;
  const x = (t: number): string => `${pct(t)}%`;
  const ticks: number[] = [];
  const step = t1 - t0 > 6 * 60 * MIN ? 120 * MIN : t1 - t0 > 2 * 60 * MIN ? 60 * MIN : 15 * MIN;
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) ticks.push(t);
  const took = blocks.map(mins).filter((m): m is number => m !== null).sort((a, b) => a - b);
  const median = took.length ? took[Math.floor(took.length / 2)] : null;
  const open = blocks.filter((b) => b.posted === null).length;

  return <div className="runs" aria-label="Runs">
    <header className="runs-head">
      <h2>Runs</h2>
      <nav className="runs-days" aria-label="Day">{days.map((d) => <button key={d} aria-pressed={d === day} onClick={() => setPick(d)}>{d}</button>)}</nav>
    </header>
    <div className="runs-stats">
      <div><b>{lanes.length}</b><span>{lanes.length === 1 ? "run" : "runs"}</span></div>
      <div><b>{new Set(blocks.map((b) => b.task)).size}</b><span>threads worked</span></div>
      <div><b>{median === null ? "–" : `${median} min`}</b><span>median press → page</span></div>
      <div className={open ? "wait" : ""}><b>{open}</b><span>still with Claude</span></div>
    </div>
    <div className="runs-chart">
      <div className="runs-axis">{ticks.map((t) => <span key={t} style={{ left: x(t) }}>{hm(t)}</span>)}</div>
      {lanes.map((l, i) => <div key={l.session ?? `none-${i}`} className="runs-lane">
        <div className="runs-who"><b>Run {i + 1}</b>{l.session ? <a href={l.session} target="_blank" rel="noopener">session ↗</a> : <span>no session</span>}</div>
        <div className="runs-track">
          {ticks.map((t) => <i key={t} style={{ left: x(t) }} />)}
          {rows(l.blocks, now).map((row, ri) => <div key={ri} className="runs-row">{row.map((b) => {
            const m = mins(b), end = b.posted ?? now;
            return <button key={`${b.task}-${b.pressed}`} className={`runs-block ${b.landed ?? "open"}`} style={{ left: x(b.pressed), width: `max(${pct(end) - pct(b.pressed)}%, 28px)` }}
              title={`${b.title}\n${b.kind} ${hm(b.pressed)} → ${b.posted ? `${LANDED[b.landed ?? ""] ?? b.landed} ${hm(b.posted)} (${m} min)` : "still with Claude"}`}
              onClick={() => onPick(b.task)}>
              <span>{b.title}</span><em>{m === null ? "…" : `${m}m`}</em>
            </button>;
          })}</div>)}
        </div>
      </div>)}
    </div>
    <p className="runs-key"><span className="k decide" />proposal <span className="k review" />built <span className="k finish" />finished <span className="k open" />still with Claude · a block runs from the press to the page it brought</p>
  </div>;
}
