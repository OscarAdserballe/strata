// Grading never enrolls a card: only kept cards are owed reviews. The schedule is a pure fold over events.

export const LADDER_DAYS = [2, 5, 14, 30, 60, 120];
const DAY = 864e5;

// Proportional jitter de-clusters a chapter drilled in one sitting, so it does not return as one avalanche.
const JITTER = 0.4;

// A correct grade before this fraction of the interval is practice and does not climb.
const EARLY = 0.5;

// FNV-1a folded to [0,1); stable, not cryptographic.
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967296;
}

/** Seeded by (card, rung, at), so a schedule recomputed per request never flaps. */
export function intervalMs(card: string, rung: number, at: number): number {
  const mean = LADDER_DAYS[Math.min(Math.max(rung, 0), LADDER_DAYS.length - 1)] * DAY;
  const u = hash01(`${card}:${rung}:${at}`);
  return Math.round(mean * (1 - JITTER + 2 * JITTER * u));
}

/** Unrecognised values read as a miss, which only schedules a card sooner. */
export interface GradeRow {
  card: string; ts: number; got: number | null;
  kind?: "grade" | "answer" | null;
  /** Set by the review drill, where a second verdict is an in-sitting retry, never a correction. */
  review?: number | null;
}

export interface CardSchedule { rung: number; at: number; dueAt: number }

export const dueAtOf = (s: CardSchedule): number => s.dueAt;

// Rows within one encounter fold into one verdict (last wins), so an MCQ pick plus judgment counts once.
const JUDGMENT_MS = 30 * 60_000;
const CORRECTION_MS = 60_000;

/** A keep is a rung-0 encounter, so a card kept before its first grade climbs from the keep. */
export function replayGrades(rows: GradeRow[], kept?: ReadonlyMap<string, number>): Map<string, CardSchedule> {
  const out = new Map<string, CardSchedule>();
  const enrol = (card: string, ts: number): CardSchedule => {
    const s = { rung: 0, at: ts, dueAt: ts + intervalMs(card, 0, ts) };
    out.set(card, s);
    return s;
  };
  const land = (card: string, got: boolean, ts: number): void => {
    let s = out.get(card);
    if (!s) {
      const keptAt = kept?.get(card);
      // The first grade enrolls at rung one, unless a keep already enrolled the card.
      if (keptAt === undefined || keptAt >= ts) { enrol(card, ts); return; }
      s = enrol(card, keptAt);
    }
    if (!got) {
      s.rung = Math.max(0, s.rung - 1);
      s.at = ts; s.dueAt = ts + intervalMs(card, s.rung, ts);
      return;
    }
    // the early window is measured against the interval this card actually drew
    if (ts - s.at >= EARLY * (s.dueAt - s.at)) {
      s.rung = Math.min(s.rung + 1, LADDER_DAYS.length - 1);
      s.at = ts; s.dueAt = ts + intervalMs(card, s.rung, ts);
    }
    // else: an early success — practice, and the clock does not move
  };
  for (const e of collapseEncounters(rows)) land(e.card, e.got, e.ts);
  return out;
}

export interface Encounter { card: string; got: boolean; ts: number; rows: number }

export function collapseEncounters(rows: GradeRow[]): Encounter[] {
  const out: Encounter[] = [];
  const open = new Map<string, Encounter & { last: number; lastKind: "grade" | "answer" }>();
  const sameEncounter = (o: { last: number; lastKind: "grade" | "answer" }, r: GradeRow): boolean => {
    const gap = r.ts - o.last;
    if (o.lastKind === "answer" && (r.kind ?? "grade") === "grade") return gap < JUDGMENT_MS;
    if (r.review) return false;
    return gap < CORRECTION_MS;
  };
  for (const r of rows) {
    const kind = r.kind === "answer" ? "answer" : "grade";
    const o = open.get(r.card);
    if (o && sameEncounter(o, r)) { o.got = !!r.got; o.last = r.ts; o.lastKind = kind; o.rows++; continue; }
    if (o) out.push({ card: o.card, got: o.got, ts: o.ts, rows: o.rows });
    open.set(r.card, { card: r.card, got: !!r.got, ts: r.ts, rows: 1, last: r.ts, lastKind: kind });
  }
  for (const o of open.values()) out.push({ card: o.card, got: o.got, ts: o.ts, rows: o.rows });
  return out.sort((a, b) => a.ts - b.ts);
}

export interface KeptQueue {
  due: [card: string, s: CardSchedule][];
  /** Due cards outside the kept set. */
  unkeptDue: number;
  /** when the earliest not-yet-due KEPT card arrives — null if nothing kept waits */
  nextDueAt: number | null;
}

export function keptQueue(sched: Map<string, CardSchedule>, kept: ReadonlyMap<string, number>, t: number): KeptQueue {
  const due: [string, CardSchedule][] = [];
  let unkeptDue = 0;
  let nextDueAt: number | null = null;
  const arrive = (at: number) => { if (nextDueAt === null || at < nextDueAt) nextDueAt = at; };
  for (const [card, s] of sched) {
    const at = dueAtOf(s);
    if (!kept.has(card)) { if (at <= t) unkeptDue++; continue; }
    if (at > t) { arrive(at); continue; }
    due.push([card, s]);
  }
  // A kept card the fold never met is enrolled at its keep time, with the same seeded draw.
  for (const [card, keptAt] of kept) {
    if (sched.has(card)) continue;
    const s: CardSchedule = { rung: 0, at: keptAt, dueAt: keptAt + intervalMs(card, 0, keptAt) };
    if (s.dueAt > t) { arrive(s.dueAt); continue; }
    due.push([card, s]);
  }
  return { due, unkeptDue, nextDueAt };
}

// `usable` is false when no card points into the tree, so coverage cannot be measured.
export interface IdeaCoverage { ideasKept: number; usable: boolean }
export function ideasCovered(
  cards: readonly { id: string; node?: unknown; introduces?: unknown; authored?: unknown }[],
  kept: ReadonlySet<string>,
  claimIds: ReadonlySet<string>,
): IdeaCoverage {
  const hit = new Set<string>();
  let placed = 0;
  for (const c of cards) {
    if (c.introduces || c.authored) continue;
    if (typeof c.node !== "string" || !claimIds.has(c.node)) continue;
    placed++;
    if (kept.has(c.id)) hit.add(c.node);
  }
  return { ideasKept: hit.size, usable: placed > 0 };
}
