import { useState } from "react";
import { useArchive, useRuns, type RunPress, type RunView, type RunsView } from "../../data/entities/dashboard.ts";
import { hm } from "./parts.tsx";

type Span = "hour" | "today" | "week";
const MIN = 60_000, DAY = 86_400_000;
// a block is drawn at least this share of the span wide, so its title can be read
const LEAST = 0.09;
const STEPS = [5, 15, 30, 60, 180, 360, 720, 1440].map((m) => m * MIN);
const LANDS: Record<string, string> = { decide: "Decide", review: "Review", finish: "Finish", done: "Finish" };

export const dur = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / MIN));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${Math.round(m / 144) / 10} d`;
};
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const end = (p: RunPress, now: number): number => p.posted?.at ?? (p.open === "holding" ? now : p.at);
const outcome = (p: RunPress): string => p.posted ? `→ ${LANDS[p.posted.lands] ?? p.posted.lands} · v${p.posted.n}` : p.open === "holding" ? "holding, no page yet" : `no page · ${p.open}`;

/** The window a span shows: an hour back, today from its first press, or the week. */
export function windowOf(span: Span, v: RunsView): [number, number] {
  const to = v.now;
  if (span === "hour") return [to - 60 * MIN, to];
  if (span === "week") return [v.since, to];
  const midnight = new Date(to).setHours(0, 0, 0, 0);
  const first = Math.min(...v.runs.flatMap((r) => r.presses.map((p) => p.at)).filter((at) => at >= midnight), to - 60 * MIN);
  return [Math.max(midnight, Math.floor(first / (15 * MIN)) * 15 * MIN), to];
}

/** Lays a run's presses into as few rows as keep them from overlapping, each at least `least` ms wide as drawn. */
export function rows(presses: RunPress[], now: number, least = 0): RunPress[][] {
  const out: { till: number; list: RunPress[] }[] = [];
  for (const p of [...presses].sort((a, b) => a.at - b.at)) {
    const row = out.find((r) => r.till <= p.at) ?? (out.push({ till: 0, list: [] }), out[out.length - 1]);
    row.list.push(p);
    row.till = Math.max(end(p, now), p.at + Math.max(least, 1));
  }
  return out.map((r) => r.list);
}

/** Runs: who held which thread and how long a press took to come back as a page; read only, loaded when opened. The archive sits under it. */
export default function Runs() {
  const v = useRuns();
  const [span, setSpan] = useState<Span>("today");
  const [pick, setPick] = useState<string | null>(null);
  if (!v) return <div className="runs"><p className="ws-none">Loading…</p></div>;
  const [from, to] = windowOf(span, v);
  const shown = v.runs.map((r) => ({ ...r, presses: r.presses.filter((p) => end(p, v.now) >= from && p.at <= to) })).filter((r) => r.presses.length);
  const all = shown.flatMap((r) => r.presses);
  const posted = all.filter((p) => p.posted);
  const waits = posted.map((p) => p.posted!.at - p.at);
  const holding = all.filter((p) => p.open === "holding").sort((a, b) => a.at - b.at);
  const slowest = [...posted].sort((a, b) => (b.posted!.at - b.at) - (a.posted!.at - a.at))[0];
  const mid = median(waits);
  const step = STEPS.find((s) => (to - from) / s <= 8) ?? DAY;
  const ticks: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) ticks.push(t);
  const x = (at: number) => `${((Math.min(Math.max(at, from), to) - from) / (to - from)) * 100}%`;
  const tick = (t: number) => (step >= DAY ? new Date(t).toLocaleDateString([], { weekday: "short", day: "numeric" }) : hm(t));
  const picked = shown.find((r) => r.key === pick) ?? null;

  return <div className="runs">
    <div className="runs-head">
      <h2>Runs</h2>
      <i>Who held what, and when · {span === "week" ? "this week" : span === "hour" ? "the last hour" : "today"} {hm(from)}–{hm(to)}</i>
      <span className="grow" />
      <span className="tr-area small" role="tablist" aria-label="Span">
        {(["hour", "today", "week"] as Span[]).map((s) => <button key={s} role="tab" aria-selected={span === s} onClick={() => setSpan(s)}>{s === "hour" ? "Hour" : s === "today" ? "Today" : "Week"}</button>)}
      </span>
    </div>
    <div className="runs-tiles">
      <div><b>{shown.length}</b><span>{shown.length === 1 ? "run" : "runs"} · {all.length} {all.length === 1 ? "press" : "presses"}</span></div>
      <div><b>{new Set(all.map((p) => p.task)).size}</b><span>threads handled · {posted.length} posted</span></div>
      <div><b>{mid === null ? "–" : dur(mid)}</b><span>median, press to page</span></div>
      <div><b>{slowest ? dur(slowest.posted!.at - slowest.at) : "–"}</b><span>{slowest ? `slowest · ${slowest.title}` : "slowest"}</span></div>
      <div className={holding.length ? "warn" : undefined}><b>{holding.length}</b><span>{holding.length ? `holding, no page yet · ${holding[0].title}` : "holding, no page yet"}</span></div>
    </div>
    <div className="runs-chart">
      <div className="runs-axis"><span /><div>{ticks.map((t) => <i key={t} style={{ left: x(t) }}>{tick(t)}</i>)}</div></div>
      <div className="runs-lanes">
        <div className="runs-grid" aria-hidden="true">{ticks.map((t) => <i key={t} style={{ left: x(t) }} />)}<b style={{ left: x(v.now) }} /></div>
        {shown.map((r, i) => <Lane key={r.key} n={i + 1} run={r} now={v.now} x={x} least={(to - from) * LEAST} on={pick === r.key} onPick={() => setPick(pick === r.key ? null : r.key)} />)}
        {!shown.length ? <p className="ws-none">No presses in this span. A Send in Dispatch starts a run.</p> : null}
      </div>
    </div>
    <div className="runs-legend"><span className="posted">posted a page</span><span className="holding">holding, no page yet</span><span className="none">no page: pressed again or moved</span>
      {v.ranAt ? <span className="ran">last Run now · {hm(v.ranAt)}{v.ranSession ? <> · <a href={v.ranSession} target="_blank" rel="noopener">session ↗</a></> : null}</span> : null}</div>
    {picked ? <Detail n={shown.indexOf(picked) + 1} run={picked} onClose={() => setPick(null)} /> : null}
    <Archive />
  </div>;
}

function Lane({ n, run, now, x, least, on, onPick }: { n: number; run: RunView; now: number; x(at: number): string; least: number; on: boolean; onPick(): void }) {
  const first = run.presses[0];
  return <div className={"runs-lane" + (on ? " on" : "")}>
    <button className="runs-name" onClick={onPick}><b>Run {n} · {hm(run.at)}</b><span>{first.label} · {first.title}</span></button>
    <div className="runs-rows">
      {rows(run.presses, now, least).map((row, i) => <div key={i} className="runs-row">
        {row.map((p) => <button key={p.id} onClick={onPick} title={`${p.title}\n${p.label} ${hm(p.at)} · ${outcome(p)}${p.posted ? ` · ${dur(p.posted.at - p.at)}` : ""}`}
          className={"runs-block " + (p.posted ? "posted" : p.open === "holding" ? "holding" : "none")}
          style={{ left: x(p.at), width: `max(calc(${x(end(p, now))} - ${x(p.at)}), ${LEAST * 100}%)` }}>
          <b>{p.title}</b><span>{p.posted ? `${dur(p.posted.at - p.at)} ${outcome(p)}` : outcome(p)}</span>
        </button>)}
      </div>)}
    </div>
  </div>;
}

function Detail({ n, run, onClose }: { n: number; run: RunView; onClose(): void }) {
  const events = run.presses.flatMap((p) => [
    { at: p.at, text: `${p.label}${p.version ? ` on v${p.version}` : ""} · ${p.title}` },
    ...(p.posted ? [{ at: p.posted.at, text: `v${p.posted.n} posted → ${LANDS[p.posted.lands] ?? p.posted.lands}, after ${dur(p.posted.at - p.at)}` }] : []),
  ]).sort((a, b) => a.at - b.at);
  return <aside className="runs-detail" aria-label={`Run ${n}`}>
    <header><b>Run {n} · {run.presses[0].title}</b><button className="btn quiet small" onClick={onClose} aria-label="Close">✕</button></header>
    <ol>{events.map((e, i) => <li key={i}><i>{hm(e.at)}</i>{e.text}</li>)}</ol>
    {run.sessionUrl ? <a href={run.sessionUrl} target="_blank" rel="noopener">Open the run's session ↗</a> : <span className="none">No session: the routine wasn't woken for this press.</span>}
  </aside>;
}

// The archive lives with the runs: Dispatch threads archived or dropped, read only when this view opens.
function Archive() {
  const list = (useArchive(true) ?? []).filter((t) => t.dispatched).slice(0, 40);
  return <section className="runs-archive" aria-label="Archived">
    <h3 className="cap">Archived</h3>
    {list.map((x) => <div key={x.id} className="ws-done"><span>{x.title}</span><i>{x.stage === "dropped" ? "dropped" : "archived"} · {new Date(x.clearedAt ?? x.updatedAt).toLocaleDateString([], { day: "numeric", month: "short" })}</i></div>)}
    {!list.length ? <p className="ws-none">Nothing archived yet.</p> : null}
  </section>;
}
