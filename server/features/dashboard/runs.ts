// Runs: who held which Dispatch thread and how long a press took to come back as a page, derived from presses and versions.
import { now } from "../../platform/db/sql.ts";
import { stageOf } from "./dashboard.ts";
import { pressLabel } from "./dispatch.ts";
import { dashboardRepo as q, type PressRow } from "./repo.ts";

export const RUNS_DAYS = 7;
const MAX_PRESSES = 500;

/** One press and what came of it: the next page posted on its thread before it was pressed again. */
export interface RunPress {
  id: string; task: string; title: string; label: string; at: number; version: number | null;
  posted: { n: number; at: number; lands: string } | null;
  /** with no page: "holding" while the thread is still with Claude, else where the thread went instead */
  open: string | null;
}
/** A run is the routine session a press woke or joined; a press that woke none is a run of its own. */
export interface RunView { key: string; sessionUrl: string | null; at: number; presses: RunPress[] }
export interface RunsView { now: number; since: number; runs: RunView[]; ranAt: number | null; ranSession: string | null }

export function runs(at = now()): RunsView {
  const since = at - RUNS_DAYS * 86_400_000;
  const presses = q.pressesSince.all(since, MAX_PRESSES);
  const tasks = new Map(q.taskStages.all().map((t) => [t.id, t]));
  const versions = new Map<string, { n: number; at: number; landed: string }[]>();
  for (const v of q.versionTimes.all(since)) versions.set(v.task_id, [...(versions.get(v.task_id) ?? []), v]);
  const byTask = new Map<string, PressRow[]>();
  for (const p of presses) byTask.set(p.task_id, [...(byTask.get(p.task_id) ?? []), p]);

  const lanes = new Map<string, RunView>();
  for (const p of presses) {
    const mine = byTask.get(p.task_id)!, next = mine[mine.indexOf(p) + 1];
    const v = (versions.get(p.task_id) ?? []).find((x) => x.at >= p.at && (!next || x.at < next.at)) ?? null;
    const t = tasks.get(p.task_id);
    const stage = t ? stageOf(t) : "gone";
    const press: RunPress = {
      id: p.id, task: p.task_id, title: t?.title ?? "A thread since deleted", at: p.at, version: p.version,
      label: p.version ? pressLabel(p.kind, p.stage) : "Sent to Dispatch",
      posted: v ? { n: v.n, at: v.at, lands: v.landed } : null,
      open: v ? null : next ? "pressed again" : stage === "implementing" ? "holding" : stage,
    };
    const key = p.session_url ?? `press:${p.id}`;
    const lane = lanes.get(key) ?? { key, sessionUrl: p.session_url, at: p.at, presses: [] };
    lane.presses.push(press);
    lanes.set(key, lane);
  }
  const r = q.routine.get();
  return { now: at, since, runs: [...lanes.values()].sort((x, y) => x.at - y.at), ranAt: r?.ran_at ?? null, ranSession: r?.session_url ?? null };
}
