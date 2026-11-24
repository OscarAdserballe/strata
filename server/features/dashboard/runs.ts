// Runs: what each routine run held and how long a press waited for its page, read from the presses and versions Dispatch already keeps.
import { now } from "../../platform/db/sql.ts";
import { DashError } from "./dashboard.ts";
import { dashboardRepo as q } from "./repo.ts";
import { pressLabel } from "./dispatch.ts";

/** One press and what came of it: the page it led to, or nothing yet (to is null while Claude still has it). */
export interface RunBlock { task: string; title: string; press: string; from: number; to: number | null; posted: number | null; landed: string | null }
/** A run is the session a press woke or joined; a press with no session is a run of its own. */
export interface Run { session: string | null; start: number; blocks: RunBlock[] }
export interface Runs { since: number; until: number; runs: Run[]; stats: { runs: number; threads: number; posted: number; open: number; medianMs: number | null } }

const MONTH = 31 * 86_400_000;

export function runs(sinceRaw: unknown, at = now()): Runs {
  const since = Number(sinceRaw);
  if (!Number.isFinite(since) || since > at) throw new DashError("since is a time in ms, in the past.");
  const from = Math.max(since, at - MONTH);
  const presses = q.pressesSince.all(from);
  const posts = q.postsSince.all(from);
  const lanes = new Map<string, Run>();
  const blocks: RunBlock[] = [];
  presses.forEach((p, i) => {
    const next = presses.slice(i + 1).find((x) => x.task_id === p.task_id);
    const v = posts.find((x) => x.task_id === p.task_id && x.at >= p.at && (!next || x.at < next.at));
    const b: RunBlock = { task: p.task_id, title: p.title, press: pressLabel(p.kind, p.stage), from: p.at, to: v?.at ?? next?.at ?? null, posted: v?.n ?? null, landed: v?.landed ?? null };
    blocks.push(b);
    const key = p.session_url ?? `press:${p.id}`;
    const lane = lanes.get(key) ?? { session: p.session_url, start: p.at, blocks: [] };
    lane.blocks.push(b);
    lanes.set(key, lane);
  });
  const waits = blocks.filter((b) => b.posted !== null).map((b) => b.to! - b.from).sort((x, y) => x - y);
  const mid = waits.length ? (waits.length % 2 ? waits[(waits.length - 1) / 2] : (waits[waits.length / 2 - 1] + waits[waits.length / 2]) / 2) : null;
  return {
    since: from, until: at, runs: [...lanes.values()],
    stats: { runs: lanes.size, threads: new Set(blocks.map((b) => b.task)).size, posted: waits.length, open: blocks.filter((b) => b.to === null).length, medianMs: mid },
  };
}
