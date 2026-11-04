import { test } from "node:test";
import assert from "node:assert/strict";
import { cardFace, cardLine, placeLine, reviewCardBlock, DEFAULT_SYSTEM, REVIEW_SYSTEM } from "./prompts.ts";
import { threadFor, THREAD_CHARS } from "./turn.ts";

const u = (text: string) => ({ role: "user" as const, text });
const m = (text: string) => ({ role: "model" as const, text });

test("thread: the whole conversation rides the turn", () => {
  const long = Array.from({ length: 400 }, (_, i) => (i % 2 ? m("a" + i) : u("q" + i)));
  const { turns, dropped } = threadFor(long);
  assert.equal(turns.length, 400);
  assert.equal(dropped, 0);
  assert.equal(turns.at(-1)!.text, "a399");
});

test("thread: a tail that starts on the model's turn is trimmed to the user's", () => {
  // Gemini rejects a history whose first turn is the model's, so the leading ones go.
  assert.deepEqual(threadFor([m("welcome"), u("q1"), m("a1")]).turns, [u("q1"), m("a1")]);
  assert.deepEqual(threadFor([m("welcome")]).turns, []);
  assert.deepEqual(threadFor(undefined).turns, []);
});

test("thread: trimming the canned welcome is NOT forgetting", () => {
  assert.equal(threadFor([m("welcome"), u("q1"), m("a1")]).dropped, 0);
  assert.equal(threadFor([m("welcome")]).dropped, 0);
});

test("thread: past the budget the OLDEST turns drop, and the count is reported", () => {
  const big = Array.from({ length: 40 }, (_, i) => (i % 2 ? m("a".repeat(1000)) : u("q".repeat(1000))));
  const { turns, dropped } = threadFor(big, 10_000);
  assert.ok(turns.length < 40, "something has to fall off");
  assert.ok(turns.length > 0, "but not everything");
  assert.equal(dropped, 40 - turns.length);
  assert.equal(turns[0].role, "user", "what survives still starts on a user turn");
  assert.equal(turns.at(-1)!.text, big.at(-1)!.text);
});

test("thread: the budget is a backstop, not a policy", () => {
  const session = Array.from({ length: 100 }, (_, i) => (i % 2 ? m("a".repeat(600)) : u("q".repeat(200))));
  assert.equal(threadFor(session).dropped, 0);
  assert.ok(THREAD_CHARS > 100_000, "600k chars ≈ 150k tokens");
});

