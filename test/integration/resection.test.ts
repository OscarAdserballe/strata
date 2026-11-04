import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);
const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit =>
  ({ method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers } });

// Three chapters, one a page; the third is the longest, so a merge of two and three is mostly three.
const pageText = ["One begins the book. ".repeat(20), "Two is the short middle. ".repeat(10), "Three is the long end. ".repeat(40)];
const outline = ["One", "Two", "Three"].map((label, id) => ({ id, label, page: id + 1, offset: 0, depth: 0, parent: null }));
const tree = { title: "T", question: "?", nodes: [{ label: "idea", kind: "concept", anchor: "p. 1" }] };
const card = (front: string) => ({ node: "n1", type: "flashcard", source: "p. 1", front, back: "a." });

interface Section { id: string; label: string; resourceId: string }
async function book(title: string) {
  const board = await newBoard(server, { title });
  const made = await api(`/api/boards/${board}/resources`, json("POST", {
    filename: "book.pdf", base64: Buffer.from("%PDF-1.4 not a real file").toString("base64"), pageText,
    importPlan: { outline, starts: [1, 2], excluded: [] },
  }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const rid = made.body.id as string;
  const sections = (made.body.state.sections as Section[]).filter((s) => s.resourceId === rid);
  assert.deepEqual(sections.map((s) => s.label), ["One", "Two", "Three"]);
  const decks: string[] = [];
  for (const [i, s] of sections.entries()) {
    const put = await api(`/api/boards/${board}/resources/${rid}/tree?section=${s.id}`, json("PUT", { tree, cards: [card(`what does chapter ${i + 1} say?`), card(`why chapter ${i + 1}?`)] }));
    assert.equal(put.status, 200, JSON.stringify(put.body));
    decks.push((await api(`/api/boards/${board}/resources/${rid}/tree?section=${s.id}`)).body.deck);
  }
  return { board, rid, sections, decks };
}
const cardsOf = async (slug: string) => ((await api(`/api/decks/${slug}`)).body.cards ?? []) as { id: string; front: string }[];
const split = (board: string, rid: string) => api(`/api/boards/${board}/resources/${rid}/sections`);
const resplit = (board: string, rid: string, starts: number[], rev: number, key = `resplit-${Math.random().toString(36).slice(2)}`) =>
  api(`/api/boards/${board}/resources/${rid}/sections`, json("PUT", { plan: { outline, starts, excluded: [] } }, { "If-Match": `"${rev}"`, "Idempotency-Key": key }));

test("the section editor opens on the current split, and an unchanged split keeps every id", async () => {
  const { board, rid, sections, decks } = await book("resplit unchanged");
  const { status, body } = await split(board, rid);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.plan.starts, [1, 2], "the current split, as choices over the outline");
  assert.deepEqual(body.plan.excluded, []);
  assert.equal(body.pageText.length, 3);
  const before = await cardsOf(decks[0]);
  const same = await resplit(board, rid, [1, 2], body.rev);
  assert.equal(same.status, 200, JSON.stringify(same.body));
  const now = (same.body.state.sections as Section[]).filter((s) => s.resourceId === rid);
  assert.deepEqual(now.map((s) => s.id), sections.map((s) => s.id), "a section whose text did not change keeps its id");
  assert.deepEqual((await cardsOf(decks[0])).map((c) => c.id), before.map((c) => c.id), "and its deck");
  await api(`/api/boards/${board}`, { method: "DELETE" });
});

test("merging two sections keeps the larger one's id and moves the other's kept cards, with their history, into it", async () => {
  const { board, rid, sections, decks } = await book("resplit merge");
  const [, two, three] = sections;
  const kept = (await cardsOf(decks[1]))[0];
  const unkept = (await cardsOf(decks[1]))[1];
  const ownKept = (await cardsOf(decks[0]))[0];
  assert.equal((await api(`/api/decks/${decks[1]}/keeps`, json("POST", { add: [kept.id] }))).status, 200);
  assert.equal((await api(`/api/decks/${decks[0]}/keeps`, json("POST", { add: [ownKept.id] }))).status, 200);
  assert.equal((await api("/api/review/grade", json("POST", { requestId: "grade-before-resplit", course: decks[1], card: kept.id, got: true }))).status, 200);
  const mine = "In my words: what does the middle say?";
  assert.equal((await api(`/api/decks/${decks[1]}/cards/${kept.id}`, json("PATCH", { front: mine }))).status, 200);

  const { body: open } = await split(board, rid);
  const stale = await resplit(board, rid, [1], open.rev - 1);
  assert.equal(stale.status, 409, "a split based on an older one is refused");
  assert.deepEqual(stale.body.conflict.value.sections.map((s: { id: string }) => s.id), sections.map((s) => s.id));

  const key = "resplit-merge-once";
  const merged = await resplit(board, rid, [1], open.rev, key);
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.refiled, 1);
  const again = await resplit(board, rid, [1], open.rev, key);
  assert.deepEqual(again.body.sections, merged.body.sections, "a resent split replays its answer");
  const now = (merged.body.state.sections as Section[]).filter((s) => s.resourceId === rid);
  assert.deepEqual(now.map((s) => s.id), [sections[0].id, three.id], "the merge takes the id of the section it shares most text with");
  assert.equal(now[1].label, "Two → Three");
  const pairs = (merged.body.state.pairs as { resourceId: string; sectionId: string; deck: string }[]).filter((p) => p.resourceId === rid);
  assert.deepEqual(pairs.map((p) => p.sectionId), now.map((s) => s.id), "one pair per section, in the book's order");

  const heir = await cardsOf(decks[2]);
  const moved = heir.find((c) => c.id === kept.id);
  assert.ok(moved, "the kept card moved into the merged section's deck under its own id");
  assert.equal(moved.front, mine, "with your edit");
  assert.ok(!heir.some((c) => c.id === unkept.id), "an unkept card of the removed section goes with it");
  assert.ok((await api(`/api/decks/${decks[2]}/keeps`)).body.ids.includes(kept.id), "still kept");
  assert.ok((await api(`/api/decks/${decks[0]}/keeps`)).body.ids.includes(ownKept.id), "an untouched section's keeps stay");
  const history = await api(`/api/review/history?course=${decks[2]}&card=${encodeURIComponent(kept.id)}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.reviews.length, 1, "its review history is still attached");
  assert.equal((await api(`/api/decks/${decks[1]}`)).status, 404, "the removed section's deck is gone");
  assert.equal((await api(`/api/boards/${board}/resources/${rid}/tree?section=${two.id}`)).status, 404);

  // the merged section's deck is rebuilt by its re-distil; the card that moved in stays
  const rebuilt = await api(`/api/boards/${board}/resources/${rid}/tree?section=${three.id}`, json("PUT", { tree, cards: [card("what do two and three say?")] }));
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
  assert.ok((await cardsOf(decks[2])).some((c) => c.id === kept.id), "a moved-in kept card survives the heir's rebuild");

  const { body: reopened } = await split(board, rid);
  assert.deepEqual(reopened.plan.starts, [1]);
  const back = await resplit(board, rid, [1, 2], reopened.rev);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const after = (back.body.state.sections as Section[]).filter((s) => s.resourceId === rid);
  assert.equal(after[0].id, sections[0].id);
  assert.equal(after[2].id, three.id, "split again, the larger half keeps the id");
  assert.notEqual(after[1].id, two.id, "the other half is a new section");
  assert.ok((await cardsOf(decks[2])).some((c) => c.id === kept.id), "and the moved card stays where it went");

  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 2000 });
  try {
    const orphans = db.prepare("SELECT COUNT(*) n FROM trees WHERE resource_id = ? AND section_id NOT IN (SELECT id FROM sections)").get(rid) as { n: number };
    assert.equal(orphans.n, 0, "no tree outlives its section");
    const keeps = db.prepare("SELECT course FROM card_keeps WHERE id = ?").get(kept.id) as { course: string };
    assert.equal(keeps.course, decks[2]);
  } finally { db.close(); }
  await api(`/api/boards/${board}`, { method: "DELETE" });
});

test("a source imported before outlines were kept opens on its pages, and keeps its ids when left alone", async () => {
  const board = await newBoard(server, { title: "resplit legacy" });
  const made = await api(`/api/boards/${board}/resources`, json("POST", {
    filename: "old.pdf", base64: Buffer.from("%PDF-1.4 not a real file").toString("base64"), pageText,
    sections: [{ label: "One", firstPage: 1, lastPage: 1 }, { label: "Two", firstPage: 2, lastPage: 2 }, { label: "Three", firstPage: 3, lastPage: 3 }],
  }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const rid = made.body.id as string;
  const ids = (made.body.state.sections as Section[]).filter((s) => s.resourceId === rid).map((s) => s.id);
  assert.equal(ids.length, 3);
  const { status, body } = await split(board, rid);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.hasBookmarks, false, "a file the worker cannot read has no bookmarks to offer");
  assert.deepEqual(body.plan.outline.map((h: { label: string }) => h.label), ["Page 1", "Page 2", "Page 3"]);
  assert.deepEqual(body.plan.starts, [1, 2]);
  const same = await api(`/api/boards/${board}/resources/${rid}/sections`, json("PUT", { plan: body.plan }, { "If-Match": `"${body.rev}"` }));
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.deepEqual((same.body.state.sections as Section[]).filter((s) => s.resourceId === rid).map((s) => s.id), ids);
  await api(`/api/boards/${board}`, { method: "DELETE" });
});

test("a split that leaves no text to study, or a source with one section, is refused and writes nothing", async () => {
  const { board, rid, sections } = await book("resplit refused");
  const { body: open } = await split(board, rid);
  const none = await api(`/api/boards/${board}/resources/${rid}/sections`, json("PUT", { plan: { outline, starts: [], excluded: [0, 1, 2] } }, { "If-Match": `"${open.rev}"` }));
  assert.equal(none.status, 400);
  const { body: state } = await api(`/api/boards/${board}`);
  assert.deepEqual((state.sections as Section[]).filter((s) => s.resourceId === rid).map((s) => s.id), sections.map((s) => s.id));
  const md = await api(`/api/boards/${board}/resources`, json("POST", { filename: "one.md", base64: Buffer.from("# One\n\nText.\n").toString("base64") }));
  assert.equal((await split(board, md.body.id)).status, 409);
  await api(`/api/boards/${board}`, { method: "DELETE" });
});
