// Rungs are means with a ±40% draw, so tests assert ranges with gaps stable across the whole draw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LADDER_DAYS, intervalMs, replayGrades, collapseEncounters, dueAtOf, keptQueue, ideasCovered, type GradeRow } from "./ladder.ts";

const DAY = 864e5;
const at = (d: number): number => 1_700_000_000_000 + d * DAY;   // day d of a little history

// the draw's bounds for a rung — what "due around the mean" concretely promises
const lo = (rung: number): number => LADDER_DAYS[rung] * DAY * 0.6;
const hi = (rung: number): number => LADDER_DAYS[rung] * DAY * 1.4;

test("the ladder starts at a mean of two days, drawn per card within ±40%", () => {
  assert.equal(LADDER_DAYS[0], 2);
  for (const card of ["a", "b", "c/mcq/some-long-id"]) {
    const iv = intervalMs(card, 0, at(0));
    assert.ok(iv >= lo(0) && iv <= hi(0), `${card}: ${iv / DAY}d is inside [1.2, 2.8]`);
  }
});

test("the draw is SEEDED, not rolled — same card, same grade, same interval forever", () => {
  assert.equal(intervalMs("c", 0, at(0)), intervalMs("c", 0, at(0)));
  const rows = [{ card: "c", ts: at(0), got: 1 }];
  assert.deepEqual(replayGrades(rows).get("c"), replayGrades(rows).get("c"));
});

test("…and different cards draw different intervals — the de-clustering itself", () => {
  const draws = new Set<number>();
  for (let i = 0; i < 40; i++) draws.add(Math.round(intervalMs(`deck/flashcard/card-${i}`, 0, at(0)) / 36e5));
  assert.ok(draws.size >= 10, `40 cards spread over ${draws.size} distinct hours of due-time`);
});

test("the first grade is the enrolment: rung one, due around two days — hit or miss", () => {
  for (const got of [1, 0]) {
    const s = replayGrades([{ card: "c", ts: at(0), got }]).get("c");
    assert.ok(s);
    assert.equal(s.rung, 0);
    assert.ok(dueAtOf(s) - at(0) >= lo(0) && dueAtOf(s) - at(0) <= hi(0));
  }
});

test("a correct review at the due date climbs one rung per visit", () => {
  const rows = [{ card: "c", ts: at(0), got: 1 }];
  for (let i = 0; i < 3; i++) {
    const s = replayGrades(rows).get("c");
    assert.ok(s);
    rows.push({ card: "c", ts: dueAtOf(s), got: 1 });   // right on schedule, every time
  }
  const s = replayGrades(rows).get("c");
  assert.ok(s);
  assert.equal(s.rung, 3);
  const iv = dueAtOf(s) - s.at;
  assert.ok(iv >= lo(3) && iv <= hi(3), "the new interval is rung three's draw");
});

test("an early success is practice, not progress — the rung and the clock hold still", () => {
  const rows = [{ card: "c", ts: at(0), got: 1 }];
  for (let i = 1; i <= 4; i++) rows.push({ card: "c", ts: at(0) + i * 3e5, got: 1 });
  const s = replayGrades(rows).get("c");
  assert.ok(s);
  assert.equal(s.rung, 0);
  assert.equal(s.at, at(0));            // the clock did not move either
});

test("…and half the drawn interval is far enough — a slightly-early real review counts", () => {
  const first = replayGrades([{ card: "c", ts: at(0), got: 1 }]).get("c");
  assert.ok(first);
  const halfway = first.at + 0.5 * (dueAtOf(first) - first.at);
  const s = replayGrades([
    { card: "c", ts: at(0), got: 1 },
    { card: "c", ts: halfway, got: 1 },
  ]).get("c");
  assert.ok(s);
  assert.equal(s.rung, 1);
});

