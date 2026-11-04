import { test } from "node:test";
import assert from "node:assert/strict";
import { imageIds, imageParts, imageRef, removeImage, replaceImages, withoutImages } from "./ref.ts";

const A = "0123456789abcdef", B = "fedcba9876543210";

test("an image is a token in the text, found wherever it stands", () => {
  const t = `${imageRef(A, "graph")}\nwhy does it dip? ${imageRef(B)} and ${imageRef(A)}`;
  assert.deepEqual(imageIds(t), [A, B], "each once, in order");
  assert.deepEqual(imageParts(t), [{ id: A, alt: "graph" }, { text: "\nwhy does it dip? " }, { id: B, alt: "" }, { text: " and " }, { id: A, alt: "" }]);
  assert.deepEqual(imageParts("no pictures"), [{ text: "no pictures" }]);
});

test("only the room's own ids are images: a web link or a short id stays text", () => {
  assert.deepEqual(imageIds("![x](https://example.com/a.png) ![y](img:abc) ![z](img:0123456789ABCDEF)"), []);
  assert.equal(imageRef(A, "a ] tricky\nalt"), `![a   tricky alt](img:${A})`);
});

test("without its images a question reads as its words; the model reads stand-ins", () => {
  assert.deepEqual(withoutImages(`${imageRef(A)}\n${imageRef(B)}\n\nwhat is this?`), { text: "what is this?", ids: [A, B] });
  assert.equal(replaceImages(`${imageRef(A)} vs ${imageRef(B)}`, (_id, n) => `[image ${n}]`), "[image 1] vs [image 2]");
});

test("taking an image off a face takes its line with it", () => {
  assert.equal(removeImage(`front\n${imageRef(A)}\nmore`, A), "front\nmore");
  assert.equal(removeImage(`${imageRef(A)}\nfront`, A), "front");
  assert.equal(removeImage(`see ${imageRef(A)} here`, A), "see  here");
  assert.equal(removeImage(`a ${imageRef(B)}`, A), `a ${imageRef(B)}`, "another image stays");
});
