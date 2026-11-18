// Where each project stands, read from the register: its units with their progress, its loose ends, what is next,
// and the reading list Today shows. Pure, so Today, the projects list and the project page agree.
import type { ProjectEntry, RegisterEntry } from "../../../shared/types/index.ts";

/** A source counts as finished once marked done or read this far. */
export const FINISHED_PCT = 90;
export const STAR_CAP = 5;
export const RECENT_MS = 14 * 864e5;
const NEW_MS = 7 * 864e5;
const DAY_MS = 864e5;

export interface ProjectSource {
  id: string; board: string; name: string; pct: number; finished: boolean; lastAt: number; createdAt: number;
  pinned: boolean; group: string | null; ord: number | null; kind: string;
}
export interface ProjectUnit { id: string; name: string; n: number; byDate: string; sources: ProjectSource[]; done: number }
export interface ProjectView {
  project: ProjectEntry;
  units: ProjectUnit[];
  loose: ProjectSource[];
  sources: ProjectSource[];
  /** finished and counted: the sources in units, or every source when there are no units */
  done: number; total: number;
  current: ProjectUnit | null;
  next: string;
  due: string;
  fresh: number;
}

export const finished = (e: Pick<RegisterEntry, "status" | "readPct">): boolean => e.status === "done" || e.readPct >= FINISHED_PCT;

/** YYYY-MM-DD as the reader's own midnight */
export const dayAt = (day: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
export const daysUntil = (day: string, now = new Date()): number | null => {
  const d = dayAt(day);
  return d ? Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / DAY_MS) : null;
};
export const shortDay = (day: string, weekday = false): string => {
  const d = dayAt(day);
  return d ? d.toLocaleDateString(undefined, weekday ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" }) : "";
};
/** "Fri" within the week, "2 Dec" after it */
export const dueWord = (day: string, now = new Date()): string => {
  const n = daysUntil(day, now), d = dayAt(day);
  if (n === null || !d) return "";
  if (n < 0) return "overdue";
  if (n === 0) return "today";
  return n < 7 ? d.toLocaleDateString(undefined, { weekday: "short" }) : shortDay(day);
};

export function sourcesOf(p: ProjectEntry, entries: readonly RegisterEntry[]): ProjectSource[] {
  const groups = new Set(p.groups.map((g) => g.id));
  return entries.filter((e) => e.boardId === p.id).map((e) => {
    const pl = p.places[e.resourceId] ?? (e.pairId ? p.places[e.pairId] : undefined);
    return {
      id: e.resourceId, board: p.id, name: e.filename, pct: e.readPct, finished: finished(e), lastAt: e.lastAt, createdAt: e.createdAt,
      pinned: !!pl?.pinned, group: pl?.group && groups.has(pl.group) ? pl.group : null, ord: pl?.ord ?? null, kind: e.kind,
    };
  });
}

const byPlace = (a: ProjectSource, b: ProjectSource) => (a.ord ?? 1e9) - (b.ord ?? 1e9) || a.createdAt - b.createdAt;

export function projectView(p: ProjectEntry, entries: readonly RegisterEntry[], now = new Date()): ProjectView {
  const sources = sourcesOf(p, entries);
  const units = p.groups.slice().sort((a, b) => a.ord - b.ord).map((g, i) => {
    const s = sources.filter((x) => x.group === g.id).sort(byPlace);
    return { id: g.id, name: g.name, n: i + 1, byDate: g.byDate, sources: s, done: s.filter((x) => x.finished).length };
  });
  const loose = sources.filter((x) => !x.group).sort(byPlace);
  const counted = units.length ? units.flatMap((u) => u.sources) : sources;
  const current = units.find((u) => u.done < u.sources.length) ?? null;
  const left = loose.filter((x) => !x.finished);
  const next = current ? `Unit ${current.n} · ${current.name}` : left.length ? left[0].name : "";
  const soon = current?.byDate ? daysUntil(current.byDate, now) : null;
  return {
    project: p, units, loose, sources,
    done: counted.filter((x) => x.finished).length, total: counted.length,
    current, next,
    due: current && soon !== null && soon <= 14 ? dueWord(current.byDate, now) : "",
    fresh: sources.filter((x) => !x.lastAt && now.getTime() - x.createdAt < NEW_MS).length,
  };
}

/** "ends 14 Dec" or "no end" */
export const endLabel = (p: ProjectEntry): string => (p.endsAt ? `ends ${shortDay(p.endsAt)}` : "no end");

export interface ReadingRow { source: ProjectSource; project: ProjectView; unit: ProjectUnit | null; stale: boolean }

/** Your stars, plus what you opened in the last fortnight and haven't finished; half-read first. */
export function readingList(views: readonly ProjectView[], keptAt: (id: string) => number, now = Date.now()): ReadingRow[] {
  const rows: ReadingRow[] = [];
  for (const v of views) {
    if (v.project.archivedAt) continue;
    for (const s of v.sources) {
      if (s.finished) continue;
      const recent = s.lastAt > 0 && now - s.lastAt < RECENT_MS;
      if (!s.pinned && !recent) continue;
      const touched = Math.max(s.lastAt, s.createdAt, keptAt(s.id));
      rows.push({ source: s, project: v, unit: v.units.find((u) => u.id === s.group) ?? null, stale: s.pinned && now - touched >= RECENT_MS });
    }
  }
  const started = (r: ReadingRow) => (r.source.pct > 0 ? 0 : 1);
  return rows.sort((a, b) => Number(a.stale) - Number(b.stale) || started(a) - started(b) || b.source.lastAt - a.source.lastAt);
}

export const starCount = (views: readonly ProjectView[]): number =>
  views.reduce((n, v) => n + (v.project.archivedAt ? 0 : v.sources.filter((s) => s.pinned && !s.finished).length), 0);

/** The same view from a board's own state, so the project page agrees with Today without the register. */
export function boardProject(
  id: string, title: string,
  plan: { purpose: string; endsAt?: string; archivedAt?: number | null; starredAt?: number | null; groups: ProjectEntry["groups"]; places: Record<string, { group: string | null; ord: number | null; pinned: boolean }> },
  resources: readonly { id: string; filename: string; kind: string; readPct?: number; lastReadAt?: number | null; doneAt?: number | null; createdAt: number }[],
  now = new Date(),
): ProjectView {
  const p: ProjectEntry = { id, title, purpose: plan.purpose, endsAt: plan.endsAt ?? "", archivedAt: plan.archivedAt ?? null, starredAt: plan.starredAt ?? null, touchedAt: null,
    groups: plan.groups.map((g) => ({ ...g, byDate: g.byDate ?? "" })), places: plan.places };
  const entries: RegisterEntry[] = resources.map((r) => ({
    resourceId: r.id, pairId: null, boardId: id, boardTitle: title, unfiled: false, filename: r.filename, kind: r.kind, originUrl: null,
    createdAt: r.createdAt, status: r.doneAt ? "done" : "reading", readPct: Math.round(r.readPct ?? 0), kept: 0, cards: 0, waiting: !r.doneAt, lastAt: r.lastReadAt ?? 0,
  }));
  return projectView(p, entries, now);
}

/** Active projects: starred first, then by end date, then most recently touched. */
export function activeProjects(views: readonly ProjectView[]): ProjectView[] {
  const star = (v: ProjectView) => (v.project.starredAt ? 0 : 1);
  return views.filter((v) => !v.project.archivedAt)
    .sort((a, b) => star(a) - star(b) || (a.project.endsAt || "9999").localeCompare(b.project.endsAt || "9999") || (b.project.touchedAt ?? 0) - (a.project.touchedAt ?? 0));
}
