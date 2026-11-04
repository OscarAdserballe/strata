import { test } from "node:test";
import assert from "node:assert/strict";
import { createCardTidier, shieldImages } from "./tidy.ts";
import { imageRef } from "../../../shared/images/ref.ts";

const A = "0123456789abcdef";

test("a face's images sit out the tidy and come back where they stood", async () => {
  const seen: unknown[] = [];
  const tidy = createCardTidier(async (body) => {
    seen.push(body.faces);
    const f = body.faces as Record<string, string>;
    return { faces: { front: f.front.toUpperCase(), back: f.back.toUpperCase() } };
  });
  const out = await tidy("flashcard", { front: `${imageRef(A)}\nwhat does this show?`, back: `a spiral\n${imageRef(A, "b")}` });
  assert.deepEqual(seen, [{ front: "what does this show?", back: "a spiral" }], "the model never sees a token");
  assert.deepEqual(out, { front: `${imageRef(A)}\nWHAT DOES THIS SHOW?`, back: `A SPIRAL\n${imageRef(A, "b")}` });
});

test("a card of pictures alone is not sent to be tidied", async () => {
  let asked = 0;
  const tidy = createCardTidier(async () => { asked++; return { faces: {} }; });
  const faces = { front: imageRef(A), back: "" };
  assert.deepEqual(await tidy("flashcard", faces), faces);
  assert.equal(asked, 0);
  assert.equal(shieldImages(faces).empty, true);
});
