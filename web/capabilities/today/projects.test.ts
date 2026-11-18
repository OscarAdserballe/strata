import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProjectEntry, RegisterEntry } from "../../../shared/types/index.ts";
import { projectView, readingList, starCount } from "./projects.ts";

const NOW = new Date(2026, 10, 14, 9);   // Saturday 14 Nov
const DAY = 864e5;
const entry = (id: string, board: string, readPct = 0, status: RegisterEntry["status"] = "fresh", lastAt = 0, createdAt = NOW.getTime() - 30 * DAY): RegisterEntry => ({
  resourceId: id, pairId: null, boardId: board, boardTitle: board, unfiled: false, filename: id, kind: "pdf", originUrl: null,
  createdAt, status, readPct, kept: 0, cards: 0, waiting: true, lastAt,
});
const project = (over: Partial<ProjectEntry> = {}): ProjectEntry => ({
  id: "b", title: "Econometrics", purpose: "", endsAt: "", archivedAt: null, starredAt: null, touchedAt: 0,
  groups: [{ id: "u2", name: "IV", ord: 1, byDate: "2026-11-20" }, { id: "u1", name: "OLS", ord: 0, byDate: "" }],
  places: { a: { group: "u1", ord: 0, pinned: false }, b: { group: "u2", ord: 1, pinned: true }, c: { group: "u2", ord: 0, pinned: false } },
  ...over,
});

test("units in their order with their own progress; finished is done or 90% read; the next unit is the first not finished", () => {
  const v = projectView(project(), [entry("a", "b", 95), entry("b", "b", 40, "reading", NOW.getTime() - DAY), entry("c", "b", 0, "done"), entry("d", "b")], NOW);
  assert.deepEqual(v.units.map((u) => [u.n, u.name, u.sources.map((s) => s.id), u.done]), [[1, "OLS", ["a"], 1], [2, "IV", ["c", "b"], 1]]);
  assert.deepEqual(v.loose.map((s) => s.id), ["d"], "a source in no unit is a loose end");
  assert.deepEqual([v.done, v.total], [2, 3], "progress counts the sources in units");
  assert.equal(v.next, "Unit 2 · IV");
  assert.equal(v.due, "Fri", "a unit due within the week says its weekday");
});

test("with no units, progress counts every source and next is the first loose end left", () => {
  const v = projectView(project({ groups: [], places: {} }), [entry("a", "b", 100), entry("b", "b")], NOW);
  assert.deepEqual([v.done, v.total, v.next, v.due], [1, 2, "b", ""]);
});

test("reading is your stars plus what you opened this fortnight and haven't finished, half-read first; an old star is stale", () => {
  const recent = NOW.getTime() - 2 * DAY;
  const v = projectView(project({ places: { s: { group: null, ord: null, pinned: true }, old: { group: null, ord: null, pinned: true } } }),
    [entry("s", "b"), entry("old", "b", 10, "reading", NOW.getTime() - 20 * DAY), entry("r", "b", 30, "reading", recent),
     entry("f", "b", 95, "reading", recent), entry("gone", "b", 30, "reading", NOW.getTime() - 20 * DAY)], NOW);
  const rows = readingList([v], () => 0, NOW.getTime());
  assert.deepEqual(rows.map((r) => [r.source.id, r.stale]), [["r", false], ["old", true], ["s", true]]);
  assert.equal(readingList([v], (id) => (id === "s" ? recent : 0), NOW.getTime()).find((r) => r.source.id === "s")!.stale, false, "keeping a star freshens it");
  assert.equal(starCount([v]), 2);
  assert.equal(readingList([{ ...v, project: { ...v.project, archivedAt: 1 } }], () => 0, NOW.getTime()).length, 0, "an archived project reads nothing onto Today");
});
