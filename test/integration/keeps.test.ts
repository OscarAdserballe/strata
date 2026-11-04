// These run in order: each leaves the library as it found it, which the next relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("keeps: the set is the deck's own, and a stranger's id is refused whole", async () => {
  const { body: dk } = await api("/api/decks/aio-lecture-4");
  const [a, b] = [dk.cards[0].id, dk.cards[1].id];

  const fresh = await api("/api/decks/aio-lecture-4/keeps");
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.ids, [], "nothing kept until someone chooses");

  // a card of another deck is refused before anything is written
  const { body: other } = await api("/api/decks/aio-lecture-3");
  const bad = await api("/api/decks/aio-lecture-4/keeps", { method: "POST", body: JSON.stringify({ add: [a, other.cards[0].id] }) });
  assert.equal(bad.status, 400);
  assert.deepEqual((await api("/api/decks/aio-lecture-4/keeps")).body.ids, [], "the refused request wrote nothing");

  const empty = await api("/api/decks/aio-lecture-4/keeps", { method: "POST", body: JSON.stringify({}) });
  assert.equal(empty.status, 400, "nothing to keep or unkeep is a caller mistake");
  assert.equal((await api("/api/decks/does-not-exist/keeps")).status, 404);

  await api("/api/decks/aio-lecture-4/keeps", { method: "POST", body: JSON.stringify({ add: [a] }) });
  const swap = await api("/api/decks/aio-lecture-4/keeps", { method: "POST", body: JSON.stringify({ add: [b], remove: [a] }) });
  assert.deepEqual(swap.body.ids, [b], "a swap is one round trip");
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 2000 });
  const rows = db.prepare("SELECT event, props FROM events WHERE event IN ('card_keep','card_unkeep') ORDER BY id ASC").all() as { event: string; props: string }[];
  assert.ok(rows.length >= 3, "every change logged its own event");
  for (const r of rows) {
    const p = JSON.parse(r.props);
    assert.equal(p.board, undefined, "a keep carries NO board: touched_at must not move");
    assert.ok(p.deck && p.card, "…and names its deck and its card");
  }
  db.close();
  await api("/api/decks/aio-lecture-4/keeps", { method: "POST", body: JSON.stringify({ remove: [b] }) });
});

test("authored cards auto-enrol on close in their course's review schedule", async () => {
  const slug = "aio-lecture-7";
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "the authored schedule" }) });
  const bid = made.board.id;
  const { body: paired } = await api(`/api/boards/${bid}/pairs`, { method: "POST", body: JSON.stringify({ label: "7 · Review", deck: slug }) });

  const { body: closed } = await api(`/api/boards/${bid}/minted`, { method: "POST", body: JSON.stringify({
    front: "Why does my own card return?", back: "Because making it is already a decision to retain it.",
    variant: "bare", state: "closed", pairId: paired.id, meta: {},
  }) });
  const closedRow = closed.state.minted.find((m: { id: string }) => m.id === closed.id);
  assert.ok(closedRow.cardId?.startsWith(`${slug}/yours/`), "a closed authored card materializes at save");
  assert.ok((await api(`/api/decks/${slug}/keeps`)).body.ids.includes(closedRow.cardId), "…and materializing enrols it");

  const { body: open } = await api(`/api/boards/${bid}/minted`, { method: "POST", body: JSON.stringify({
    front: "What about a question with no answer yet?", variant: "bare", state: "open",
    pairId: paired.id, meta: {},
  }) });
  assert.equal(open.state.minted.find((m: { id: string }) => m.id === open.id).cardId, null, "an open question is not reviewable");
  const { body: answered } = await api(`/api/boards/${bid}/minted/${open.id}`, { method: "PATCH", body: JSON.stringify({
    back: "It enrols only once I close it in my own words.", state: "closed",
  }) });
  const answeredRow = answered.state.minted.find((m: { id: string }) => m.id === open.id);
  assert.ok(answeredRow.cardId, "closing later performs the same automatic enrolment");

  const { body: review } = await api("/api/review");
  assert.equal(review.total, 0, "new authored cards are scheduled, not due immediately");
  assert.ok(review.nextDueAt > Date.now(), "the review queue promises their first return");

  const { body: where } = await api(`/api/review/tree?course=${slug}`);
  assert.equal(where.pair, paired.id, "review carries the pair needed to file another authored card into the same course");
  await api(`/api/boards/${bid}`, { method: "DELETE" });
});

