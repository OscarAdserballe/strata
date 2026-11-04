import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMIT, press, tell } from "./capture-key.ts";

// api.ts reads window and navigator.onLine when it loads
Object.assign(globalThis, { window: new EventTarget() });
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
const { StrataAPI } = await import("../../data/api.ts");

// the server's own rule for a key
const RECEIPT_KEY = /^[A-Za-z0-9-]{8,80}$/;
let n = 0;
const vtt = () => `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nLine ${++n}.\n`;
const TALK = "https://www.youtube.com/watch?v=x";
const body = (v: string) => ({ url: TALK, title: "A talk", vtt: v });
const same = (b: { url?: string; vtt?: string }) => ({ url: b.url, vtt: b.vtt });
const FIN = "capture/finish";
const landing = () => ({ kind: "transcript" });
const gone = (r: unknown) => !!(r as { gone?: boolean } | null)?.gone;
const deleted = () => ({ gone: true });
const settle = () => new Promise((r) => setImmediate(r));
async function keyOf(route: string, board: string, b: object, answer: () => unknown = landing): Promise<string> {
  let sent = "";
  await press(route, board, same(b), b, async (key) => { sent = key; return answer(); }, gone).catch(() => {});
  return sent;
}
const refused = (status?: number) => () => { throw Object.assign(new Error("refused"), status === undefined ? {} : { status }); };
function held(b: object) {
  const keys: string[] = [], gates: ((answer: () => unknown) => void)[] = [];
  const done = press(FIN, "b1", same(b), b, (k) => { keys.push(k); return new Promise<() => unknown>((r) => gates.push(r)).then((a) => a()); }, gone)
    .then((x) => x, (e: Error) => e);
  return { keys, done, answer: async (a: () => unknown) => { await settle(); gates.shift()!(a); await settle(); } };
}

test("the same bytes go under one key while a press of them is out, whoever sends them", async () => {
  const v = vtt();
  const out = held(body(v));
  await settle();
  assert.match(out.keys[0], RECEIPT_KEY);
  assert.equal(await keyOf(FIN, "b1", body(v)), out.keys[0], "the same capture again: the receipt answers, one source");
});

test("other bytes, another board or another route are another key: a key never means two bodies", async () => {
  const v = vtt();
  const a = await keyOf(FIN, "b1", body(v), refused());
  assert.notEqual(await keyOf(FIN, "b1", body(`${v}Two.\n`)), a, "other captions under the old key would be refused (422)");
  assert.notEqual(await keyOf(FIN, "b2", body(v)), a);
  assert.notEqual(await keyOf("capture", "b1", body(v)), a);
  assert.equal(await keyOf(FIN, "b1", body(v)), a, "and the first bytes still have theirs");
});

test("captions read with another title or author are the same capture: the body first sent goes again under its key", async () => {
  const v = vtt();
  const sent: { key: string; body: object }[] = [];
  const send = async (key: string, b: object) => { sent.push({ key, body: b }); return landing(); };
  const first = { url: TALK, title: "A talk", author: "A channel", vtt: v };
  await press(FIN, "b1", same(first), first, send, gone);
  const fallback = { url: TALK, title: TALK, author: "", vtt: v };
  const again = await press(FIN, "b1", same(fallback), fallback, send, gone);
  assert.equal(again.key, sent[0].key, "the same captions under another title went under a second key: the server makes the talk twice");
  assert.deepEqual(sent[1].body, first, "another body under the same key: the server refuses it (422)");
  assert.deepEqual(again.body, first, "the press says what it sent, so the landing is told under the title it was made with");
  const renewed = await press(FIN, "b1", same(fallback), fallback, async (key, b) => { sent.push({ key, body: b }); return sent.length === 3 ? deleted() : landing(); }, gone);
  assert.notEqual(renewed.key, sent[0].key);
  assert.deepEqual([sent[3].body, renewed.body], [fallback, fallback], "a new capture is this press's own");
});

test("whatever the answer, the bytes keep their key: a landing, a lost answer, a 5xx, a 409, a 4xx", async () => {
  for (const [answer, why] of [
    [landing, "a landing: the same captions again replay the source the server made"],
    [refused(), "no answer: the server may have made it, so the press again replays"],
    [refused(502), "a 502: the site said no, nothing stored; the same key runs afresh"],
    [refused(409), "a 409: the server is still answering that key"],
    [refused(400), "a 400: nothing stored; the same bytes again are refused again"],
  ] as const) {
    const v = vtt();
    const k = await keyOf(FIN, "b1", body(v), answer);
    assert.equal(await keyOf(FIN, "b1", body(v)), k, `after ${why}`);
  }
});

