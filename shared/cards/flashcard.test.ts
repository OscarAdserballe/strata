import { test } from "node:test";
import assert from "node:assert/strict";
import { asFlashcard } from "./flashcard.ts";

test("an authored MCQ becomes one open-recall question and answer", () => {
  const card = asFlashcard("mcq", {
    stem: "Which margin makes collusion easier?",
    options: ["slower detection", "faster detection", "more firms"],
    correct: 1,
    explanation: "A shorter deviation window lowers the required patience.",
    source: "p. 4",
  });
  assert.deepEqual(card, {
    front: "Which margin makes collusion easier?",
    back: "faster detection\n\nA shorter deviation window lowers the required patience.",
    source: "p. 4",
  });
});

test("a detect-the-move card becomes a plain problem and answer", () => {
  const card = asFlashcard("trick", {
    problem: "The expectation contains a product of positive shocks. What should you do?",
    title: "Take logs",
    cue: "a product of positive random variables",
    trick: "Rewrite it as a lognormal.",
    trap: "Expanding the product directly.",
    solution: "Take logs, identify the lognormal variable, then use its expectation formula.",
    node: "n2",
  });
  assert.deepEqual(card, {
    front: "The expectation contains a product of positive shocks. What should you do?",
    back: "Take logs, identify the lognormal variable, then use its expectation formula.",
    node: "n2",
  });
});

test("a normal flashcard passes through as front and back", () => {
  assert.deepEqual(asFlashcard("flashcard", { front: " Q? ", back: " A. ", source: "p. 1" }), {
    front: "Q?", back: "A.", source: "p. 1",
  });
});

test("front/back edits already made after flattening outrank retired fields", () => {
  const card = asFlashcard("mcq", {
    stem: "Old question", options: ["Old answer", "No"], correct: 0,
    front: "My question", back: "My answer", edited: true,
  });
  assert.deepEqual(card, { front: "My question", back: "My answer", edited: true });
});
