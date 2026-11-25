import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);
const post = (path: string, body: unknown, key?: string) =>
  api(path, { method: "POST", body: JSON.stringify(body), ...(key ? { headers: { "Idempotency-Key": key } } : {}) });

test("distil: an idea kept becomes one kept card, its kept cards leave review, and undo puts them back", async () => {
  const slug = "aio-lecture-5";
  const { body: made } = await post("/api/boards", { title: "the distil board" });
  const bid = made.board.id;
  const { body: paired } = await post(`/api/boards/${bid}/pairs`, { label: "5", deck: slug });
  const { body: dk } = await api(`/api/decks/${slug}`);
  const ids = dk.cards.slice(0, 2).map((c: { id: string }) => c.id);
  await post(`/api/decks/${slug}/keeps`, { add: ids });
  await post(`/api/boards/${bid}/minted`, { front: "Why do these belong together?", variant: "bare", state: "open", pairId: paired.id, meta: {} });

  const { status, body: map } = await post(`/api/boards/${bid}/distil/map`, { decks: [slug] });
  assert.equal(status, 200);
  assert.equal(map.marks.length, 3, "two kept cards and one open question");
  assert.equal(map.ideas.length, 1, "the fake model makes one idea per deck");
  const idea = map.ideas[0];
  assert.match(idea.id, /^i[0-9a-f]{8}$/);
  assert.equal(idea.deck, slug);
  const again = await post(`/api/boards/${bid}/distil/map`, { decks: [slug] });
  assert.equal(again.body.ideas[0].id, idea.id, "the same marks are the same idea");

  const keep = { idea: idea.id, title: idea.title, deck: slug, cards: [{ front: "What ties them?", back: "One claim, in my words." }],
    from: idea.marks, drafted: "edited" };
  const bad = await post(`/api/boards/${bid}/distil/keep`, { ...keep, from: [...idea.marks, "k:nope"] });
  assert.equal(bad.status, 400, "a mark that isn't there is refused whole");
  assert.deepEqual((await api(`/api/decks/${slug}/keeps`)).body.ids.filter((x: string) => ids.includes(x)).length, 2, "…writing nothing");

  const kept = await post(`/api/boards/${bid}/distil/keep`, keep, "distil-keep-0001");
  assert.equal(kept.status, 200);
  assert.equal(kept.body.cards.length, 1);
  assert.deepEqual([...kept.body.retired].sort(), [...ids].sort(), "the kept cards retire");
  const replay = await post(`/api/boards/${bid}/distil/keep`, keep, "distil-keep-0001");
  assert.deepEqual(replay.body.cards, kept.body.cards, "the same key replays, no second card");
  assert.equal((await post(`/api/boards/${bid}/distil/keep`, keep)).status, 409, "a second keep of the idea is refused");

  const after = (await api(`/api/decks/${slug}/keeps`)).body.ids as string[];
  assert.ok(after.includes(kept.body.cards[0]), "the distilled card is kept");
  assert.ok(!ids.some((x: string) => after.includes(x)), "its originals are not");
  const row = kept.body.state.minted.find((m: { cardId: string }) => m.cardId === kept.body.cards[0]);
  assert.equal(row.back, "One claim, in my words.");
  assert.equal(row.meta.distil.idea, idea.id);
  const left = (await post(`/api/boards/${bid}/distil/map`, { decks: [slug] })).body;
  assert.equal(left.marks.length, 0, "folded marks and the distilled card are not offered again");

  const undo = await post(`/api/boards/${bid}/distil/${idea.id}/undo`, {}, "distil-undo-0001");
  assert.equal(undo.status, 200);
  assert.deepEqual([...undo.body.restored].sort(), [...ids].sort());
  const back = (await api(`/api/decks/${slug}/keeps`)).body.ids as string[];
  assert.ok(ids.every((x: string) => back.includes(x)), "undo brings the originals back into review");
  assert.ok(!back.includes(kept.body.cards[0]), "…and takes the distilled card away");
  assert.equal(undo.body.state.minted.filter((m: { meta: { distil?: unknown } }) => m.meta.distil).length, 0);
  assert.equal((await post(`/api/boards/${bid}/distil/map`, { decks: [slug] })).body.marks.length, 3, "the marks are offered again");

  await post(`/api/decks/${slug}/keeps`, { remove: ids });
  await api(`/api/boards/${bid}`, { method: "DELETE" });
});
