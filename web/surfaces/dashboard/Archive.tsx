import { useState } from "react";
import { useArchive, useRuns, type RunBlock, type RunLane } from "../../data/entities/dashboard.ts";
import { hm } from "./parts.tsx";

const MIN = 60_000, DAY = 86_400_000;
const midnight = (back: number): number => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() - back * DAY; };
const mins = (ms: number): string => (ms < 90 * MIN ? `${Math.max(1, Math.round(ms / MIN))} min` : `${(ms / 3_600_000).toFixed(ms < 10 * 3_600_000 ? 1 : 0)} h`);
const day = (at: number): string => new Date(at).toLocaleDateString([], { weekday: "short", day: "numeric" });

/** Archive: Dispatch's past. Runs on top (one lane per routine run, a block per press it held), the archived threads under it. */
export default function Archive() {
  const [span, setSpan] = useState<"today" | "week">("today");
  return <div className="arc">
    <Runs key={span} span={span} onSpan={setSpan} />
    <Archived />
  </div>;
}

function Runs({ span, onSpan }: { span: "today" | "week"; onSpan(s: "today" | "week"): void }) {
  const [since] = useState(() => midnight(span === "week" ? 6 : 0));
  const data = useRuns(since);
  const [pick, setPick] = useState<RunBlock | null>(null);
  const lanes = data?.runs ?? [];
  const first = Math.min(...lanes.flatMap((l) => l.blocks.map((b) => b.from)));
  const hi = data?.until ?? Date.now();
  const lo = Number.isFinite(first) ? Math.max(since, first - (hi - first) * 0.04 - 5 * MIN) : since;
  const s = data?.stats;
  return <section className="arc-runs" aria-label="Runs">
    <header className="arc-head">
      <h2>Runs</h2><span className="sub">Who held what, and how long each page took · {span === "today" ? "today" : "the last 7 days"}</span>
      <span className="seg" role="tablist">{(["today", "week"] as const).map((x) =>
        <button key={x} role="tab" aria-selected={span === x} onClick={() => onSpan(x)}>{x === "today" ? "Today" : "Week"}</button>)}</span>
    </header>
    {!data ? <p className="arc-none">Loading…</p> : !lanes.length ? <p className="arc-none">No runs {span === "today" ? "today" : "this week"}. A Send starts one.</p> : <>
      <div className="arc-stats">
        <div><b>{s!.runs}</b>{s!.runs === 1 ? "run" : "runs"} · {s!.threads} {s!.threads === 1 ? "thread" : "threads"}</div>
        <div><b>{s!.medianMs === null ? "–" : mins(s!.medianMs)}</b>median from Send to page</div>
        <div><b>{s!.posted}</b>{s!.posted === 1 ? "page" : "pages"} posted</div>
        <div className={s!.open ? "open" : undefined}><b>{s!.open}</b>with Claude now</div>
      </div>
      <Timeline lanes={lanes} lo={lo} hi={hi} pick={pick} onPick={setPick} />
      {pick ? <Picked b={pick} lane={lanes.find((l) => l.blocks.includes(pick))!} /> : <p className="arc-hint">Click a block for what that press led to.</p>}
    </>}
  </section>;
}

const STEPS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * MIN);
function Timeline({ lanes, lo, hi, pick, onPick }: { lanes: RunLane[]; lo: number; hi: number; pick: RunBlock | null; onPick(b: RunBlock): void }) {
  const x = (at: number): number => ((at - lo) / (hi - lo)) * 100;
  const step = STEPS.find((st) => (hi - lo) / st <= 8) ?? DAY;
  const ticks: number[] = [];
  for (let at = Math.ceil(lo / step) * step; at <= hi; at += step) ticks.push(at);
  return <div className="arc-time">
    <div className="arc-axis">{ticks.map((at) => <span key={at} style={{ left: `${x(at)}%` }}>{step >= DAY ? day(at) : hm(at)}</span>)}</div>
    {lanes.map((l) => {
      // presses a run held at once take rows of their own
      const rows: number[] = [], at = l.blocks.map((b) => { const end = b.to ?? hi; let r = rows.findIndex((e) => e <= b.from); if (r < 0) r = rows.length; rows[r] = end; return r; });
      return <div key={l.session ?? l.blocks[0].from} className="arc-lane">
        <div className="who"><b>{step >= DAY ? `${day(l.start)} ` : ""}{hm(l.start)}</b><span>{l.blocks[0].press} · {l.blocks[0].title}</span></div>
        <div className="track" style={{ height: rows.length * 34 + 8 }}>
          {ticks.map((t) => <i key={t} style={{ left: `${x(t)}%` }} />)}
          {l.blocks.map((b, i) => <button key={i} className={"blk" + (b.posted === null ? (b.to === null ? " open" : " none") : "") + (b === pick ? " on" : "")}
            style={{ left: `${x(b.from)}%`, width: `max(10px, ${x(b.to ?? hi) - x(b.from)}%)`, top: at[i] * 34 + 4 }}
            title={`${b.title} · ${b.posted !== null ? `v${b.posted} after ${mins(b.to! - b.from)}` : b.to === null ? "with Claude" : "no page"}`} onClick={() => onPick(b)}>
            <b>{b.title}</b><span>{b.posted !== null ? `v${b.posted} → ${b.landed === "review" ? "Review" : b.landed === "finish" ? "Finish" : "Decide"}` : b.to === null ? "with Claude" : "no page"}</span>
          </button>)}
        </div>
      </div>;
    })}
  </div>;
}

function Picked({ b, lane }: { b: RunBlock; lane: RunLane }) {
  return <div className="arc-pick">
    <b>{b.title}</b>
    <span>{b.press} at {hm(b.from)} · {b.posted !== null ? `v${b.posted} posted at ${hm(b.to!)}, ${mins(b.to! - b.from)} later` : b.to === null ? `with Claude for ${mins(Date.now() - b.from)}` : "pressed again before a page came"}</span>
    {lane.session ? <a href={lane.session} target="_blank" rel="noopener">Open the run's session ↗</a> : null}
  </div>;
}

// The Dispatch threads you archived or dropped, newest first.
function Archived() {
  const list = (useArchive(true) ?? []).filter((t) => t.dispatched).slice(0, 60);
  return <section className="arc-done" aria-label="Archived">
    <h2>Archived</h2>
    {list.map((x) => <div key={x.id} className="ws-done"><span>{x.title}</span><i>{x.stage === "dropped" ? "dropped" : "archived"}{x.clearedAt ? ` · ${day(x.clearedAt)}` : ""}</i></div>)}
    {!list.length ? <p className="arc-none">Nothing archived yet.</p> : null}
  </section>;
}
