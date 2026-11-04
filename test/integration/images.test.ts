// The fake model says how many images reached it, which is what the chat checks read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";
import { imageRef } from "../../shared/images/ref.ts";

let boardId = "";
const server = useServer({
  env: { STRATA_FAKE_MODEL: "1", STRATA_FAKE_STREAM_MS: "1" },
  seed: async (s) => { boardId = await newBoard(s, { title: "Pictures" }); },
});
const api = (path: string, init?: RequestInit) => server.api(path, init);

// a 1×1 PNG; bytes after IEND make a different file that is still the same picture to a sniffer
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const png = (salt = "") => Buffer.concat([PNG, Buffer.from(salt)]);
const upload = (bytes: Buffer) => api("/api/images", { method: "POST", body: JSON.stringify({ data: bytes.toString("base64") }) });

test("images: the bytes are stored once under an id of their own, and served back for good", async () => {
  const first = await upload(png("a"));
  assert.equal(first.status, 200);
  const { id, mime, w, h, size } = first.body.image;
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.deepEqual({ mime, w, h, size }, { mime: "image/png", w: 1, h: 1, size: PNG.length + 1 });

  const again = await upload(png("a"));
  assert.equal(again.body.image.id, id, "the same bytes are the same image");
  assert.notEqual((await upload(png("b"))).body.image.id, id, "other bytes are another");

  const r = await server.fetch(`/api/images/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png("a"));

  const tag = r.headers.get("etag")!;
  const cached = await server.fetch(`/api/images/${id}`, { headers: { "If-None-Match": tag } });
  assert.equal(cached.status, 304, "a device that has it is told so, and nothing is sent");

  assert.equal((await server.fetch("/api/images/0123456789abcdef")).status, 404);
});

test("images: what is not a PNG, JPEG, WebP or GIF is refused, SVG above all", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  const refused = await upload(svg);
  assert.equal(refused.status, 415);
  assert.match(refused.body.error, /PNG, JPEG, WebP or GIF/);
  assert.equal((await api("/api/images", { method: "POST", body: JSON.stringify({ data: 42 }) })).status, 400);
  assert.equal((await upload(Buffer.alloc(0))).status, 415);
});

test("images: a chat turn hands the model the images its question carries, and its thread's", async () => {
  const id = (await upload(png("chat"))).body.image.id as string;
  const turn = (message: string) => api(`/api/boards/${boardId}/chat`, { method: "POST", body: JSON.stringify({ message }) });

  const missing = await turn(`${imageRef("0123456789abcdef")}\nwhat is this?`);
  assert.equal(missing.status, 400, "an image that was never uploaded is refused before the question is stored");
  assert.match(missing.body.error, /never uploaded/);

  const first = await turn(`${imageRef(id, "screenshot")}\nwhy does the curve dip?`);
  assert.equal(first.status, 200);
  const msgs = first.body.state.messages as { role: string; text: string }[];
  const asked = msgs[msgs.length - 2], reply = msgs[msgs.length - 1];
  assert.equal(asked.text, `${imageRef(id, "screenshot")}\nwhy does the curve dip?`, "the question is stored with its image, as written");
  assert.match(reply.text, /I can see the image you sent\./);

  const second = await turn("and the dashed one?");
  const r2 = second.body.state.messages.at(-1).text as string;
  assert.doesNotMatch(r2, /I can see/, "this question carried none");
  assert.match(r2, /1 earlier image in this thread rode along too/, "the thread's image rides every later turn");
});

test("images: a card's chat takes them too", async () => {
  const id = (await upload(png("card"))).body.image.id as string;
  const deck = (await api("/api/decks")).body.decks[0];
  const card = (await api(`/api/decks/${deck.slug}`)).body.cards[0];
  const r = await server.fetch("/api/review/chat", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ card: card.id, course: deck.slug, message: `${imageRef(id)} is this the same idea?` }) });
  assert.equal(r.status, 200);
  const frames = await r.text();
  assert.match(frames, /I can see the image you sent/);
});

test("images: the card in front of them rides the board's turn with its picture", async () => {
  const id = (await upload(png("on-card"))).body.image.id as string;
  const r = await api(`/api/boards/${boardId}/chat`, { method: "POST", body: JSON.stringify({
    message: "what is this card asking?",
    here: { thread: null, card: { prompt: `What does this show?\n${imageRef(id)}`, shownMs: 4000 } },
  }) });
  assert.equal(r.status, 200);
  assert.match(r.body.state.messages.at(-1).text, /I can see the image you sent\./, "the card's picture reached the model");
});
