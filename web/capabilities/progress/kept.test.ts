import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketByDay } from "./kept.ts";

const DAY = 864e5;
const noon = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); })();

test("bucketByDay lands each keep on its calendar day, today at the right, and drops what is older than the window", () => {
  const times = [noon, noon - 3600e3, noon - DAY, noon - 13 * DAY, noon - 14 * DAY];
  const n = bucketByDay(times, 14, noon);
  assert.equal(n.length, 14);
  assert.equal(n[13], 2, "two today");
  assert.equal(n[12], 1, "one yesterday");
  assert.equal(n[0], 1, "one on the first day of the window");
  assert.equal(n.reduce((a, b) => a + b, 0), 4, "the fifteenth-day keep is outside the fortnight");
});

test("bucketByDay with nothing kept is fourteen zeros", () => {
  assert.deepEqual(bucketByDay([], 14, noon), new Array(14).fill(0));
  assert.deepEqual(bucketByDay(null, 3, noon), [0, 0, 0]);
});
