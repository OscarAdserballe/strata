import { test } from "node:test";
import assert from "node:assert/strict";
import { foldDays, GRID_WEEKS } from "./days.ts";

const hourOf = (d: Date) => Math.floor(d.getTime() / 3_600_000);
// [hour, minutes, cards] triples, sorted, into the register's flat form: each hour as its gap from the last
const packed = (rows: number[][]) => rows.slice().sort((a, b) => a[0] - b[0]).flatMap(([h, m, c], i, all) => [h - (i ? all[i - 1][0] : 0), m, c]);
const at = (y: number, m: number, day: number, h = 10) => new Date(y, m - 1, day, h);

test("a day counts with one review or five minutes of reading; the streak runs back from today, or yesterday while today is open", () => {
  const now = at(2026, 11, 14, 9);
  const hours = [
    [hourOf(at(2026, 11, 10)), 6, 0],
    [hourOf(at(2026, 11, 11)), 0, 1],
    [hourOf(at(2026, 11, 12)), 2, 0],
    [hourOf(at(2026, 11, 12, 18)), 3, 0],
    [hourOf(at(2026, 11, 13)), 1, 2],
    [hourOf(at(2026, 11, 1)), 1, 0],
  ];
  const d = foldDays(packed(hours), 0, now);
  assert.equal(d.total, 4, "the 1st had only a minute of reading");
  assert.equal(foldDays(packed(hours), 30, now).total, 34, "days before the hours are counted as sent");
  assert.equal(d.streak, 4, "today is not active yet, so the streak ends yesterday");
  assert.equal(foldDays(packed([...hours, [hourOf(at(2026, 11, 14, 8)), 0, 3]]), 0, now).streak, 5);
  assert.equal(foldDays(packed(hours), 0, at(2026, 11, 16)).streak, 0, "a missed day resets the streak");
});

test("the grid is 26 weeks of Monday-to-Sunday columns ending this week; days still ahead are -1", () => {
  const now = at(2026, 11, 14, 9);   // a Saturday
  const d = foldDays(packed([[hourOf(at(2026, 11, 14, 8)), 60, 0]]), 0, now);
  assert.equal(d.grid.length, GRID_WEEKS);
  assert.ok(d.grid.every((c) => c.length === 7));
  const last = d.grid[GRID_WEEKS - 1];
  assert.deepEqual(last, [0, 0, 0, 0, 0, 4, -1], "Saturday has an hour of ink, Sunday is still ahead");
});