test("a cancelled dialog's landing, before the next dialog presses the same captions, keeps their key", async () => {
  const v = vtt();
  const cancelled = held(body(v));
  await cancelled.answer(landing);
  assert.equal(await keyOf(FIN, "b1", body(v)), cancelled.keys[0], "the next dialog's press under a new key makes the talk twice");
});

test("a replay of a deleted source sends the bytes again under a new key, once, and every press after under that one", async () => {
  const v = vtt();
  const first = await keyOf(FIN, "b1", body(v));
  const again = held(body(v));
  await again.answer(deleted);
  assert.equal(again.keys[0], first);
  assert.notEqual(again.keys[1], first, "sent again under the old key, it can only replay the deleted source");
  assert.match(again.keys[1], RECEIPT_KEY);
  await again.answer(landing);
  assert.equal((await again.done as { key: string }).key, again.keys[1], "the landing names the key it went under");
  assert.equal(await keyOf(FIN, "b1", body(v)), again.keys[1], "the new capture keeps its key");
  const w = vtt();
  const old = await keyOf(FIN, "b1", body(w));
  const a = held(body(w)), b = held(body(w));
  await a.answer(deleted);
  await b.answer(deleted);
  assert.deepEqual([a.keys[0], b.keys[0]], [old, old]);
  assert.equal(b.keys[1], a.keys[1], "the second finds the bytes renewed already: one new capture, not two");
  const twice = held(body(vtt()));
  await twice.answer(deleted);
  await twice.answer(deleted);
  assert.equal(twice.keys.length, 2);
  assert.match(String(await twice.done), /deleted while it was being added/);
});

test(`the last ${LIMIT} captures keep their keys; one more forgets the oldest`, async () => {
  const bodies = Array.from({ length: LIMIT + 1 }, () => body(vtt()));
  const keys = [];
  for (const b of bodies) keys.push(await keyOf(FIN, "b1", b));
  assert.notEqual(await keyOf(FIN, "b1", bodies[0]), keys[0], "the oldest of LIMIT + 1 is forgotten");
  for (let i = 2; i <= LIMIT; i++) assert.equal(await keyOf(FIN, "b1", bodies[i]), keys[i]);
});

test("a landing is told once per key, however many presses carried it", async () => {
  const k = await keyOf(FIN, "b1", body(vtt()));
  assert.deepEqual([tell(k), tell(k)], [true, false]);
});

test("each press sends its key as the Idempotency-Key, the same for the same bytes, and none without one", async () => {
  const sent: { path: string; headers: Record<string, string>; body: unknown }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ path: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ kind: "transcript", cues: 1 }), { status: 503, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const b = body(vtt());
    for (let i = 0; i < 2; i++) await press(FIN, "b1", same(b), b, (key, sent) => StrataAPI.captureFinish("b1", sent, key), gone).catch(() => {});
    const link = { url: "https://example.org/a" };
    await press("capture", "b1", link, link, (key) => StrataAPI.capture("b1", link.url, key), gone).catch(() => {});
    await StrataAPI.capture("b1", "https://example.org/a").catch(() => {});
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(sent.map((s) => s.path), ["/api/boards/b1/capture/finish", "/api/boards/b1/capture/finish", "/api/boards/b1/capture", "/api/boards/b1/capture"]);
  assert.match(sent[0].headers["Idempotency-Key"], RECEIPT_KEY);
  assert.equal(sent[1].headers["Idempotency-Key"], sent[0].headers["Idempotency-Key"], "the same press again after a 503: one key, replayed");
  assert.match(sent[2].headers["Idempotency-Key"], RECEIPT_KEY);
  assert.equal(sent[3].headers["Idempotency-Key"], undefined, "no key, no header (never an empty one)");
  for (const s of sent) assert.equal(s.headers["Content-Type"], "application/json", "the key rides beside the content type, not instead of it");
  assert.deepEqual(sent[2].body, { url: "https://example.org/a" });
});
