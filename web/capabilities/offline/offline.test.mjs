import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { saveOfflineUrl, updateInterface } from "./offline.ts";

const origin = "https://strata.test";
const base = "/u/di/";
const shell = "strata-off-v2-shell", api = "strata-off-v2-api";

function worker() {
  const stores = new Map(), listeners = new Map();
  let network = async () => new Response("fresh");
  const cache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    const key = (req) => new URL(typeof req === "string" ? req : req.url, origin).href;
    return {
      async match(req, options) {
        const url = key(req);
        const entry = options?.ignoreSearch ? [...entries].find(([u]) => u.split("?")[0] === url.split("?")[0])?.[1] : entries.get(url);
        return entry?.clone();
      },
      async put(req, response) { entries.set(key(req), response.clone()); },
      async delete(req) { return entries.delete(key(req)); },
      async keys() { return [...entries.keys()].map((u) => new Request(u)); },
    };
  };
  const pending = [];
  const context = vm.createContext({ Request, Response, Headers, URL, Date, setTimeout, clearTimeout,
    fetch: (req) => network(req),
    caches: { open: async (name) => cache(name), keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name) },
    self: { registration: { scope: origin + base }, location: { origin }, skipWaiting() {}, clients: { async claim() {} }, addEventListener: (type, fn) => listeners.set(type, fn) },
  });
  vm.runInContext(fs.readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8"), context);
  return {
    cache,
    network(fn) { network = fn; },
    async settled() { await Promise.all(pending.splice(0)); },
    async activate() { let task; listeners.get("activate")({ waitUntil(p) { task = p; } }); await task; },
    request(path, init = {}, navigate = false) {
      const req = new Request(origin + path, init);
      if (navigate) Object.defineProperty(req, "mode", { value: "navigate" });
      let result;
      listeners.get("fetch")({ request: req, respondWith(p) { result = p; }, waitUntil(p) { pending.push(p); } });
      return result;
    },
  };
}

test("the interface is network-first, including an unchanged asset URL", async () => {
  const w = worker(), path = `${base}dist/main.js`;
  await w.cache(shell).put(path, new Response("old"));
  w.network(async (req) => { assert.equal(req.cache, "no-cache"); return new Response("new"); });
  assert.equal(await (await w.request(path)).text(), "new");
  await w.settled();
  assert.equal(await (await w.cache(shell).match(path)).text(), "new");
});

test("versioned entry assets and hashed lazy chunks use the saved copy without a network trip", async () => {
  const w = worker();
  for (const path of [`${base}dist/main.js?v=build-one`,`${base}dist/chunks/pdf-ABCDEFGH.js`]) {
    await w.cache(shell).put(path,new Response("saved code"));
    w.network(async () => { throw new Error("immutable asset should not be fetched"); });
    const r = await w.request(path);
    assert.equal(await r.text(),"saved code"); assert.equal(r.headers.get("X-Strata-Shelf"),null);
  }
});

test("a saved room answers a navigation at once, even at a new board URL, while the live page loads behind it", async () => {
  const w = worker();
  await w.cache(shell).put(base,new Response("saved room"));
  let release;
  w.network(()=>new Promise(resolve=>{release=resolve;}));
  const started = Date.now();
  const r = await w.request(`${base}?board=new`,{},true);
  assert.equal(await r.text(),"saved room"); assert.equal(r.headers.get("X-Strata-Shelf"),null,"served this way by design, not as a fallback");
  assert.ok(Date.now()-started<100,"no patience timer: the copy answers at once");
  release(new Response("fresh room")); await w.settled();
  assert.equal(await (await w.cache(shell).match(base)).text(),"fresh room","the live page replaces the saved one for next time");
});

test("ordinary reads do not silently download new board data or sources", async () => {
  const w = worker();
  for (const path of [`${base}api/boards/b`, `${base}api/boards/b/resources/r/raw`]) {
    assert.equal((await w.request(path)).status, 200);
    assert.equal(await w.cache(api).match(path), undefined);
  }
});

test("saved data refreshes online and has a dated, explicitly marked offline fallback", async () => {
  const w = worker(), path = `${base}api/boards/b`;
  await w.cache(api).put(path, new Response("old"));
  await w.request(path);
  await w.settled();
  w.network(async () => { throw new Error("TLS connection closed"); });
  const response = await w.request(path);
  assert.equal(await response.text(), "fresh");
  assert.equal(response.headers.get("X-Strata-Shelf"), "1");
  assert.ok(Number(response.headers.get("X-Strata-Saved-At")) > 0);
});

