import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

// A due card cannot be made hermetically (the first rung is days away), so this asserts the promise.
test("the review ladder: a grade schedules, but only a KEPT card is owed back", async () => {
  const { body: dl } = await api("/api/decks");
  const slug = dl.decks.find((d: { total: number }) => d.total > 0)?.slug;
  assert.ok(slug, "the committed courses seed at boot");
  const { body: dk } = await api(`/api/decks/${slug}`);
  const cardId = dk.cards[0].id;

  const { body: before } = await api("/api/review");
  assert.deepEqual(before, { cards: [], total: 0, nextDueAt: null, unkeptDue: 0 }, "an ungraded library owes nothing");

  await api("/api/log", { method: "POST", body: JSON.stringify({ event: "card_grade", props: { card: cardId, got: true, review: true } }) });
  const { body: graded } = await api("/api/review");
  assert.equal(graded.total, 0, "a card graded seconds ago is not due");
  assert.equal(graded.nextDueAt, null, "…and an UNKEPT card promises no return — grading is not the enrolment any more");

  const kept = await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ add: [cardId] }) });
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.body.ids, [cardId], "the deck's kept set answers back whole");
  const { body: after } = await api("/api/review");
  assert.equal(after.total, 0, "kept, but still not due — the grade's draw stands");
  // the first rung is a mean of 2 days with a ±40% per-card draw: [1.2d, 2.8d]
  assert.ok(after.nextDueAt !== null && after.nextDueAt > Date.now() + 1.1 * 864e5
    && after.nextDueAt < Date.now() + 2.9 * 864e5, "…it is due a couple of days out — rung one's draw");

  const gone = await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ remove: [cardId] }) });
  assert.deepEqual(gone.body.ids, [], "unkeeping empties the set");
  const { body: unkept } = await api("/api/review");
  assert.equal(unkept.nextDueAt, null, "nothing kept, nothing promised");
});

test("session map: one row per card, the miss survives its retry, and only the review counts", async () => {
  const { body: dl } = await api("/api/decks");
  const slug = dl.decks.find((d: { total: number }) => d.total > 1)?.slug;
  const { body: dk } = await api(`/api/decks/${slug}`);
  const [a, b] = dk.cards;
  const grade = (card: string, got: boolean, review: boolean) =>
    api("/api/log", { method: "POST", body: JSON.stringify({ event: "card_grade", props: { card, got, review, ...(review ? {} : { board: "b-nope" }) } }) });

  const since = Date.now() - 6e4;
  await grade(a.id, false, true);
  await grade(a.id, true, true);
  await grade(b.id, true, false);

  const { body: map } = await api(`/api/review/session?since=${since}`);
  assert.equal(map.cards, 1, "two grades on one card are one card met");
  assert.equal(map.missed, 1, "missed at least once today is what the map remembers…");
  assert.equal(map.got, 0, "…so a card recalled on the retry does not read as a clean got");
  const met = map.topics.flatMap((t: { tree: { claims: { met: unknown[] }[] } | null; loose: unknown[] }) =>
    [...(t.tree ? t.tree.claims.flatMap((c) => c.met) : []), ...t.loose]) as { card: string; missed: boolean; got: boolean }[];
  assert.deepEqual(met.map((m) => m.card), [a.id], "the drill's card is not on the review's map");
  assert.equal(met[0].missed && met[0].got, true, "both facts ride the row: missed, then got it");

  const { body: none } = await api(`/api/review/session?since=${Date.now() + 6e4}`);
  assert.equal(none.cards, 0, "a window starting after the grades holds none of them");
  assert.deepEqual(none.topics, [], "…and no topics either");
});

// A review turn must carry no board: the log sink bumps touched_at for anything that names one.
test("review chat: a card's own turn streams, grounded, and logs itself with no board", async () => {
  const { body: dl } = await api("/api/decks");
  const slug = dl.decks.find((d: { total: number }) => d.total > 0)!.slug;
  const { body: dk } = await api(`/api/decks/${slug}`);
  const card = dk.cards[0];

  const r = await fetch(`${server.base}/api/review/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ card: card.id, course: slug, message: "why is that the answer?", rung: 2, history: [] }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/event-stream/);
  const text = await r.text();
  assert.match(text, /event: start/);
  assert.match(text, /event: delta/);
  assert.match(text, /event: done/);
  if (!server.live) assert.match(text, /Offline/, "hermetically, the deltas carry the offline placeholder");

  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  const row = db.prepare("SELECT props FROM events WHERE event = 'review_chat' ORDER BY id DESC LIMIT 1").get() as { props: string };
  db.close();
  const props = JSON.parse(row.props);
  assert.equal(props.card, card.id, "the card is on the event — which cards get asked about is the point of logging it");
  assert.equal(props.course, slug);
  assert.equal(props.review, true);
  assert.equal(props.board, undefined, "a review turn carries NO board: touched_at must not move");
  assert.equal(props.rung, 2);
});

test("review chat: the card's thread is kept, question first, and a retried key replays its turn", async () => {
  const { body: dl } = await api("/api/decks");
  const slug = dl.decks.find((d: { total: number }) => d.total > 0)!.slug;
  const { body: dk } = await api(`/api/decks/${slug}`);
  const card = dk.cards[dk.cards.length - 1];
  const thread = `/api/review/chat?course=${encodeURIComponent(slug)}&card=${encodeURIComponent(card.id)}`;
  const ask = (message: string, key: string) => fetch(`${server.base}/api/review/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", "Idempotency-Key": key },
    body: JSON.stringify({ card: card.id, course: slug, message }),
  }).then((r) => r.text());
  assert.match(await ask("what does this card test?", "card-turn-1"), /event: done/);
  const kept = (await api(thread)).body.messages;
  assert.deepEqual(kept.map((m: { role: string }) => m.role), ["user", "assistant"], "the question, then its reply");
  assert.equal(kept[0].text, "what does this card test?");
  assert.match(await ask("what does this card test?", "card-turn-1"), /event: done/);
  assert.equal((await api(thread)).body.messages.length, 2);
  assert.equal((await api(thread, { method: "DELETE" })).status, 200);
  assert.deepEqual((await api(thread)).body.messages, []);
});

test("review chat: the turn is refused without a message, and without a card that exists", async () => {
  const empty = await api("/api/review/chat", { method: "POST", body: JSON.stringify({ card: "x", course: "y", message: "   " }) });
  assert.equal(empty.status, 400);
  const gone = await api("/api/review/chat", { method: "POST", body: JSON.stringify({ card: "nope", course: "nope", message: "what is this?" }) });
  assert.equal(gone.status, 404);
});