test("keeps: an authored question materializes on keep, and the take-back reverses it whole", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "the asking board" }) });
  const bid = made.board.id;
  const slug = "aio-lecture-4";
  const { body: closed } = await api(`/api/boards/${bid}/minted`, { method: "POST", body: JSON.stringify({
    front: "Is second-mover leniency ever defensible?", variant: "bare", state: "closed",
    back: "Only when it still breaks the first-mover's certainty.", source: "asked at the essay",
    meta: { answer: "…", hot: true } }) });
  const { body: open } = await api(`/api/boards/${bid}/minted`, { method: "POST", body: JSON.stringify({
    front: "an open hole, no back yet", variant: "bare", state: "open", meta: {} }) });

  // an open question is refused: an empty back on the ladder would read as knowledge
  const refuse = await api(`/api/decks/${slug}/keeps/minted`, { method: "POST", body: JSON.stringify({ board: bid, mint: open.id }) });
  assert.equal(refuse.status, 400, "still open — its own gate's argument, honoured here");

  const kept = await api(`/api/decks/${slug}/keeps/minted`, { method: "POST", body: JSON.stringify({ board: bid, mint: closed.id }) });
  assert.equal(kept.status, 200);
  const card = kept.body.card;
  assert.ok(card && card.id.startsWith(`${slug}/yours/`), "the id is content-derived, in the deck's own idiom");
  assert.ok(kept.body.ids.includes(card.id), "materializing IS keeping — one act");
  assert.equal(card.authored, true, "the payload wears its provenance");
  const { body: dk } = await api(`/api/decks/${slug}`);
  const inDeck = dk.cards.find((c: { id: string }) => c.id === card.id);
  assert.ok(inDeck, "the question is a cards row");
  assert.ok(dk.cards.every((c: { ord: number }) => inDeck.ord <= c.ord), "…standing at the deck's head");
  const { body: mlist } = await api(`/api/boards/${bid}/minted`);
  assert.equal(mlist.minted.find((m: { id: string }) => m.id === closed.id).cardId, card.id);
  const again = await api(`/api/decks/${slug}/keeps/minted`, { method: "POST", body: JSON.stringify({ board: bid, mint: closed.id }) });
  assert.equal(again.body.card.id, card.id, "idempotent whole");
  assert.equal(again.body.ids.filter((x: string) => x === card.id).length, 1);

  await api("/api/log", { method: "POST", body: JSON.stringify({ event: "card_grade", props: { card: card.id, got: true, review: true } }) });
  const { body: owed } = await api("/api/review");
  assert.ok(owed.nextDueAt !== null, "graded and kept, the question promises a return");

  const back = await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ remove: [card.id] }) });
  assert.deepEqual(back.body.ids, [], "the keep went");
  assert.ok(back.body.state, "the board whose question came back rides the response");
  const { body: dk2 } = await api(`/api/decks/${slug}`);
  assert.ok(!dk2.cards.some((c: { id: string }) => c.id === card.id), "the card row went with it");
  const { body: mlist2 } = await api(`/api/boards/${bid}/minted`);
  const row = mlist2.minted.find((m: { id: string }) => m.id === closed.id);
  assert.equal(row.cardId, null, "the link is cleared");
  assert.equal(row.state, "closed", "…and the question kept its own state");
  const { body: after } = await api("/api/review");
  assert.equal(after.nextDueAt, null, "the promise went with the keep — the orphaned grade matches no row");

  await api(`/api/boards/${bid}`, { method: "DELETE" });
});