test("a saved page answers first; a live 401 or 403 then drops it, so the next load reaches the login", async () => {
  const w = worker(), path = base;
  for (const status of [401, 403]) {
    await w.cache(shell).put(path, new Response("private room"));
    w.network(async () => new Response("denied", { status }));
    const first = await w.request(path, {}, true);
    assert.equal(first.status, 200, "this visit opens on the saved page; its reads will say the login lapsed");
    await w.settled();
    const next = await w.request(path, {}, true);
    assert.equal(next.status, status, "the saved page is gone: the live answer comes through");
    assert.equal(next.headers.get("X-Strata-Shelf"), null);
  }
  // a 500 is the room restarting: the saved page stays, and the app shows the wire down from its reads
  await w.cache(shell).put(path, new Response("private room"));
  w.network(async () => new Response("down", { status: 500 }));
  assert.equal((await w.request(path, {}, true)).status, 200);
  await w.settled();
  assert.ok(await w.cache(shell).match(path), "a server error does not cost the saved page");
});

test("a downloaded room reopens offline with a board query; another room cannot use it", async () => {
  const w = worker();
  await w.cache(shell).put(base, new Response("saved room", { headers: { "X-Strata-Saved-At": "1234" } }));
  w.network(async () => { throw new Error("offline"); });
  const response = await w.request(`${base}?board=b`, {}, true);
  assert.equal(await response.text(), "saved room");
  // the page is served cache-first by design, so it carries no shelf mark; the reads below say the wire is down
  assert.equal(response.headers.get("X-Strata-Shelf"), null);
  assert.equal((await w.request(`${base}api/boards/unsaved`)).status, 503);
  assert.equal((await w.request("/u/cy/api/boards/b")).status, 503);
});

test("health checks, explicit downloads, and writes bypass the worker", () => {
  const w = worker();
  assert.equal(w.request(`${base}api/health`, { cache: "no-store" }), undefined);
  assert.equal(w.request(`${base}api/boards/b`, { cache: "no-store" }), undefined);
  assert.equal(w.request(`${base}api/boards/b`, { method: "POST" }), undefined);
});

test("upgrading the worker preserves existing and unrelated caches", async () => {
  const w = worker();
  await w.cache("strata-off-v1-api").put(base, new Response("legacy"));
  await w.cache("another-app").put("/", new Response("unrelated"));
  await w.activate();
  assert.equal(await (await w.cache("strata-off-v1-api").match(base)).text(), "legacy");
  assert.equal(await (await w.cache("another-app").match("/")).text(), "unrelated");
});

test("downloaded PDFs still serve byte ranges without a network connection", async () => {
  const w = worker(), path = `${base}api/boards/b/resources/r/raw`;
  await w.cache(api).put(path, new Response("abcdef"));
  w.network(async () => { throw new Error("offline"); });
  const response = await w.request(path, { headers: { Range: "bytes=1-3" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("Content-Range"), "bytes 1-3/6");
  assert.equal(await response.text(), "bcd");
});

test("explicit download stamps the saved copy and surfaces quota failures", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.cache, "no-store");
    return new Response("download");
  });
  const oldLocation = globalThis.location, oldCaches = globalThis.caches;
  t.after(() => { globalThis.location = oldLocation; globalThis.caches = oldCaches; });
  globalThis.location = new URL(origin);
  let saved;
  globalThis.caches = { open: async () => ({ put: async (_url, r) => { saved = r; } }) };
  await saveOfflineUrl("/api/boards/b");
  assert.equal(await saved.text(), "download");
  assert.ok(Number(saved.headers.get("X-Strata-Saved-At")) > 0);
  globalThis.caches = { open: async () => ({ put: async () => { throw new Error("QuotaExceededError"); } }) };
  await assert.rejects(saveOfflineUrl("/api/boards/b"), /QuotaExceededError/);
});

test("download rejects expired authentication and stale fallback responses", async (t) => {
  const oldLocation = globalThis.location;
  t.after(() => { globalThis.location = oldLocation; });
  globalThis.location = new URL(origin);
  t.mock.method(globalThis, "fetch", async () => new Response("login", { status: 401 }));
  await assert.rejects(saveOfflineUrl("/api/boards/b"), /live connection/);
  t.mock.method(globalThis, "fetch", async () => new Response("missing", { status: 404 }));
  await assert.rejects(saveOfflineUrl("/dist/main.js"), /live connection/);
  await saveOfflineUrl("/api/boards/b/resources/r/tree");
  t.mock.method(globalThis, "fetch", async () => new Response("old", { headers: { "X-Strata-Shelf": "1" } }));
  await assert.rejects(saveOfflineUrl("/api/boards/b"), /live connection/);
});

test("update is opt-in, verifies connectivity, and never deletes caches", async (t) => {
  const oldWindow = globalThis.window, oldLocation = globalThis.location, oldCaches = globalThis.caches;
  t.after(() => { globalThis.window = oldWindow; globalThis.location = oldLocation; globalThis.caches = oldCaches; });
  let reloads = 0, fetches = 0;
  globalThis.window = { confirm: () => false };
  globalThis.location = { href: origin + base, reload: () => { reloads++; } };
  globalThis.caches = new Proxy({}, { get() { throw new Error("update must not touch downloads"); } });
  t.mock.method(globalThis, "fetch", async (_url, options) => { fetches++; assert.equal(options.cache, "no-store"); return new Response("app"); });
  await updateInterface();
  assert.equal(fetches, 0);
  globalThis.window.confirm = () => true;
  await updateInterface();
  assert.equal(reloads, 1);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
  await assert.rejects(updateInterface(), /offline/);
  assert.equal(reloads, 1);
});

