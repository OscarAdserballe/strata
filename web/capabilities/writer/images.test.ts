import { test } from "node:test";
import assert from "node:assert/strict";
import { imageRefOf, shownSrc } from "./images.ts";

const ID = "0123456789abcdef";

test("a stored image is known by its ref or its URL, and nothing else comes in", () => {
  assert.equal(imageRefOf(`img:${ID}`), `img:${ID}`);
  assert.equal(imageRefOf(`/api/images/${ID}`), `img:${ID}`);
  assert.equal(imageRefOf(`https://room.example/r/api/images/${ID}`), `img:${ID}`);
  for (const other of ["https://tracker.example/pixel.png", `img:${ID}0`, `/api/images/${ID}?x=1`, "data:image/png;base64,AAAA", "", null])
    assert.equal(imageRefOf(other), null, String(other));
});

test("a ref is drawn from the room, any other link as it is", () => {
  const room = (id: string) => `/r/api/images/${id}`;
  assert.equal(shownSrc(`img:${ID}`, room), `/r/api/images/${ID}`);
  assert.equal(shownSrc("https://example.com/a.png", room), "https://example.com/a.png");
  assert.equal(shownSrc(null, room), null);
});
