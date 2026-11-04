import { test } from "node:test";
import assert from "node:assert/strict";

// every fetch waits until the test answers it, in the order they were made
const answers: ((r: Response) => void)[] = [];
const held = (() => new Promise<Response>((resolve) => { answers.push(resolve); })) as typeof fetch;
globalThis.fetch = held;
// api.ts listens on window when it loads, and stampSession wraps window.fetch: both stand-ins first
const win = Object.assign(new EventTarget(), { fetch: held });
Object.assign(globalThis, { window: win, sessionStorage: { getItem: () => null, setItem: () => {} } });
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { api, whenQuiet, stampSession } = await import("./api.ts");
stampSession();

test("with nothing out it calls back once, 250 ms after it was asked and not before", async () => {
  let n = 0;
  const t0 = Date.now();
  let at = 0;
  whenQuiet(() => { n++; at = Date.now() - t0; });
  await wait(150);
  assert.equal(n, 0, "not at once: the reads a board's draw sets off may not have left yet");
  await wait(200);
  assert.equal(n, 1);
  assert.ok(at >= 240, `called back after ${at} ms`);
  await wait(300);
  assert.equal(n, 1, "once");
});

test("a read out holds it, and the 250 ms count from the read coming back", async () => {
  let n = 0;
  const read = api("/api/boards/b-1/resources/r-1/tree");
  whenQuiet(() => { n++; });
  await wait(400);
  assert.equal(n, 0, "never while the read is out");
  answers.shift()!(json({ ok: true }));
  await read;
  await wait(150);
  assert.equal(n, 0, "not until nothing has been out for 250 ms");
  await wait(200);
  assert.equal(n, 1);
});

test("a source's bytes out through the wrapped fetch hold it too", async () => {
  let n = 0;
  const bytes = win.fetch("/api/boards/b-1/resources/r-1/raw");
  whenQuiet(() => { n++; });
  await wait(400);
  assert.equal(n, 0, "never while the bytes are out");
  answers.shift()!(new Response("%PDF-1.7"));
  await bytes;
  await wait(350);
  assert.equal(n, 1);
});

test("a request leaving inside the 250 ms starts the count again, and a cancelled wait calls nothing", async () => {
  let n = 0, cancelledCalls = 0;
  whenQuiet(() => { n++; });
  const stop = whenQuiet(() => { cancelledCalls++; });
  stop();
  await wait(150);
  const read = api("/api/decks");
  answers.shift()!(json({ decks: [] }));
  await read;
  await wait(150);
  assert.equal(n, 0, "the read came back 150 ms ago: not yet");
  await wait(200);
  assert.equal(n, 1);
  assert.equal(cancelledCalls, 0);
});
