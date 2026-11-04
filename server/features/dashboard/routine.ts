// Run now: wakes the reader's research routine through its API trigger; the routine reads the board itself.
import { fetchWithTimeout } from "../../platform/llm/llm.ts";
import { now } from "../../platform/db/sql.ts";
import { DashError } from "./dashboard.ts";
import { dashboardRepo as q } from "./repo.ts";

const BASE = process.env.STRATA_ROUTINE_BASE ?? "https://api.anthropic.com/v1/claude_code/routines/";
const URL_RE = new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}trig_[A-Za-z0-9]{8,64}/fire$`);
// A routine takes 30 fires an hour, and two runs at once would research the same tasks twice.
export const COOLDOWN = 60_000;

export interface RoutineView { connected: boolean; url: string | null; ranAt: number | null; sessionUrl: string | null; error: string | null }
export interface Ran { at: number; sessionUrl: string | null; error: string | null }

export function routineView(): RoutineView {
  const r = q.routine.get();
  return { connected: !!r, url: r?.url ?? null, ranAt: r?.ran_at ?? null, sessionUrl: r?.session_url ?? null, error: r?.error ?? null };
}

/** Stores the routine's Fire URL and token, or forgets them when url is null. The token is never read back. */
export function setRoutine(b: Record<string, unknown>): RoutineView {
  if (b.url === null) { q.dropRoutine.run(); return routineView(); }
  const url = typeof b.url === "string" ? b.url.trim() : "";
  if (!URL_RE.test(url)) throw new DashError(`url is the routine's Fire URL: ${BASE}trig_…/fire.`);
  const token = typeof b.token === "string" ? b.token.trim() : "";
  if (!token || token.length > 400 || /\s/.test(token)) throw new DashError("token is the routine's API token, shown once when you generate it.");
  q.putRoutine.run(url, token, now());
  return routineView();
}

/** Fires the routine; awaited before the route's commit, which records what came back. */
export async function fireRoutine(): Promise<Ran> {
  const r = q.routine.get();
  if (!r) throw new DashError("Connect the research routine first.");
  if (r.ran_at && Date.now() - r.ran_at < COOLDOWN) throw Object.assign(new DashError("A run started under a minute ago."), { httpStatus: 409 });
  try {
    const res = await fetchWithTimeout(r.url, {
      method: "POST", timeout: 15_000,
      headers: { Authorization: `Bearer ${r.token}`, "anthropic-beta": "experimental-cc-routine-2026-04-01", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Run now, from the dashboard." }),
    });
    const body = (await res.json().catch(() => ({}))) as { claude_code_session_url?: unknown };
    if (!res.ok) return { at: now(), sessionUrl: null, error: `The routine answered ${res.status}${res.status === 401 ? ": the token is wrong or was regenerated" : res.status === 429 ? ": too many runs this hour" : ""}.` };
    const url = typeof body.claude_code_session_url === "string" && /^https:\/\//.test(body.claude_code_session_url) ? body.claude_code_session_url : null;
    return { at: now(), sessionUrl: url, error: null };
  } catch (e) {
    return { at: now(), sessionUrl: null, error: `Couldn't reach the routine: ${(e as Error).message}` };
  }
}

export function recordRun(ran: Ran): RoutineView {
  q.routineRan.run(ran.at, ran.sessionUrl, ran.error);
  return routineView();
}
