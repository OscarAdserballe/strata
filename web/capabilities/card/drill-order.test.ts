import { test } from "node:test";
import assert from "node:assert/strict";
import { levelOf, byPass, passesOf, stageOf, byStage, stagesOf, SKIM, DEEPER, cardPrompt } from "./drill-order.ts";
import { facesOf, FACES } from "../../../shared/cards/faces.ts";

test("a definition card is pass 1, whatever deck it sits in", () => {
  assert.equal(levelOf({ introduces: "steady state", deck: "src-abc/0-flashcard" }), 0);
  assert.equal(levelOf({ introduces: "output gap", deck: "aio-lecture-4/2-mcq" }), 0);
});

test("a card takes the layer of the claim it came from", () => {
  assert.equal(levelOf({ node: "n1", type: "flashcard" }), 1);
  assert.equal(levelOf({ node: "n2", type: "mcq" }), 1);
  assert.equal(levelOf({ node: "n1.2", type: "flashcard" }), 2);
  assert.equal(levelOf({ node: "n1.2", type: "trick" }), 2);
  assert.equal(levelOf({ node: "n10.3.1", type: "mcq" }), 3);
  assert.equal(levelOf({}), 1);
  assert.equal(levelOf({ node: "", type: "flashcard" }), 1);
  assert.equal(levelOf({ introduces: "", node: "n1.2" }), 2);
});

test("a definition keeps layer 0 however deep in the tree it was written", () => {
  assert.equal(levelOf({ introduces: "steady state", node: "n4.2.1.3" }), 0);
  assert.equal(levelOf({ node: "n4.2.1.3" }), 4);
});

test("byPass sorts by layer first, then the source's own order", () => {
  const cards = [
    { node: "n1.1", ord: 3 },
    { node: "n2", ord: 2 },
    { node: "n1.1.4", ord: 4 },
    { introduces: "k", node: "n1.1", ord: 1 },
  ];
  const sorted = [...cards].sort(byPass);
  assert.deepEqual(sorted.map((c) => c.ord), [1, 2, 3, 4]);
});

test("passesOf lists the layers present, in order — the rows the trail draws", () => {
  assert.deepEqual(passesOf([
    { node: "n1.2" }, { introduces: "k", node: "n3" }, { node: "n3" },
  ]), [0, 1, 2]);
  assert.deepEqual(passesOf([{ type: "flashcard" }, { type: "mcq" }]), [1]);
  assert.deepEqual(passesOf([]), []);
});

test("cardPrompt picks the question side per type", () => {
  assert.equal(cardPrompt({ type: "mcq", stem: "S", front: "F" }), "S");
  assert.equal(cardPrompt({ type: "trick", problem: "P", front: "F" }), "P");
  assert.equal(cardPrompt({ type: "flashcard", front: "F" }), "F");
});

test("every card type's FIRST face is its question — the one that may not be emptied", () => {
  assert.equal(facesOf("flashcard")[0].key, "front");
  assert.equal(facesOf("mcq")[0].key, "stem");
  assert.equal(facesOf("trick")[0].key, "problem");
  for (const [type, faces] of Object.entries(FACES)) {
    const card = { type, [faces[0].key]: "the question" };
    assert.equal(cardPrompt(card), "the question", type);
  }
});

test("the faces are the card's own, and provenance is not among them", () => {
  assert.deepEqual(facesOf("flashcard").map((f) => f.key), ["front", "back"]);
  const keys = new Set(Object.values(FACES).flat().map((f) => f.key));
  for (const own of ["id", "deck", "type", "ord", "node", "source", "correct", "introduces"]) {
    assert.ok(!keys.has(own), `${own} is the card's identity or provenance, never a face`);
  }
});

test("an unknown type still gets the plain two-sided card rather than nothing", () => {
  assert.deepEqual(facesOf("cloze"), FACES.flashcard);
  assert.deepEqual(facesOf(undefined), FACES.flashcard);
});

test("stageOf files terms and top-level claims in the skim, everything deeper in the deeper pass", () => {
  assert.equal(stageOf({ introduces: "k", node: "n3.1.2" }), SKIM);
  assert.equal(stageOf({ node: "n1" }), SKIM);
  assert.equal(stageOf({ node: "n2" }), SKIM);
  assert.equal(stageOf({ node: "n1.2" }), DEEPER);
  assert.equal(stageOf({ node: "n1.2.3" }), DEEPER);
  assert.equal(stageOf({}), SKIM);
});

test("byStage runs the skim first (terms before claims), then the deeper pass by the SOURCE'S order", () => {
  const cards = [
    { node: "n1.1.4", ord: 4 },
    { node: "n2", ord: 6 },
    { node: "n1.2", ord: 3 },
    { introduces: "k", node: "n2.1", ord: 7 },
    { node: "n1", ord: 1 },
    { node: "n2.1", ord: 8 },
  ];
  const sorted = [...cards].sort(byStage).map((c) => c.ord);
  assert.deepEqual(sorted, [7, 1, 6, 3, 4, 8]);
});

test("stagesOf lists the passes a deck actually has — a flat deck is one skim", () => {
  assert.deepEqual(stagesOf([{ node: "n1.2" }, { introduces: "k" }, { node: "n3" }]), [SKIM, DEEPER]);
  assert.deepEqual(stagesOf([{ type: "flashcard" }, { type: "mcq" }]), [SKIM]);
  assert.deepEqual(stagesOf([{ node: "n1.1" }]), [DEEPER]);
  assert.deepEqual(stagesOf([]), []);
});