test("the prompt lets the model answer what the source doesn't cover", () => {
  assert.match(DEFAULT_SYSTEM, /OFF THE SOURCE/);
  assert.match(DEFAULT_SYSTEM, /never refuse/i);
  assert.match(DEFAULT_SYSTEM, /isn't from the source/i);
});

test("the prompt knows it is holding ONE SECTION, as text, and says so", () => {
  assert.match(DEFAULT_SYSTEM, /ONE SECTION/);
  assert.match(DEFAULT_SYSTEM, /not the whole source/i);
  assert.match(DEFAULT_SYSTEM, /figures/i);
  assert.match(DEFAULT_SYSTEM, /cannot see it/i);
});

test("the prompt is told to use WHERE THEY ARE, and never to read it back", () => {
  assert.match(DEFAULT_SYSTEM, /WHERE THEY ARE/);
  assert.match(DEFAULT_SYSTEM, /Never read the block back/i);
});

test("the prompt refuses to invent a source it was never given", () => {
  assert.match(DEFAULT_SYSTEM, /GIVEN NOTHING TO READ/);
  assert.match(DEFAULT_SYSTEM, /never do is answer AS IF you had read a source/i);
});

test("the prompt answers everything, cards included — no quiz-back", () => {
  assert.match(DEFAULT_SYSTEM, /ANSWER THE QUESTION/);
  assert.match(DEFAULT_SYSTEM, /including the card, when the card is what they asked about/i);
  assert.match(DEFAULT_SYSTEM, /Never respond to a question with a quiz/i);
  assert.doesNotMatch(DEFAULT_SYSTEM, /STUCK|do not answer it|NOT yet turned over/i);
});

test("the prompt resolves a bare follow-up against the conversation, not the block", () => {
  assert.match(DEFAULT_SYSTEM, /THE CONVERSATION OUTRANKS THE BLOCK/);
  assert.match(DEFAULT_SYSTEM, /it means the thing you just said/i);
});

test("the card line calls the card parked scenery, and says how old it is", () => {
  const line = cardLine("What is envelope encryption?", 8 * 60_000);
  assert.match(line, /parked on \(last touched 8 minutes ago\)/);
  assert.match(line, /scenery, not a question/);
  assert.doesNotMatch(line, /in front of them/i);
  assert.match(cardLine("q", 60_000), /1 minute ago/);
  assert.match(cardLine("q", 20_000), /1 minute ago/);        // rounds up, never "0 minutes"
});

test("the review prompt shares the reading room's answering rules, byte for byte", () => {
  const tail = (s: string) => s.slice(s.indexOf("ANSWER THE QUESTION"));
  assert.ok(tail(DEFAULT_SYSTEM).length > 2000, "the shared tail is the bulk of the prompt");
  assert.equal(tail(REVIEW_SYSTEM), tail(DEFAULT_SYSTEM));
  assert.match(REVIEW_SYSTEM, /WHAT YOU ARE GIVEN IS ONE SECTION/);
  assert.match(REVIEW_SYSTEM, /GIVEN NOTHING TO READ/);
});

test("the review prompt inverts the card: the subject there, the scenery here", () => {
  assert.match(DEFAULT_SYSTEM, /THE CARD IS SCENERY/);
  assert.doesNotMatch(REVIEW_SYSTEM, /THE CARD IS SCENERY/);
  assert.match(REVIEW_SYSTEM, /THE CARD IS THE SUBJECT/);
  assert.doesNotMatch(DEFAULT_SYSTEM, /THE CARD IS THE SUBJECT/);
  assert.doesNotMatch(REVIEW_SYSTEM, /the sources on this board/);
  assert.match(REVIEW_SYSTEM, /THE CONVERSATION STILL OUTRANKS THE BLOCK/);
});

test("the review prompt keeps the answer short, and lets the card be wrong", () => {
  assert.match(REVIEW_SYSTEM, /MID-DRILL/);
  assert.match(REVIEW_SYSTEM, /THE CARD MAY BE THE PROBLEM/);
});

test("the card block names the card, its provenance, and the memory that just fell over", () => {
  const b = reviewCardBlock({
    courseTitle: "Advanced Macro", where: "Lecture 4 — Real Business Cycles",
    claim: "Technology shocks propagate through labour supply", holdingDays: 14,
    type: "flashcard", prompt: "What does the intertemporal substitution channel do?",
    answer: "It converts a temporary wage rise into extra hours worked today.",
  });
  assert.match(b, /^THE CARD THEY ARE ON/);
  assert.match(b, /From Advanced Macro — Lecture 4/);
  assert.match(b, /under the claim "Technology shocks/);
  assert.match(b, /holding at about 14 days/);
  assert.match(b, /THE QUESTION: What does the intertemporal/);
  assert.match(b, /THE ANSWER ON THE CARD: It converts/);
});

test("the card block never says the same name twice — the richer of the two wins", () => {
  const one = reviewCardBlock({ courseTitle: "The identification problem", where: "The identification problem",
    type: "flashcard", prompt: "q", answer: "a" });
  assert.match(one, /From The identification problem\./);
  const book = reviewCardBlock({ courseTitle: "What a market is", where: "repetition · One: What a market is",
    type: "flashcard", prompt: "q", answer: "a" });
  assert.match(book, /From repetition · One: What a market is\./);
  const both = reviewCardBlock({ courseTitle: "Advanced Macro", where: "4 · Real Business Cycles",
    type: "flashcard", prompt: "q", answer: "a" });
  assert.match(both, /From Advanced Macro — 4 · Real Business Cycles\./);
});

test("the card block says 'early on the ladder' rather than inventing an interval", () => {
  const b = reviewCardBlock({ courseTitle: "Macro", type: "flashcard", prompt: "q", answer: "a" });
  assert.match(b, /early on the ladder/);
  assert.doesNotMatch(b, /holding at about/);
  assert.doesNotMatch(b, /under the claim/, "no tree node — no claim sentence");
});

test("the card's faces: a flashcard is its two sides", () => {
  const f = cardFace("flashcard", { front: "What is a cartel's core problem?", back: "Each member gains by defecting." }, null);
  assert.equal(f.prompt, "What is a cartel's core problem?");
  assert.equal(f.answer, "Each member gains by defecting.");
  assert.equal(f.picked, null);
});

test("the card's faces: an MCQ carries its options, its answer, and the pick that missed", () => {
  const p = { stem: "Which is the monopoly price?", options: ["40", "60", "80"], correct: 1, explanation: "Set MR = MC." };
  const f = cardFace("mcq", p, 2);
  assert.match(f.prompt, /Which is the monopoly price\?\n1\. 40\n2\. 60\n3\. 80/);
  assert.match(f.answer, /The answer is 2\. 60/);
  assert.match(f.answer, /Set MR = MC\./);
  assert.equal(f.picked, "80", "the wrong pick rides along");
  assert.equal(cardFace("mcq", p, 1).picked, null, "a RIGHT pick is not a diagnosis — nothing to report");
});

test("the card's faces: a trick's back is its labelled parts, and it skips the ones it lacks", () => {
  const f = cardFace("trick", { problem: "Abort after 2s", title: "Thread a token", cue: "a long await", trap: "never passing it" }, null);
  assert.equal(f.prompt, "Abort after 2s");
  assert.match(f.answer, /The move: Thread a token/);
  assert.match(f.answer, /When you see: a long await/);
  assert.match(f.answer, /The trap: never passing it/);
  assert.doesNotMatch(f.answer, /Full solution/, "a part the card does not have is not labelled empty");
});

test("the card block reports an MCQ's wrong pick, because that is the diagnosis", () => {
  const b = reviewCardBlock({ courseTitle: "Macro", type: "mcq", prompt: "which?", answer: "The answer is 2.",
    picked: "Because the central bank targets the price level", holdingDays: 5 });
  assert.match(b, /They chose "Because the central bank/);
  assert.match(b, /which is not the answer/);
});

test("the card line simply omits the age when the client did not send one", () => {
  for (const ms of [undefined, null, 0, -5]) {
    const line = cardLine("q", ms as number | null | undefined);
    assert.doesNotMatch(line, /last touched|NaN|undefined/);
    assert.match(line, /parked on — "q"/);
  }
});

test("the card line truncates a long front the same way the block always did", () => {
  assert.match(cardLine("x".repeat(600), 0), new RegExp(`"${"x".repeat(400)}"`));
});

test("the prompt treats the parked card as scenery, never as a question it was asked", () => {
  assert.match(DEFAULT_SYSTEM, /THE CARD IS SCENERY/);
  assert.match(DEFAULT_SYSTEM, /never work it into a reply/i);
  assert.doesNotMatch(DEFAULT_SYSTEM, /the card in front of them/i);
});

test("the place line says the library is the library, never a board's page", () => {
  const lib = placeLine("library");
  assert.match(lib, /library/);
  assert.doesNotMatch(lib, /board's|running log|home page/, "the library is on no board");
  assert.equal(placeLine("library", true), lib);
  assert.match(placeLine("board"), /board's own page/);
  assert.equal(placeLine(undefined, true), placeLine("board"), "onHome is the older word for the board page");
  assert.equal(placeLine("reader"), "", "a reader names its section instead");
  assert.match(placeLine("keeps"), /board's kept cards/);
  assert.doesNotMatch(placeLine("keeps"), /board's own page/);
  assert.match(placeLine("keeps", false, false), /library's kept cards.*on no board/);
  assert.doesNotMatch(placeLine("keeps", false, false), /On a board/);
  assert.equal(placeLine(), "");
});