test("the library collection: boards roll up, and an orphaned keep lands in unfiled", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "the library shelf" }) });
  const bid = made.board.id;
  await api(`/api/boards/${bid}/pairs`, { method: "POST", body: JSON.stringify({ label: "2 · Pilot", deck: "aio-lecture-2-pilot" }) });
  const { body: dk } = await api("/api/decks/aio-lecture-2-pilot");
  const paired = dk.cards[0].id;
  await api("/api/decks/aio-lecture-2-pilot/keeps", { method: "POST", body: JSON.stringify({ add: [paired] }) });
  // every test board is deleted on its way out, so this committed deck hangs off no pair by now
  const { body: dk3 } = await api("/api/decks/aio-lecture-3");
  const orphan = dk3.cards[0].id;
  await api("/api/decks/aio-lecture-3/keeps", { method: "POST", body: JSON.stringify({ add: [orphan] }) });

  const { status, body: lib } = await api("/api/collection");
  assert.equal(status, 200);
  const row = lib.boards.find((b: { id: string }) => b.id === bid);
  assert.ok(row, "a board with a paired deck is a row");
  assert.equal(row.kept, 1);
  assert.equal(row.decksTotal, 1);
  assert.equal(row.decksBenched, 1, "the keep benched its deck");
  assert.ok(row.benched && row.lastKeepAt !== null, "…and the roll-up says so, with a clock");
  assert.ok(row.groups[0].cards.some((c: { id: string }) => c.id === paired), "the row carries its kept cards, grouped");
  assert.ok(lib.boards.every((b: { groups: unknown[] }) => b.groups.length > 0), "a board with nothing to curate is not a row");
  const un = lib.unfiled.find((g: { deck: string }) => g.deck === "aio-lecture-3");
  assert.ok(un, "the orphaned keep is surfaced, never dropped");
  assert.ok(un.cards.some((c: { id: string }) => c.id === orphan));
  assert.notEqual(un.label, "aio-lecture-3", "the residue wears the course's own title, not its slug");

  await api("/api/decks/aio-lecture-2-pilot/keeps", { method: "POST", body: JSON.stringify({ remove: [paired] }) });
  await api("/api/decks/aio-lecture-3/keeps", { method: "POST", body: JSON.stringify({ remove: [orphan] }) });
  await api(`/api/boards/${bid}`, { method: "DELETE" });
});

test("keeps lifecycle: stale keeps count nothing and stay deletable, and a drop outranks the keep", async () => {
  const slug = "aio-lecture-5";
  const { body: dk } = await api(`/api/decks/${slug}`);
  const a = dk.cards[0].id;

  const bad = await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ remove: [a] }) });
  assert.equal(bad.status, 400, "not a kept card — the batch is refused before anything is written");

  // a stale keep (its card re-id'd away by a re-distil), planted as one would leave it
  const stale = "gone/flashcard/re-idd-away";
  const db = new DatabaseSync(server.db, { timeout: 2000 });
  db.prepare("INSERT OR IGNORE INTO card_keeps (id,course,deck,created_at) VALUES (?,?,?,?)")
    .run(stale, slug, `${slug}/0-flashcard`, Date.now());
  db.close();
  const { body: dl } = await api("/api/decks");
  assert.equal(dl.decks.find((d: { slug: string }) => d.slug === slug).kept, 0,
    "the tile counts LIVE keeps only — a phantom ★ is a lie about what the bench can show");
  const rm = await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ remove: [stale] }) });
  assert.equal(rm.status, 200, "…and the stale keep is still deletable through the ordinary route");

  await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ add: [a] }) });
  await api(`/api/decks/${slug}/cards/${a}`, { method: "DELETE" });
  assert.deepEqual((await api(`/api/decks/${slug}/keeps`)).body.ids, [], "a tombstone is never owed to the ladder");
  await api(`/api/decks/${slug}/cards/${a}/restore`, { method: "POST" });
  assert.deepEqual((await api(`/api/decks/${slug}/keeps`)).body.ids, [a], "a card put back is kept again if it was kept");
  await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ remove: [a] }) });
});

// Re-keeping a dropped card must not mint beside its tombstone, or the next applyDrops deletes it.
test("a question kept again after its card was dropped comes back under its id, not beside a tombstone", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "re-keep board" }) });
  const bid = made.board.id, slug = "aio-lecture-5";
  const { body: q1 } = await api(`/api/boards/${bid}/minted`, { method: "POST", body: JSON.stringify({
    front: "Why does a dropped question come back whole?", variant: "bare", state: "closed", back: "Its tombstone is lifted.", meta: {} }) });
  const first = await api(`/api/decks/${slug}/keeps/minted`, { method: "POST", body: JSON.stringify({ board: bid, mint: q1.id }) });
  const cid = first.body.card.id;
  await api(`/api/decks/${slug}/cards/${encodeURIComponent(cid).replace(/%2F/g, "/")}`, { method: "DELETE" });
  const again = await api(`/api/decks/${slug}/keeps/minted`, { method: "POST", body: JSON.stringify({ board: bid, mint: q1.id }) });
  assert.equal(again.status, 200);
  assert.equal(again.body.card.id, cid, "the same card, under its own id");
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 2000 });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(cid) as { n: number }).n;
  try { assert.deepEqual([count("cards"), count("card_drops"), count("card_keeps")], [1, 0, 1], "a card, kept, and no tombstone for applyDrops to act on"); }
  finally { db.close(); }
  await api(`/api/boards/${bid}`, { method: "DELETE" });
});

