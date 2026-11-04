import { test } from "node:test";
import assert from "node:assert/strict";
import { type BoardTileInputs, type Pair, boardTiles } from "./boardTiles.ts";

const HOME: Pair = { id: "home", label: "home", isHome: true, resourceId: null, deck: null as never };
const pairs: Pair[] = [
  HOME,
  { id: "p1", label: "notes.md", resourceId: "r1", sectionId: "s1", deck: "d1" },
  { id: "p2a", label: "Book", resourceId: "r2", sectionId: "s2a", deck: "d2a" },
  { id: "p2b", label: "Book", resourceId: "r2", sectionId: "s2b", deck: "d2b" },
  { id: "p2c", label: "Book", resourceId: "r2", sectionId: "s2c", deck: "d2c" },
  { id: "p3", label: "Slides.pdf", resourceId: "r3", sectionId: "s3", deck: "d3" },
  { id: "p4", label: "Course deck", resourceId: null, deck: "d4" },
];
const base = (over: Partial<BoardTileInputs> = {}): BoardTileInputs => ({
  board: {
    board: { title: "Econometrics" },
    resources: [
      { id: "r1", kind: "md", filename: "notes.md", createdAt: 10, lastReadAt: 20 },
      { id: "r2", kind: "pdf", filename: "Book.pdf", read: 0.4 },
      { id: "r3", kind: "pdf", filename: "Slides.pdf", originUrl: "https://example.test/s.pdf" },
    ],
    sections: [
      { id: "s1", resourceId: "r1", label: "notes" },
      { id: "s2a", resourceId: "r2", label: "Ch 1", firstPage: 1, lastPage: 10 },
      { id: "s2b", resourceId: "r2", label: "Ch 2", firstPage: 11, lastPage: null },
      { id: "s2c", resourceId: "r2", label: "Index", kind: "apparatus", firstPage: 40, lastPage: 44 },
      { id: "s3", resourceId: "r3", label: "Slides" },
    ],
    marks: [{ resourceId: "r1" }, { resourceId: "r1" }, { resourceId: "r3" }],
    touched: { d1: { seen: 4, done: 2, last: 7 }, d2a: { seen: 1, last: 3 } },
    trees: { s2a: { status: "ready" }, s2b: { status: "running" } },
  },
  touchLive: null,
  decks: [
    { slug: "d1", total: 4, kept: 3, benched: true },
    { slug: "d2a", total: 3 },
    { slug: "d3", total: 5, ignored: 2 },
    { slug: "d4", total: 0, ignored: 6 },
  ],
  pairs, pairIdx: 0, bookView: null, qDeck: null, solo: false, activeId: "b1", driftSection: null,
  notes: "# the log", qGroups: [{ kind: "board", name: "my questions", cards: [{ mintOpen: true }, {}] }, { kind: "ignored", name: "ignored", cards: [] }],
  pageCount: (rid) => (rid === "r3" ? 23 : undefined),
  ...over,
});
const byKey = (tiles: ReturnType<typeof boardTiles>) => Object.fromEntries(tiles.map((t) => [t.key, t]));

test("no board, no tiles", () => {
  assert.deepEqual(boardTiles(base({ board: null })), []);
});

test("the top level: home, one tile per source with unfinished first, your questions, the set-aside pile, the empty slots", () => {
  const tiles = boardTiles(base());
  assert.deepEqual(tiles.map((t) => t.key),
    ["home", "fold:r2", "p3", "p4", "p1", "q:my questions", "q:ignored", "add:file", "add:link"]);
  const t = byKey(tiles);
  assert.deepEqual(t.home, { key: "home", boardId: "b1", kind: "log", label: "home", meta: "the log", cover: "the log",
    cvTitle: "Econometrics", text: "# the log", pair: 0, cur: true, title: "the board's running log" });
  assert.equal(t["fold:r2"].label, "Book");
  assert.equal(t["fold:r2"].meta, "distilling · 1/2");
  assert.equal(t["fold:r2"].busy, true);
  assert.equal(t["fold:r2"].enter, "r2");
  assert.equal(t["fold:r2"].sections, 3);
  assert.deepEqual([t["fold:r2"].cards, t["fold:r2"].seen, t["fold:r2"].last], [3, 1, 3]);
  assert.deepEqual(t["fold:r2"].del, { res: "r2" });
  assert.equal(t.p3.meta, "23 pages · 5 cards");
  assert.equal(t.p3.pages, 23);
  assert.deepEqual(t.p3.aside, { slugs: ["d3"], live: 5, out: 2 });
  assert.equal(t.p3.origin, "https://example.test/s.pdf");
  assert.equal(t.p3.marksN, 1);
  assert.equal(t.p4.meta, "6 set aside");
  assert.equal(t.p4.cover, "cards only");
  assert.deepEqual(t.p4.del, { pair: "p4" });
  assert.equal(t.p1.meta, "md · 4 cards");
  assert.deepEqual(t.p1.kp, { kept: 3, total: 4, benched: true });
  assert.deepEqual([t.p1.addedAt, t.p1.readAt, t.p1.file, t.p1.marksN], [10, 20, "notes.md", 2]);
  assert.equal(t["q:my questions"].meta, "1 open");
  assert.equal(t["q:ignored"].meta, "8 cards set aside");
  assert.equal(t["q:ignored"].ignoredPile, true);
});

test("the live drill state shadows the board's copy", () => {
  const t = byKey(boardTiles(base({ touchLive: { d3: { seen: 5 } } })));
  assert.equal(t.p3.seen, 5);
  assert.equal(t.p1.seen, 0, "the board's copy is not merged in");
});

test("inside a book: its chapters and nothing else, behind a header row", () => {
  const tiles = boardTiles(base({ pairIdx: 2, driftSection: { id: "s2b" } }));
  assert.deepEqual(tiles.map((t) => t.key), ["gap:r2", "p2a", "p2b", "p2c"]);
  const t = byKey(tiles);
  assert.deepEqual(t["gap:r2"], { key: "gap:r2", gap: "Book", root: true });
  assert.equal(t.p2a.meta, "p. 1 · 3 cards");
  assert.equal(t.p2a.title, "Ch 1 — pages 1–10");
  assert.equal(t.p2a.cur, true);
  assert.equal(t.p2a.read, 0.4, "the book's progress rides its first chapter");
  assert.equal(t.p2b.meta, "p. 11 · distilling…");
  assert.equal(t.p2b.title, "Ch 2 — pages 11–end");
  assert.equal(t.p2b.read, null);
  assert.equal(t.p2b.at, true, "the drift your eyes made");
  assert.deepEqual([t.p2c.meta, t.p2c.dim, t.p2c.cards, t.p2c.keep, t.p2c.kp], ["apparatus", true, 0, null, null]);
});

test("a browse overrides where your feet are; a book that is gone falls back to the top level", () => {
  const top = boardTiles(base({ pairIdx: 2, bookView: { top: true } }));
  assert.equal(top[0].key, "home");
  assert.equal(byKey(top)["fold:r2"].cur, true, "you are still inside it");
  assert.equal(boardTiles(base({ bookView: { rid: "r2" } }))[0].key, "gap:r2");
  assert.equal(boardTiles(base({ bookView: { rid: "gone" } }))[0].key, "home");
});

test("a question deck or cards-only takes the lit tile off home", () => {
  const t = byKey(boardTiles(base({ qDeck: { kind: "board", name: "my questions" } })));
  assert.equal(t.home.cur, false);
  assert.equal(t["q:my questions"].cur, true);
  assert.equal(byKey(boardTiles(base({ solo: true }))).home.cur, false);
});