test("a miss demotes one rung and restarts the clock — never below the floor", () => {
  const climb = [
    { card: "c", ts: at(0), got: 1 },
    { card: "c", ts: at(3), got: 1 },     // 3d ≥ 1.4×2d mean → rung 1
    { card: "c", ts: at(10), got: 1 },    // 7d ≥ 1.4×5d mean → rung 2
    { card: "c", ts: at(12), got: 0 },    // missed → rung 1, clock restarts at the miss
  ];
  const s = replayGrades(climb).get("c");
  assert.ok(s);
  assert.equal(s.rung, 1);
  const iv = dueAtOf(s) - at(12);
  assert.ok(iv >= lo(1) && iv <= hi(1), "due again around rung one's mean, from the miss");
  const floor = replayGrades([
    { card: "d", ts: at(0), got: 0 },
    { card: "d", ts: at(3), got: 0 },
  ]).get("d");
  assert.ok(floor);
  assert.equal(floor.rung, 0);
});

test("the in-session retry does not undo the demotion — miss, then correct minutes later", () => {
  const rows = [
    { card: "c", ts: at(0), got: 1 },
    { card: "c", ts: at(3), got: 0 },               // missed at review
    { card: "c", ts: at(3) + 6e5, got: 1 },         // recalled ten minutes later
  ];
  const s = replayGrades(rows).get("c");
  assert.ok(s);
  assert.equal(s.rung, 0);
  assert.equal(s.at, at(3), "the retry moved nothing");
});

test("the top rung is a ceiling, not an index error", () => {
  const rows = [{ card: "c", ts: at(0), got: 1 }];
  for (let i = 0; i < 12; i++) {
    const s = replayGrades(rows).get("c");
    assert.ok(s);
    rows.push({ card: "c", ts: dueAtOf(s), got: 1 });
  }
  const s = replayGrades(rows).get("c");
  assert.ok(s);
  assert.equal(s.rung, LADDER_DAYS.length - 1);
});

test("one encounter, one verdict: an MCQ's pick and its judgment do not double-count", () => {
  const rows = [
    { card: "c", ts: at(0), got: 1 },
    { card: "c", ts: at(3), got: 1 },              // rung 1
    { card: "c", ts: at(10), got: 1 },             // rung 2
    { card: "c", ts: at(12), got: 0 },             // the pick was wrong…
    { card: "c", ts: at(12) + 3e3, got: 0 },       // …and judged missed, 3s later
  ];
  const s = replayGrades(rows).get("c");
  assert.ok(s);
  assert.equal(s.rung, 1, "one rung down, not two");
});

test("the human verdict overrules the machine's — wrong pick, judged got-it", () => {
  const rows = [
    { card: "c", ts: at(0), got: 1 },
    { card: "c", ts: at(3), got: 0 },              // picked the wrong letter…
    { card: "c", ts: at(3) + 3e3, got: 1 },        // …but judged got-it: the grade wins
  ];
  const s = replayGrades(rows).get("c");
  assert.ok(s);
  assert.equal(s.rung, 1, "the encounter counts as a success");
});

test("…and a slipped grade key can be corrected in the same breath", () => {
  const rows = [
    { card: "c", ts: at(0), got: 1 },
    { card: "c", ts: at(3), got: 0 },              // fat-fingered 1
    { card: "c", ts: at(3) + 2e3, got: 1 },        // meant 2 — last verdict wins
  ];
  const s = replayGrades(rows).get("c");
  assert.ok(s);
  assert.equal(s.rung, 1);
});

test("a grade whose outcome the log cannot read is a miss — the safe direction", () => {
  const s = replayGrades([
    { card: "c", ts: at(0), got: 1 },
    { card: "c", ts: at(3), got: 1 },
    { card: "c", ts: at(10), got: null },
  ]).get("c");
  assert.ok(s);
  assert.equal(s.rung, 0);
});

test("the gate: an unkept due card is a count, a kept one is the queue", () => {
  const sched = replayGrades([
    { card: "kept", ts: at(0), got: 1 },
    { card: "unkept", ts: at(0), got: 1 },
  ]);
  const { due, unkeptDue, nextDueAt } = keptQueue(sched, new Map([["kept", at(0)]]), at(10));
  assert.deepEqual(due.map(([id]) => id), ["kept"], "the queue owes exactly the kept set");
  assert.equal(unkeptDue, 1, "…and the declined card is counted, never hidden");
  assert.equal(nextDueAt, null, "nothing kept is still waiting");
});