// Setting a deck aside and restoring it must give its keeps back too.
test("a deck set aside and restored keeps what was kept, as the single drop and restore do", async () => {
  const slug = "aio-lecture-4";
  const { body: dk } = await api(`/api/decks/${slug}`);
  const [a, b] = [dk.cards[0].id, dk.cards[1].id];
  await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ add: [a, b] }) });
  await api(`/api/decks/${slug}/cards/${a}`, { method: "DELETE" });
  assert.equal((await api(`/api/decks/${slug}/ignore`, { method: "POST" })).status, 200);
  assert.deepEqual((await api(`/api/decks/${slug}/keeps`)).body.ids, [], "a deck set aside owes nothing");
  assert.equal((await api(`/api/decks/${slug}/restore`, { method: "POST" })).status, 200);
  const back = await api(`/api/decks/${slug}`);
  assert.equal(back.body.cards.length, dk.cards.length, "every card where it stood");
  assert.deepEqual([...(await api(`/api/decks/${slug}/keeps`)).body.ids].sort(), [a, b].sort(), "both kept again");
  await api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ remove: [a, b] }) });
});

test("the mint↔card lifecycle: write-through, reopen, delete and board-delete all keep the pair honest", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "the lifecycle board" }) });
  const bid = made.board.id;
  const slug = "aio-lecture-5";
  const mk = async (front: string) =>
    (await api(`/api/boards/${bid}/minted`, { method: "POST", body: JSON.stringify({ front, variant: "bare", state: "closed", back: "mine, in one sentence.", meta: {} }) })).body.id;

  const m1 = await mk("where does the lifecycle live?");
  const kept = await api(`/api/decks/${slug}/keeps/minted`, { method: "POST", body: JSON.stringify({ board: bid, mint: m1 }) });
  const cid = kept.body.card.id;
  const other = await api("/api/decks/aio-lecture-6/keeps/minted", { method: "POST", body: JSON.stringify({ board: bid, mint: m1 }) });
  assert.equal(other.status, 400);
  assert.ok(String(other.body.error).includes("one home"), "…and the refusal says the rule");

  await api(`/api/boards/${bid}/minted/${m1}`, { method: "PATCH", body: JSON.stringify({ front: "where does the lifecycle REALLY live?" }) });
  const { body: after } = await api(`/api/decks/${slug}`);
  assert.equal(after.cards.find((c: { id: string }) => c.id === cid).front, "where does the lifecycle REALLY live?");

  await api(`/api/boards/${bid}/minted/${m1}`, { method: "PATCH", body: JSON.stringify({ state: "open" }) });
  assert.ok(!(await api(`/api/decks/${slug}`)).body.cards.some((c: { id: string }) => c.id === cid), "the card went with the reopening");
  assert.deepEqual((await api(`/api/decks/${slug}/keeps`)).body.ids, [], "…keep included");

  const m2 = await mk("does deleting it strand the card?");
  const k2 = await api(`/api/decks/${slug}/keeps/minted`, { method: "POST", body: JSON.stringify({ board: bid, mint: m2 }) });
  await api(`/api/boards/${bid}/minted/${m2}`, { method: "DELETE" });
  assert.ok(!(await api(`/api/decks/${slug}`)).body.cards.some((c: { id: string }) => c.id === k2.body.card.id));
  assert.deepEqual((await api(`/api/decks/${slug}/keeps`)).body.ids, []);

  const m3 = await mk("and deleting the whole board?");
  const k3 = await api(`/api/decks/${slug}/keeps/minted`, { method: "POST", body: JSON.stringify({ board: bid, mint: m3 }) });
  await api(`/api/boards/${bid}`, { method: "DELETE" });
  assert.ok(!(await api(`/api/decks/${slug}`)).body.cards.some((c: { id: string }) => c.id === k3.body.card.id), "board delete takes the shadow too");
  assert.deepEqual((await api(`/api/decks/${slug}/keeps`)).body.ids, []);
});
