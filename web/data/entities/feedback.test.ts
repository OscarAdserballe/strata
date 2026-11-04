import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { feedback, feedbackOps } from "./feedback.ts";
import { deckOps, decks } from "./decks.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
function room() {
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store: new Store(),
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
  });
  return { sent, m };
}

test("a ✎ note is one keyed op, flushed if the tab closes, and a refusal comes back to the form", async () => {
  assert.equal(feedbackOps.send({ comment: "x" }).flush, true);
  const { sent, m } = room();
  const saving = feedback.send({ kind: "general", comment: "the card is wrong" }, m);
  await tick();
  assert.equal(sent[0].req.path, "/api/feedback");
  assert.match(sent[0].req.headers["Idempotency-Key"], /^[0-9a-f]{32}$/);
  sent[0].reply({ status: 400, body: { error: "a note needs words" }, rev: 0, epoch: "" });
  await assert.rejects(saving, /a note needs words/);
});

test("a deck set aside or put back waits in the deck's lane", async () => {
  assert.deepEqual(deckOps.setAside("d1", false).lanes, ["deck:d1"]);
  assert.equal(deckOps.setAside("d1", true).path, "/api/decks/d1/restore");
  const { sent, m } = room();
  const aside = decks.setAside("d1", false, m);
  await tick();
  assert.equal(sent[0].req.path, "/api/decks/d1/ignore");
  sent[0].reply({ status: 200, body: { ok: true, cards: 3 }, rev: 2, epoch: "" });
  assert.deepEqual(await aside, { ok: true, cards: 3 });
});
