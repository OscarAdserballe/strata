import { test } from "node:test";
import assert from "node:assert/strict";
import { afterGrade, cramSources, pileOf, tickedDecks, DEFAULT_PREFS } from "./cram.ts";
import type { BoardPlan, Card, DeckSummary, Pair, ResourceMeta, Section } from "../../../shared/types/index.ts";

const res = (id: string, filename: string) => ({ id, filename } as ResourceMeta);
const sec = (id: string, resourceId: string, label: string, kind = "work") => ({ id, resourceId, label, kind } as Section);
const pair = (id: string, resourceId: string | null, deck: string | null, label: string, sectionId: string | null = null): Pair =>
  ({ id, resourceId, deck, label, sectionId, ord: 0 });
const deck = (slug: string, total: number, kept: number) => ({ slug, total, kept } as DeckSummary);
const card = (id: string, extra: Record<string, unknown> = {}): Card => ({ id, deck: id.split("/")[0] + "/0-flashcard", type: "flashcard", ord: 0, ...extra });

test("a divided book is one source with its chapters inside; apparatus and empty decks are left out", () => {
  const sources = cramSources(
    [pair("p1", "book", "ch1", "Book", "s1"), pair("p2", "book", "ch2", "Book", "s2"), pair("p3", "book", "idx", "Book", "s3"),
      pair("p4", "slides", "lec3", "Lecture 3: OLS"), pair("p5", "fresh", "none", "Not distilled yet")],
    [res("book", "Wooldridge.pdf"), res("slides", "lec3.pdf"), res("fresh", "new.pdf")],
    [sec("s1", "book", "Ch. 1"), sec("s2", "book", "Ch. 2"), sec("s3", "book", "Index", "apparatus")],
    [deck("ch1", 40, 5), deck("ch2", 30, 0), deck("idx", 9, 0), deck("lec3", 42, 18), deck("none", 0, 0)],
    null,
  );
  assert.deepEqual(sources.map((s) => [s.key, s.label, s.book, s.decks.map((d) => d.label)]), [
    ["book", "Wooldridge", true, ["Ch. 1", "Ch. 2"]],
    ["slides", "Lecture 3: OLS", false, ["Lecture 3: OLS"]],
  ]);
  const one = cramSources([pair("p1", "book", "ch1", "Book", "s1")], [res("book", "Wooldridge.pdf")],
    [sec("s1", "book", "Ch. 1"), sec("s2", "book", "Ch. 2")], [deck("ch1", 40, 5)], null);
  assert.deepEqual(one.map((s) => [s.label, s.book]), [["Wooldridge", true]]);
});

test("sources stand under the board page's own groups, in its own order", () => {
  const plan: BoardPlan = { purpose: "", milestones: [], groups: [{ id: "g1", name: "Exam", ord: 0 }],
    places: { b: { group: "g1", milestone: null, pinned: false, ord: 0 }, a: { group: null, milestone: null, pinned: false, ord: 1 } } };
  const sources = cramSources([pair("pa", "a", "da", "A"), pair("pb", "b", "db", "B")], [res("a", "a.pdf"), res("b", "b.pdf")], [],
    [deck("da", 3, 0), deck("db", 3, 0)], plan);
  assert.deepEqual(sources.map((s) => [s.key, s.group]), [["b", "g1"], ["a", null]]);
});

test("a cram never chosen ticks every deck; a chosen one ticks only what still exists", () => {
  const sources = cramSources([pair("pa", "a", "da", "A"), pair("pb", "b", "db", "B")], [res("a", "a.pdf"), res("b", "b.pdf")], [],
    [deck("da", 3, 0), deck("db", 3, 0)], null);
  assert.deepEqual([...tickedDecks(sources, DEFAULT_PREFS)], ["da", "db"]);
  assert.deepEqual([...tickedDecks(sources, { ...DEFAULT_PREFS, decks: ["db", "gone"] })], ["db"]);
});

test("the pile: kept mode keeps only kept cards; your closed questions ride in; drops and duplicates stay out", () => {
  const a = card("da/1"), b = card("da/2"), c = card("db/1");
  const decks = [
    { slug: "da", cards: [a, b], kept: new Set(["da/1"]) },
    { slug: "db", cards: [c, a], kept: new Set(["db/1", "da/1"]) },
  ];
  const mine = [card("mint:1", { mine: true, back: "yes" }), card("mint:2", { mine: true, back: "", mintOpen: true }),
    card("mint:3", { mine: true, back: "   " })];
  const ids = (p: typeof DEFAULT_PREFS) => pileOf(decks, mine, p).map((x) => x.id);
  assert.deepEqual(ids(DEFAULT_PREFS), ["da/1", "db/1", "mint:1"]);
  assert.deepEqual(ids({ ...DEFAULT_PREFS, kept: false }), ["da/1", "da/2", "db/1", "mint:1"]);
  assert.deepEqual(ids({ ...DEFAULT_PREFS, kept: false, mine: false, dropped: ["da/2"] }), ["da/1", "db/1"]);
  assert.deepEqual(pileOf([{ slug: "da", cards: [a], kept: null }], [], DEFAULT_PREFS), []);
});

test("a round: got it leaves, a miss goes to the back, a multiple choice leaves either way", () => {
  const q = [{ id: "a" }, { id: "b" }, { id: "c", type: "mcq" }];
  assert.deepEqual(afterGrade(q, true).map((x) => x.id), ["b", "c"]);
  assert.deepEqual(afterGrade(q, false).map((x) => x.id), ["b", "c", "a"]);
  assert.deepEqual(afterGrade([q[2], q[0]], false).map((x) => x.id), ["a"]);
  assert.deepEqual(afterGrade([], false), []);
});