test("the gate: an empty kept set owes nothing, however deep the backlog", () => {
  const rows: { card: string; ts: number; got: number }[] = [];
  for (let i = 0; i < 25; i++) rows.push({ card: `c${i}`, ts: at(0), got: 1 });
  const { due, unkeptDue } = keptQueue(replayGrades(rows), new Map(), at(10));
  assert.equal(due.length, 0);
  assert.equal(unkeptDue, 25, "the accounting line carries the whole declined backlog");
});

test("the gate: nextDueAt is a promise about the KEPT set alone", () => {
  const sched = replayGrades([
    { card: "kept", ts: at(0), got: 1 },
    { card: "unkept", ts: at(0), got: 1 },
  ]);
  const t = at(0) + 6e4;
  const { due, unkeptDue, nextDueAt } = keptQueue(sched, new Map([["kept", at(0)]]), t);
  assert.equal(due.length, 0);
  assert.equal(unkeptDue, 0, "not yet due is not yet declined-and-owed");
  const s = sched.get("kept");
  assert.ok(s);
  assert.equal(nextDueAt, dueAtOf(s), "the strip's quiet line speaks for the kept card");
});

test("the gate: keeping a card later inherits its whole grade history", () => {
  const sched = replayGrades([
    { card: "c", ts: at(0), got: 1 },
    { card: "c", ts: at(3), got: 1 },
    { card: "c", ts: at(10), got: 1 },
  ]);
  const { due } = keptQueue(sched, new Map([["c", at(0)]]), at(60));
  assert.equal(due.length, 1);
  assert.equal(due[0][1].rung, 2, "promotion is enrolment, not a reset");
});

test("the gate: a kept card the fold never met is enrolled at its keep time", () => {
  const sched = replayGrades([]);                          // never drilled, nothing anywhere
  const kept = new Map([["fresh", at(0)]]);
  const later = keptQueue(sched, kept, at(3));
  assert.deepEqual(later.due.map(([id]) => id), ["fresh"], "kept-never-drilled is owed after its interval");
  assert.equal(later.due[0][1].rung, 0, "…as a first encounter, not a climb");
  const early = keptQueue(sched, kept, at(0) + 6e4);
  assert.equal(early.due.length, 0);
  assert.ok(early.nextDueAt !== null && early.nextDueAt > at(0) + 1.1 * 864e5
    && early.nextDueAt < at(0) + 2.9 * 864e5, "nextDueAt honours the keep-time enrolment");
  assert.equal(keptQueue(sched, kept, at(0) + 6e4).nextDueAt, early.nextDueAt, "derived, deterministic");
});

test("the gate: the first real grade takes over from the keep-time enrolment", () => {
  const sched = replayGrades([{ card: "c", ts: at(5), got: 0 }]);
  const { due } = keptQueue(sched, new Map([["c", at(0)]]), at(30));
  assert.equal(due.length, 1);
  assert.equal(due[0][1].at, at(5), "the schedule is the grade's, not the keep's");
});

test("the gate: a card kept BEFORE its first grade climbs from the keep, not from zero", () => {
  const kept = new Map([["c", at(0)]]);
  const sched = replayGrades([{ card: "c", ts: at(3), got: 1 }], kept);
  const s = sched.get("c")!;
  assert.equal(s.rung, 1, "first review of a kept card is a climb");
  assert.equal(s.at, at(3));
  assert.ok(s.dueAt - s.at >= lo(1) && s.dueAt - s.at <= hi(1), "…scheduled at rung one's draw");
  assert.equal(keptQueue(sched, kept, at(4)).due.length, 0);
  const missed = replayGrades([{ card: "c", ts: at(3), got: 0 }], kept).get("c")!;
  assert.equal(missed.rung, 0); assert.equal(missed.at, at(3));
  assert.equal(replayGrades([{ card: "c", ts: at(3), got: 1 }]).get("c")!.rung, 0);
});

