// A source's primer as the reader shows it: what the panel holds, the bar's word for it, and the wait for one asked for.
import type { PrimerMeta } from "../../../shared/types/index.ts";

export interface PrimerView {
  /** a page to show: the one written, even while a new one is asked for */
  page: boolean;
  asked: boolean;
  stale: boolean;
  /** the bar's word */
  tag: string;
}

export function primerView(p: PrimerMeta | undefined): PrimerView {
  const asked = p?.status === "requested", page = !!p?.builtAt;
  return { page, asked, stale: p?.status === "stale", tag: asked ? "asked…" : p?.status === "stale" ? "stale" : page ? "" : "none" };
}

// How long to wait before asking whether the agent wrote it: soon at first, then less often, never past two minutes.
export const WAIT_FIRST = 5_000, WAIT_MAX = 120_000;
export const nextWait = (was: number): number => Math.min(WAIT_MAX, Math.round(was * 1.6));

/** The page number a primer's link asked for, only from the frame it came from. */
export function pageAsked(e: { source: unknown; data: unknown }, frame: unknown): number | null {
  if (!frame || e.source !== frame) return null;
  const n = (e.data as { strataPrimer?: { page?: unknown } } | null)?.strataPrimer?.page;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

// Whether the panel is up, and how wide: module state, so the bar's toggle and the panel never re-render the room.
export interface PanelState { open: boolean; wide: boolean }
let state: PanelState = { open: false, wide: false };
const heard = new Set<() => void>();
export const primerPanel = {
  subscribe(cb: () => void): () => void { heard.add(cb); return () => heard.delete(cb); },
  get: (): PanelState => state,
  set(next: Partial<PanelState>): void {
    if (Object.entries(next).every(([k, v]) => state[k as keyof PanelState] === v)) return;
    state = { ...state, ...next };
    for (const cb of [...heard]) cb();
  },
};
