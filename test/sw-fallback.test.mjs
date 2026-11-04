// The worker runs in a vm with a hand-driven clock, so "after 8 s" is set by the test, not waited for.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { NotesSave } from "../web/data/notes-save.ts";

const origin = "https://strata.test", base = "/u/di/";
const SRC = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

function worker() {
  const stores = new Map(), listeners = new Map(), timers = [];
  let told = null;
  let network = async () => new Response("fresh");
  const cache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    const key = (req) => new URL(typeof req === "string" ? req : req.url, origin).href;
    return {
      async match(req, options) {
        const url = key(req);
        return (options?.ignoreSearch ? [...entries].find(([u]) => u.split("?")[0] === url.split("?")[0])?.[1] : entries.get(url))?.clone();
      },
      async put(req, response) { entries.set(key(req), response.clone()); },
      async delete(req) { return entries.delete(key(req)); },
      async keys() { return [...entries.keys()].map((u) => new Request(u)); },
    };
  };
  const context = vm.createContext({ Request, Response, Headers, URL, Date, TextDecoder, Uint8Array,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
    fetch: (req) => network(req),
    caches: { open: async (name) => cache(name), keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) },
    self: { registration: { scope: origin + base }, location: { origin }, skipWaiting() {}, clients: { async claim() {}, async matchAll() { return told ? [{ postMessage: (m) => told.push(m) }] : []; } }, addEventListener: (type, fn) => listeners.set(type, fn) },
  });
  vm.runInContext(SRC, context);
  return {
    cache, network(fn) { network = fn; }, clients(list) { told = list; },
    advance(ms) { for (const t of timers) if (t.live && t.ms <= ms) { t.live = false; t.fn(); } },
    delays: () => timers.map((t) => t.ms),
    request(path, navigate = false, headers = {}) {
      const req = new Request(origin + path, { headers });
      if (navigate) Object.defineProperty(req, "mode", { value: "navigate" });
      let result;
      listeners.get("fetch")({ request: req, respondWith(p) { result = p; }, waitUntil() {} });
      return result;
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
async function peek(p) {
  let out = "pending";
  p.then((v) => { out = v; }, (e) => { out = e; });
  for (let i = 0; i < 5; i++) await tick();
  return out;
}
const SAVED = () => new Response(JSON.stringify({ notes: "days old" }), { headers: { "X-Strata-Saved-At": "1234" } });

test("a slow API read waits for the wire instead of answering with the saved copy", async () => {
  const w = worker(), path = `${base}api/boards/b`;
  await w.cache("strata-off-v2-api").put(path, SAVED());
  let release;
  w.network(() => new Promise((resolve) => { release = resolve; }));
  const answer = w.request(path);
  await tick(); await tick();
  w.advance(1500);
  assert.equal(await peek(answer), "pending", "…and the saved copy does not stand in");
  w.advance(5000);
  assert.equal(await peek(answer), "pending");
  release(new Response(JSON.stringify({ notes: "today's" })));
  const r = await answer;
  assert.equal(r.headers.get("X-Strata-Shelf"), null);
  assert.equal((await r.json()).notes, "today's");
});

test("an API read that hangs past the wire's grace gets the saved copy, marked", async () => {
  const w = worker(), path = `${base}api/boards/b`;
  await w.cache("strata-off-v2-api").put(path, SAVED());
  w.network(() => new Promise(() => {}));
  const answer = w.request(path);
  await tick(); await tick();
  w.advance(8000);
  const r = await answer;
  assert.equal(r.headers.get("X-Strata-Shelf"), "1");
  assert.equal(r.headers.get("X-Strata-Saved-At"), "1234");
});

test("an API read whose network fails gets the saved copy at once", async () => {
  const w = worker(), path = `${base}api/boards/b`;
  await w.cache("strata-off-v2-api").put(path, SAVED());
  w.network(async () => { throw new TypeError("Failed to fetch"); });
  const r = await w.request(path);
  assert.equal(r.headers.get("X-Strata-Shelf"), "1");
  assert.equal((await r.json()).notes, "days old");
});

test("a saved page answers a navigation at once, unmarked, while the live page is fetched behind it", async () => {
  const shell = worker();
  await shell.cache("strata-off-v2-shell").put(base, new Response("saved room"));
  await shell.cache("strata-off-v2-shell").put(`${base}dist/main.js?v=old1`, new Response("old bundle"));
  let asked = 0, release;
  shell.network(() => { asked++; return new Promise((resolve) => { release = resolve; }); });
  const page = await shell.request(`${base}?board=b`, true);
  assert.equal(await page.text(), "saved room");
  assert.equal(page.headers.get("X-Strata-Shelf"), null, "not an offline copy: the shell is served this way by design");
  assert.deepEqual(shell.delays(), [], "no patience timer: the copy answers at once");
  assert.equal(asked, 1, "…and the live page is on its way");
  release(new Response('<script src="dist/main.js?v=new2"></script>', { status: 200 }));
  for (let i = 0; i < 8; i++) await tick();
  const kept = (await shell.cache("strata-off-v2-shell").keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
  assert.ok(!kept.includes(`${base}dist/main.js?v=old1`), "the previous build's bundle is pruned once the new page is saved");
  assert.equal(await (await shell.cache("strata-off-v2-shell").match(base)).text(), '<script src="dist/main.js?v=new2"></script>');

  const api = worker(), path = `${base}api/boards/b`;
  await api.cache("strata-off-v2-api").put(path, SAVED());
  api.network(() => new Promise(() => {}));
  api.request(path);
  await tick(); await tick();
  assert.deepEqual(api.delays(), [8000], "an API read still waits the wire's grace");
});

test("a navigation whose live page says the login lapsed drops the saved page, so the next load reaches the login", async () => {
  const w = worker();
  await w.cache("strata-off-v2-shell").put(base, new Response("saved room"));
  await w.cache("strata-off-v2-shell").put(`${base}dist/main.js?v=s1`, new Response("bundle"));
  w.network(async () => new Response("login", { status: 401 }));
  assert.equal(await (await w.request(base, true)).text(), "saved room", "this visit still opens on the copy");
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(await w.cache("strata-off-v2-shell").match(base), undefined);
  assert.ok(await w.cache("strata-off-v2-shell").match(`${base}dist/main.js?v=s1`), "the bundle stays for the next sign-in");
  assert.equal((await w.request(base, true)).status, 401, "without a copy the login page comes through");
});

test("a boot read marked snapshot-safe gets the last answer at once; the page is told only when the live one differs", async () => {
  const w = worker(), path = `${base}api/register`;
  const told = [];
  w.clients(told);
  let live = JSON.stringify({ entries: [1] });
  w.network(async () => new Response(live, { headers: { "Content-Type": "application/json", "X-Strata-Rev": "7" } }));
  const first = await w.request(path, false, { "X-Strata-Snapshot": "ok" });
  assert.equal(first.headers.get("X-Strata-Snapshot"), null, "nothing saved yet: the live answer, as is");
  assert.deepEqual(await first.json(), { entries: [1] });
  for (let i = 0; i < 8; i++) await tick();
  const second = await w.request(path, false, { "X-Strata-Snapshot": "ok" });
  assert.equal(second.headers.get("X-Strata-Snapshot"), "1");
  assert.equal(second.headers.get("X-Strata-Shelf"), null, "a snapshot is not an offline copy");
  assert.deepEqual(await second.json(), { entries: [1] });
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(told, [], "the live answer matched: nothing to say");
  live = JSON.stringify({ entries: [1, 2] });
  const third = await w.request(path, false, { "X-Strata-Snapshot": "ok" });
  assert.deepEqual(await third.json(), { entries: [1] }, "the snapshot first…");
  for (const until = Date.now() + 2000; !told.length && Date.now() < until;) await new Promise((r) => setTimeout(r, 5));
  // the message was made in the worker's realm: spread it so the comparison sees plain objects
  assert.deepEqual(told.map((m) => ({ ...m })), [{ type: "strata:snapshot", path }], "…then the page hears the list moved and re-reads");
  const plain = await w.request(path);
  assert.equal(plain.headers.get("X-Strata-Snapshot"), null, "an ordinary read never takes the snapshot");
  assert.deepEqual(await plain.json(), { entries: [1, 2] });
});

test("once the room has called the wire down, a hanging API read gets the saved copy after the shell's wait", async () => {
  const w = worker(), path = `${base}api/boards/b`;
  await w.cache("strata-off-v2-api").put(path, SAVED());
  w.network(() => new Promise(() => {}));
  const answer = w.request(path, false, { "X-Strata-Wire": "down" });
  await tick(); await tick();
  assert.deepEqual(w.delays(), [1500], "not the 8 s an API read gives a wire it still believes in");
  w.advance(1500);
  const r = await answer;
  assert.equal(r.headers.get("X-Strata-Shelf"), "1");
  assert.equal((await r.json()).notes, "days old");
});

test("the client's reads say the wire is down only while it is", async (t) => {
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
  const asked = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (String(url).endsWith("/api/health")) return new Response(JSON.stringify({ ok: true }));
    asked.push({ url: String(url), wire: new Headers(init?.headers).get("X-Strata-Wire") });
    return new Response(JSON.stringify({ board: { id: "b" }, notes: "days old" }), { headers: { "X-Strata-Shelf": "1", "X-Strata-Saved-At": "1234" } });
  });
  const { StrataAPI, StrataWireDown } = await import("../web/data/api.ts?offline");
  assert.equal(StrataWireDown(), true);
  await StrataAPI.getBoard("b");
  assert.deepEqual(asked.at(-1), { url: "/api/boards/b", wire: "down" });
  // a 0 ms timer is not an immediate: many setImmediate turns can pass first, so wait with a real deadline
  for (const until = Date.now() + 2000; StrataWireDown() && Date.now() < until;) await new Promise((r) => setTimeout(r, 5));
  assert.equal(StrataWireDown(), false);
  await StrataAPI.getBoard("b");
  assert.deepEqual(asked.at(-1), { url: "/api/boards/b", wire: null });
  for (let i = 0; i < 5; i++) await tick();
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
});

test("the worker's API patience is the wire's grace period, and stays so", () => {
  const sw = Number(/const API_PATIENCE_MS = (\d+);/.exec(SRC)?.[1]);
  const wire = fs.readFileSync(new URL("../web/platform/wire.ts", import.meta.url), "utf8");
  const grace = Number(/this\.grace = o\.grace \?\? (\d+);/.exec(wire)?.[1]);
  assert.ok(sw > 0 && grace > 0);
  assert.equal(sw, grace, "sw.js API_PATIENCE_MS and wire.ts's default grace must move together");
});

test("the client knows a marked copy when it holds one", async (t) => {
  // web/data/api.ts reads navigator.onLine at load; Node's navigator has none
  Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
  let shelf = true;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/api/health")) return new Response(JSON.stringify({ ok: true }));
    return new Response(JSON.stringify({ board: { id: "b" }, notes: shelf ? "days old" : "today's" }),
      { headers: shelf ? { "X-Strata-Shelf": "1", "X-Strata-Saved-At": "1234" } : {} });
  });
  const { StrataAPI, StrataFromShelf } = await import("../web/data/api.ts");
  const old = await StrataAPI.getBoard("b");
  assert.equal(StrataFromShelf(old), true);
  shelf = false;
  const live = await StrataAPI.getBoard("b");
  assert.equal(StrataFromShelf(live), false);
  assert.equal(StrataFromShelf(null), false);
  for (let i = 0; i < 5; i++) await tick();
});

test("a log seeded from a saved copy cannot be written until the live one reseeds it", async () => {
  const sent = [];
  const ns = new NotesSave({ send: async (board, text) => { sent.push([board, text]); }, failed: () => {}, setTimer: (fn) => (fn(), 1), clearTimer: () => {} });
  ns.seed("b", "days old", { stale: true });
  assert.equal(ns.stale, true);
  ns.edit("days old, and a new line typed over it");
  ns.flush(); ns.leave(true);
  assert.deepEqual(sent, [], "nothing typed over a saved copy reaches the server");
  ns.seed("b", "today's");
  assert.equal(ns.stale, false);
  ns.edit("today's, and a new line");
  await tick();
  assert.deepEqual(sent, [["b", "today's, and a new line"]]);
});
