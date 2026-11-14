// The day counter: which of the reader's own days had reading or reviewing in them, folded from hourly totals.
import type { ActivityHours } from "../../../shared/types/index.ts";

/** A day counts once it has a review in it or five minutes of reading. */
export const ACTIVE_READ_MS = 5 * 60_000;
/** A graded card stands for this much time on the grid's ink. */
const CARD_MS = 20_000;
export const GRID_WEEKS = 26;

export interface Day { key: string; ms: number; cards: number }
export interface Days {
  /** days with Strata, ever */
  total: number;
  /** active days in a row, ending today (or yesterday, while today is still open) */
  streak: number;
  today: Day;
  /** GRID_WEEKS columns of seven days, oldest first, each 0 (nothing) to 4 (most ink) */
  grid: number[][];
}

export const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const active = (d: Day | undefined): boolean => !!d && (d.cards > 0 || d.ms >= ACTIVE_READ_MS);

export function foldDays(hours: ActivityHours, daysBefore = 0, now: Date = new Date()): Days {
  const byDay = new Map<string, Day>();
  for (let i = 0, hour = 0; i + 2 < hours.length; i += 3) {
    hour += hours[i];
    const key = dayKey(new Date(hour * 3_600_000));
    const d = byDay.get(key) ?? { key, ms: 0, cards: 0 };
    d.ms += hours[i + 1] * 60_000; d.cards += hours[i + 2];
    byDay.set(key, d);
  }
  let total = daysBefore;
  for (const d of byDay.values()) if (active(d)) total++;
  const back = (n: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  let streak = 0;
  for (let n = active(byDay.get(dayKey(now))) ? 0 : 1; active(byDay.get(dayKey(back(n)))); n++) streak++;
  // Columns end with this week; a column runs Monday to Sunday.
  const sinceMonday = (now.getDay() + 6) % 7;
  const start = GRID_WEEKS * 7 - 1 - (6 - sinceMonday);
  const grid: number[][] = [];
  for (let w = 0; w < GRID_WEEKS; w++) {
    const col: number[] = [];
    for (let i = 0; i < 7; i++) {
      const n = start - (w * 7 + i);
      const d = n < 0 ? undefined : byDay.get(dayKey(back(n)));
      const min = d ? (d.ms + d.cards * CARD_MS) / 60_000 : 0;
      col.push(n < 0 ? -1 : !d || min < 1 ? 0 : min < 10 ? 1 : min < 25 ? 2 : min < 50 ? 3 : 4);
    }
    grid.push(col);
  }
  return { total, streak, today: byDay.get(dayKey(now)) ?? { key: dayKey(now), ms: 0, cards: 0 }, grid };
}