test("an update replaces the worker's saved page, so the reload opens on the new build", async (t) => {
  const oldWindow = globalThis.window, oldLocation = globalThis.location, oldCaches = globalThis.caches;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => {
    globalThis.window = oldWindow; globalThis.location = oldLocation; globalThis.caches = oldCaches;
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else delete globalThis.navigator;
  });
  const w = worker();
  await w.cache(shell).put(base, new Response("old build"));
  await w.cache(api).put(`${base}api/boards/b`, new Response("downloaded"));
  globalThis.window = { confirm: () => true, STRATA_BASE: base };
  globalThis.location = { href: `${origin}${base}?board=b`, reload() {} };
  globalThis.caches = { open: async (name) => w.cache(name) };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: {
    getRegistration: async () => ({ scope: origin + base, update: async () => {} }),
  } } });
  t.mock.method(globalThis, "fetch", async () => new Response("new build"));
  await updateInterface();
  w.network(() => new Promise(() => {}));
  assert.equal(await (await w.request(`${base}?board=b`, {}, true)).text(), "new build");
  assert.equal(await (await w.cache(api).match(`${base}api/boards/b`)).text(), "downloaded");
});

const pdfResponse = (body = "%PDF-bytes") => new Response(body, { headers: { "Content-Type": "application/pdf", "Content-Length": String(body.length) } });
const reader = "strata-reader-v1";

test("a PDF the reader opened is kept for the next open, in the reader's cache and not the download shelf", async () => {
  const w = worker(), path = `${base}api/boards/b/resources/r/raw`;
  let fetches = 0;
  w.network(async () => { fetches++; return pdfResponse(); });
  assert.equal(await (await w.request(path)).text(), "%PDF-bytes");
  await w.settled();
  assert.equal(await (await w.request(path)).text(), "%PDF-bytes");
  const ranged = await w.request(path, { headers: { Range: "bytes=1-3" } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), "PDF");
  assert.equal(fetches, 1, "reopening and ranges cost no network");
  assert.equal(await w.cache(api).match(path), undefined, "reading is not downloading");
  assert.ok(await w.cache(reader).match(path));
});

test("the reader's cache keeps the most recently opened PDFs within its bounds", async () => {
  const w = worker();
  w.network(async () => pdfResponse());
  const raw = (n) => `${base}api/boards/b/resources/r${n}/raw`;
  for (let n = 0; n < 26; n++) { await (await w.request(raw(n))).text(); await w.settled(); }
  await (await w.request(raw(2))).text(); await w.settled();          // opening again makes it recent
  await (await w.request(raw(26))).text(); await w.settled();
  const kept = new Set((await w.cache(reader).keys()).map((r) => new URL(r.url).pathname));
  assert.equal(kept.has(raw(0)), false, "the oldest-opened are evicted");
  assert.equal(kept.has(raw(2)), true, "a recently reopened book survives");
  assert.equal(kept.has(raw(26)), true);
  assert.equal([...kept].filter((p) => p.endsWith("/raw")).length, 24);
});

test("prose, errors and oversized files are never put in the reader's cache", async () => {
  const w = worker(), path = `${base}api/boards/b/resources/r/raw`;
  for (const response of [new Response("# prose", { headers: { "Content-Type": "text/markdown", "Content-Length": "7" } }),
    new Response("gone", { status: 404, headers: { "Content-Type": "application/pdf" } }),
    new Response("x", { headers: { "Content-Type": "application/pdf", "Content-Length": String(200 * 1024 * 1024) } })]) {
    w.network(async () => response.clone());
    await (await w.request(path)).text(); await w.settled();
    assert.equal(await w.cache(reader).match(path), undefined);
  }
});

const images = "strata-images-v1";

test("a pasted image is fetched once and kept for good: the bytes behind its id never change", async () => {
  const w = worker(), path = `${base}api/images/0123456789abcdef`;
  let fetches = 0;
  w.network(async () => { fetches++; return new Response("png-bytes", { headers: { "Content-Type": "image/png" } }); });
  assert.equal(await (await w.request(path)).text(), "png-bytes");
  await w.settled();
  w.network(async () => { throw new Error("the wire is down"); });
  const again = await w.request(path);
  assert.equal(await again.text(), "png-bytes", "a second view, even offline, is the kept copy");
  assert.equal(fetches, 1);
  assert.ok(await w.cache(images).match(path));
  assert.equal(await w.cache(api).match(path), undefined, "seeing is not downloading");
});

test("a missing image is not kept", async () => {
  const w = worker(), path = `${base}api/images/fedcba9876543210`;
  w.network(async () => new Response("{}", { status: 404 }));
  assert.equal((await w.request(path)).status, 404);
  await w.settled();
  assert.equal(await w.cache(images).match(path), undefined);
});
