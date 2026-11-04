import { test } from "node:test";
import assert from "node:assert/strict";
import { cardFaces, checkedTidy } from "./card-tidy.ts";
import { createCardTidier } from "../../web/capabilities/card/tidy.ts";

test("tidy keeps provenance out of the model and rejects oversized input without truncation", () => {
  assert.deepEqual(cardFaces("flashcard", { front: "Q", back: "", id: "id", source: "source" }), { front: "Q", back: "" });
  assert.throws(() => cardFaces("flashcard", { front: "x".repeat(4001) }), /4000/);
  assert.throws(() => cardFaces("flashcard", { back: 7 }), /text/);
});

test("invalid model output never replaces or truncates any face", () => {
  const original = { front: "Question", back: "Answer" };
  for (const response of [null, [], { front: "Question" }, { ...original, back: "" }, { ...original, back: "x".repeat(4001) }]) {
    assert.throws(() => checkedTidy(original, response), /safely tidy/);
  }
  assert.throws(() => checkedTidy({ front: "Q", back: "" }, { front: "Q", back: "An invented answer" }));
  assert.throws(() => checkedTidy({ options: ["a", "b"] }, { options: ["a"] }));
  assert.deepEqual(original, { front: "Question", back: "Answer" });
});

test("save retries reuse formatted faces and re-tidy when the draft changes", async () => {
  let calls = 0;
  const tidy = createCardTidier(async ({ faces }) => { calls++; return { faces: { ...faces, back: "$x^2$" } }; });
  const first = await tidy("flashcard", { front: "Q", back: "x²" });
  first.back = "must not corrupt cache";
  assert.equal((await tidy("flashcard", { front: "Q", back: "x²" })).back, "$x^2$");
  assert.equal((await tidy("flashcard", { front: "Q", back: "$x^2$" })).back, "$x^2$");
  assert.equal(calls, 1);
  await tidy("flashcard", { front: "Changed question", back: "x²" });
  assert.equal(calls, 2);
});

test("failed, synchronously refused, and invalid tidy calls leave the draft retriable", async () => {
  let calls = 0;
  const draft = { front: "Q", back: "x²" };
  const tidy = createCardTidier(({ faces }) => {
    if (++calls === 1) throw new Error("offline");
    return Promise.resolve({ faces: calls === 2 ? {} : faces });
  });
  await assert.rejects(tidy("flashcard", draft), /offline/);
  await assert.rejects(tidy("flashcard", draft), /safely tidy/);
  assert.deepEqual(await tidy("flashcard", draft), draft);
  assert.deepEqual(draft, { front: "Q", back: "x²" });
});

test("a late tidy result cannot be saved after the deadline or poison a retry", async () => {
  let late!: (value: { faces: Record<string, unknown> }) => void;
  let calls = 0, saved = false;
  const tidy = createCardTidier(() => ++calls === 1 ? new Promise(resolve => { late = resolve; })
    : Promise.resolve({ faces: { front: "Q", back: "retry" } }), 10);
  await assert.rejects(tidy("flashcard", { front: "Q", back: "original" }).then(() => { saved = true; }), /didn't come back/);
  late({ faces: { front: "Q", back: "late" } });
  assert.equal((await tidy("flashcard", { front: "Q", back: "original" })).back, "retry");
  assert.equal(saved, false);
});