test("the gate: a keep AFTER the first grade is silent — the history is the card's", () => {
  const rows = [{ card: "c", ts: at(0), got: 1 }, { card: "c", ts: at(3), got: 1 }];
  const kept = new Map([["c", at(10)]]);
  assert.deepEqual(replayGrades(rows, kept).get("c"), replayGrades(rows).get("c"));
  const same = replayGrades([{ card: "c", ts: at(3), got: 1 }], new Map([["c", at(3)]])).get("c")!;
  assert.equal(same.rung, 0);
});

test("the in-session retry that comes round in SECONDS is still a miss — not a correction", () => {
  const rows: GradeRow[] = [
    { card: "c", ts: at(0), got: 1 }, { card: "c", ts: at(3), got: 1 },                 // rung 1
    { card: "c", ts: at(10), got: 0, review: 1 }, { card: "c", ts: at(10) + 20e3, got: 1, review: 1 },
  ];
  const s = replayGrades(rows).get("c")!;
  assert.equal(s.rung, 0, "the miss demoted");
  assert.equal(s.at, at(10), "…and the retry did not move the clock");
  const corrected = replayGrades(rows.map((r) => ({ ...r, review: 0 }))).get("c")!;
  assert.equal(corrected.rung, 2, "a correction seconds later is one recall");
  const mcq: GradeRow[] = [
    { card: "m", ts: at(0), got: 1 },
    { card: "m", ts: at(3), got: 0, kind: "answer", review: 1 }, { card: "m", ts: at(3) + 40e3, got: 1, kind: "grade", review: 1 },
  ];
  assert.equal(replayGrades(mcq).get("m")!.rung, 1, "judged got-it in the review: a climb");
});

test("an MCQ's judgment can come minutes after the pick and still be the same verdict", () => {
  const rows: GradeRow[] = [
    { card: "m", ts: at(0), got: 1 },
    { card: "m", ts: at(3), got: 0, kind: "answer" }, { card: "m", ts: at(3) + 5 * 6e4, got: 1, kind: "grade" },
  ];
  const s = replayGrades(rows).get("m")!;
  assert.equal(s.rung, 1, "judged got-it: a climb");
  assert.equal(s.at, at(3), "stamped with the pick");
  const twice: GradeRow[] = [
    { card: "m", ts: at(0), got: 1 },
    { card: "m", ts: at(3), got: 0, kind: "answer" }, { card: "m", ts: at(3) + 5 * 6e4, got: 1, kind: "answer" },
  ];
  assert.equal(collapseEncounters(twice).length, 3);
});

test("coverage: a claim is covered by any one of its cards, and only once", () => {
  const cards = [
    { id: "a", node: "n1" }, { id: "b", node: "n1" },
    { id: "c", node: "n2" }, { id: "d", node: "n3.1" },
  ];
  const claims = new Set(["n1", "n2", "n3.1"]);
  const both = ideasCovered(cards, new Set(["a", "b", "c"]), claims);
  assert.equal(both.ideasKept, 2, "two cards under n1 cover one idea, not two");
  assert.ok(both.usable);
  assert.equal(ideasCovered(cards, new Set(), claims).ideasKept, 0, "curated to zero covers nothing — and says so with numbers, not nulls");
});

test("coverage: terms, authored questions and loose cards are cards, never ideas", () => {
  const cards = [
    { id: "t", introduces: "a word", node: "n1" },       // vocabulary is not a claim
    { id: "y", authored: true, node: "n1" },             // your question leads the deck, covers nothing
    { id: "l", node: "n9" },                             // points at a claim the tree does not hold
    { id: "c", node: "n1" },
  ];
  const cov = ideasCovered(cards, new Set(["t", "y", "l", "c"]), new Set(["n1"]));
  assert.equal(cov.ideasKept, 1, "only the claim's own card covers it");
});

test("coverage: a tree no card points into is unusable, not zero", () => {
  const cards = [{ id: "a" }, { id: "b", node: "nowhere" }];
  const cov = ideasCovered(cards, new Set(["a", "b"]), new Set(["n1", "n2"]));
  assert.equal(cov.usable, false, "the older committed decks are exactly this shape — cards-only, said honestly");
  assert.equal(ideasCovered(cards, new Set(["a"]), new Set()).usable, false);
});
