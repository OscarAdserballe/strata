import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { levelOf } from "../../web/capabilities/card/drill-order.ts";
import { startServer, useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("course packs load from the configured data directory", async () => {
  const { status, body } = await api("/api/decks");
  assert.equal(status, 200);
  assert.ok(body.decks.length > 0, "courses/*.json should have loaded at boot");
  const aio = body.decks.find((d: { slug: string }) => d.slug === "aio-lecture-4");
  assert.ok(aio, "aio-lecture-4 should be present");
  assert.ok(aio.total > 0);
  const one = await api("/api/decks/aio-lecture-4");
  assert.equal(one.status, 200);
  assert.ok(one.body.cards.length > 0);
  assert.match(one.body.cards[0].id, /^aio-lecture-4\//);
  assert.ok(typeof one.body.cards[0].source === "string");
  assert.ok(one.body.cards.every((c: { type: string }) => c.type === "flashcard"));
  const formerMcq = one.body.cards.find((c: { id: string }) => c.id.includes("/mcq/"));
  assert.ok(formerMcq, "the fixture should preserve a former MCQ's stable id");
  assert.ok(typeof formerMcq.front === "string" && typeof formerMcq.back === "string");
  assert.equal(formerMcq.options, undefined, "retired interaction fields do not reach the client");
  const missing = await api("/api/decks/does-not-exist");
  assert.equal(missing.status, 404);
});

// A dropped card leaves a tombstone, so the bulk rewrites (boot, re-distil) cannot resurrect it.
test("dropping a card removes it, tombstones it, and restore is its exact undo", async () => {
  const { body: before } = await api("/api/decks/aio-lecture-3");
  const victim = before.cards[before.cards.length - 1];
  const drop = await api(`/api/decks/aio-lecture-3/cards/${victim.id}`, { method: "DELETE" });
  assert.equal(drop.status, 200);
  assert.equal(drop.body.total, before.cards.length - 1);
  const { body: after } = await api("/api/decks/aio-lecture-3");
  assert.ok(!after.cards.some((c: { id: string }) => c.id === victim.id), "the card should be gone");
  const { body: list } = await api("/api/decks");
  const listed = list.decks.find((d: { slug: string }) => d.slug === "aio-lecture-3");
  assert.equal(listed.total, before.cards.length - 1);
  assert.equal(listed.ignored, 1);
  const { body: pile } = await api("/api/decks/aio-lecture-3/ignored");
  assert.equal(pile.cards.length, 1);
  assert.equal(pile.cards[0].id, victim.id);
  assert.ok(pile.cards[0].type, "an ignored card keeps its payload");
  const direct = new DatabaseSync(server.db);
  const tomb = direct.prepare("SELECT id FROM card_drops WHERE id = ?").get(victim.id);
  direct.close();
  assert.ok(tomb, "a dropped card leaves a tombstone");
  const again = await api(`/api/decks/aio-lecture-3/cards/${victim.id}`, { method: "DELETE" });
  assert.equal(again.status, 404);
  const back = await api(`/api/decks/aio-lecture-3/cards/${victim.id}/restore`, { method: "POST" });
  assert.equal(back.status, 200);
  const { body: restored } = await api("/api/decks/aio-lecture-3");
  assert.deepEqual(restored.cards.map((c: { id: string }) => c.id), before.cards.map((c: { id: string }) => c.id));
  const { body: emptied } = await api("/api/decks/aio-lecture-3/ignored");
  assert.equal(emptied.cards.length, 0);
});

test("a face holding fenced JSX round-trips through the PATCH byte for byte, and the route answers at once", async () => {
  const { body: deck } = await api("/api/decks/aio-lecture-5");
  const card = deck.cards.find((c: { type: string }) => c.type === "flashcard");
  assert.ok(card, "the fixture should hold a flashcard");
  const back = "Framework runtimes dispatch requests directly to internal action handlers.\n\nE.g. Next.js:\n```\n\n// Everything in one file, end-to-end type safety, zero fetch boilerplate\nimport { approveRun } from './actions'\n\n<button onClick={() => approveRun('123')}>Approve</button>\n```\n\nInternally, it also directly routes to the JS function rather than calling the API";
  const t0 = Date.now();
  const { status, body } = await api(`/api/decks/aio-lecture-5/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ back }) });
  assert.equal(status, 200);
  assert.ok(Date.now() - t0 < 2000, "the save must answer promptly");
  assert.equal(body.card.back, back, "every byte of the pasted answer survives — braces, arrows, tags, fences");
  const { body: again } = await api("/api/decks/aio-lecture-5");
  assert.equal(again.cards.find((c: { id: string }) => c.id === card.id).back, back);
});

test("a card can be rewritten, only its faces, and the rewrite survives a re-import", async () => {
  const { body: deck } = await api("/api/decks/aio-lecture-4");
  const card = deck.cards.find((c: { type: string }) => c.type === "flashcard");
  assert.ok(card, "the fixture should hold a flashcard");
  const was = { front: card.front, source: card.source, node: card.node };

  const bad = await api(`/api/decks/aio-lecture-4/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ front: "   " }) });
  assert.equal(bad.status, 400, "a card may not lose its question");
  const nothing = await api(`/api/decks/aio-lecture-4/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ ord: 99, node: "n9" }) });
  assert.equal(nothing.status, 400, "provenance is not a face — there was nothing to rewrite");

  const mine = "In MY words: " + was.front;
  const { status, body } = await api(`/api/decks/aio-lecture-4/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ front: mine }) });
  assert.equal(status, 200);
  assert.equal(body.card.front, mine);
  assert.equal(body.card.edited, true, "a rewritten card says so, wherever it is drawn");
  assert.equal(body.card.source, was.source, "the anchor is provenance and stays put");
  assert.equal(body.card.node, was.node);
  assert.equal(body.card.id, card.id, "the id never moves — the schedule and the log hang off it");

  const { body: again } = await api("/api/decks/aio-lecture-4");
  assert.equal(again.cards.find((c: { id: string }) => c.id === card.id).front, mine);
  const { body: two } = await api(`/api/decks/aio-lecture-4/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ back: "my own answer" }) });
  assert.equal(two.card.front, mine);
  assert.equal(two.card.back, "my own answer");

  // a second server over the same DB re-imports the courses exactly as a boot does
  const boot = await startServer({ db: server.db, env: { STRATA_MIN_SECTION_WORDS: undefined } })
    .catch((e: Error) => assert.fail(`the second server should boot over the same db: ${e.message}`));
  try {
    const r = await boot.fetch("/api/decks/aio-lecture-4");
    const fresh = (await r.json()).cards.find((c: { id: string }) => c.id === card.id);
    assert.equal(fresh.front, mine, "the re-import must not put the model's words back");
    assert.equal(fresh.back, "my own answer");
  } catch (e) {
    process.stderr.write(`\n── second server output ──\n${boot.output().trim() || "(nothing)"}\n── end of second server output ──\n`);
    throw e;
  } finally { await boot.stop(); }

  const { body: after } = await api("/api/decks/aio-lecture-4");
  assert.equal(after.cards.find((c: { id: string }) => c.id === card.id).front, mine);
});

test("a deck's total and its touched counts are the whole deck — nothing is scoped away", async () => {
  const { body: deck } = await api("/api/decks/aio-lecture-4");
  // an authored bundle has no tree, so no layers; the counting must not care
  const passes: number[] = deck.cards.map((c: Record<string, unknown>) => levelOf(c));
  assert.deepEqual([...new Set(passes)], [1], "an authored bundle has no tree to layer by");
  const { body: list } = await api("/api/decks");
  const d = list.decks.find((x: { slug: string }) => x.slug === "aio-lecture-4");
  assert.equal(d.total, deck.cards.length);
  const first = deck.cards[0];
  const last = deck.cards[deck.cards.length - 1];
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "passes" }) });
  const id = made.board.id;
  const show = (card: string) => api("/api/log", { method: "POST", body: JSON.stringify({ event: "card_show", props: { board: id, card } }) });
  await show(first.id); await show(last.id);
  const { body: t } = await api(`/api/boards/${id}/touched`);
  assert.equal(t.touched["aio-lecture-4"].seen, 2);
  const gone = await api("/api/decks/aio-lecture-4/depth", { method: "PUT", body: JSON.stringify({ depth: 0 }) });
  assert.equal(gone.status, 404);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("the seen route names the cards the counts add up — and answering is its own list", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "the trail" }) });
  const id = made.board.id;
  const { body: deck } = await api("/api/decks/aio-lecture-4");
  const [a, b] = [deck.cards[0].id, deck.cards[1].id];
  const log = (event: string, props: Record<string, unknown>) =>
    api("/api/log", { method: "POST", body: JSON.stringify({ event, props: { board: id, ...props } }) });
  const fresh = await api(`/api/boards/${id}/seen`);
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body.seen, [], "a board nobody has drilled has been past nothing");
  await log("card_show", { card: a }); await log("card_show", { card: b }); await log("card_show", { card: a });
  await log("card_grade", { card: a, got: true });
  const { body: seen } = await api(`/api/boards/${id}/seen`);
  assert.deepEqual(seen.seen.slice().sort(), [a, b].sort(), "shown twice is still one tick");
  assert.deepEqual(seen.done, [a], "done is answered-for, not merely shown");
  // and the count the tile draws is the length of the list the trail draws
  const { body: t } = await api(`/api/boards/${id}/touched`);
  assert.equal(t.touched["aio-lecture-4"].seen, seen.seen.length);
  assert.equal((await api(`/api/boards/nope/seen`)).status, 404);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("a rebuilt deck replaces the cards it made and keeps a card filed into it from another deck", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "a deck that holds a guest" }) });
  const id = made.board.id;
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "guest.md", base64: Buffer.from("# Guest\n\nText.\n").toString("base64") }) });
  const tree = { title: "Guest", question: "?", nodes: [{ label: "guest", kind: "concept", anchor: "#guest" }] };
  const card = (front: string) => ({ node: "n1", type: "flashcard", source: "#guest", front, back: "a." });
  const put = (fronts: string[]) => api(`/api/boards/${id}/resources/${res.id}/tree`, { method: "PUT", body: JSON.stringify({ tree, cards: fronts.map(card) }) });
  assert.equal((await put(["one?", "two?"])).status, 200);
  const slug = (await api(`/api/boards/${id}/resources/${res.id}/tree`)).body.deck;
  const guest = "src-elsewhere/flashcard/a-guest";
  const db = new DatabaseSync(server.db, { timeout: 2000 });
  db.prepare("INSERT INTO cards (id,course,deck,type,payload,ord) VALUES (?,?,?,?,?,?)")
    .run(guest, slug, `${slug}/0-flashcard`, "flashcard", JSON.stringify({ id: guest, front: "a guest?", back: "kept." }), 99);
  db.close();
  assert.equal((await put(["three?"])).status, 200);
  const ids = (await api(`/api/decks/${slug}`)).body.cards.map((c: { id: string }) => c.id).sort();
  assert.deepEqual(ids, [guest, `${slug}/flashcard/three`].sort(), "its own cards are rebuilt; the guest stays");
  await api(`/api/boards/${id}`, { method: "DELETE" });
});
