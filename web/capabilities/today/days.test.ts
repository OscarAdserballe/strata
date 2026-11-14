import { test } from "node:test";
import assert from "node:assert/strict";
import { foldDays, GRID_WEEKS } from "./days.ts";

const hourOf = (d: Date) => Math.floor(d.getTime() / 3_600_000);
const at = (y: number, m: number, day: number, h = 10) => new Date(y, m - 1, day, h);

test("a day counts with one review or five minutes of reading; the streak runs back from today, or yesterday while today is open", () => {
  const now = at(2026, 11, 14, 9);
  const hours = [
    { hour: hourOf(at(2026, 11, 10)), ms: 6 * 60_000, cards: 0 },
    { hour: hourOf(at(2026, 11, 11)), ms: 0, cards: 1 },
    { hour: hourOf(at(2026, 11, 12)), ms: 2 * 60_000, cards: 0 },
    { hour: hourOf(at(2026, 11, 12, 18)), ms: 3 * 60_000, cards: 0 },
    { hour: hourOf(at(2026, 11, 13)), ms: 60_000, cards: 2 },
    { hour: hourOf(at(2026, 11, 1)), ms: 60_000, cards: 0 },
  ];
  const d = foldDays(hours, now);
  assert.equal(d.total, 4, "the 1st had only a minute of reading");
  assert.equal(d.streak, 4, "today is not active yet, so the streak ends yesterday");
  assert.equal(foldDays([...hours, { hour: hourOf(at(2026, 11, 14, 8)), ms: 0, cards: 3 }], now).streak, 5);
  assert.equal(foldDays(hours, at(2026, 11, 16)).streak, 0, "a missed day resets the streak");
});

test("the grid is 26 weeks of Monday-to-Sunday columns ending this week; days still ahead are -1", () => {
  const now = at(2026, 11, 14, 9);   // a Saturday
  const d = foldDays([{ hour: hourOf(at(2026, 11, 14, 8)), ms: 60 * 60_000, cards: 0 }], now);
  assert.equal(d.grid.length, GRID_WEEKS);
  assert.ok(d.grid.every((c) => c.length === 7));
  const last = d.grid[GRID_WEEKS - 1];
  assert.deepEqual(last, [0, 0, 0, 0, 0, 4, -1], "Saturday has an hour of ink, Sunday is still ahead");
});
