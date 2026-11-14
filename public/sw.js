// Cache-first shell and boot reads, refreshed behind the page; network-first API reads; only downloaded copies
// (and recently opened PDFs) answer offline.

// Retain these names so upgrading does not strand existing downloads.
const V = "strata-off-v2";
const API = V + "-api";
const SHELL = V + "-shell";
const SNAPSHOT = V + "-snapshot";
const BASE = new URL(self.registration.scope).pathname;
const API_PATH = `${BASE}api/`;

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // Keep existing downloads: a worker update is not permission to erase them.
    await dropOldPages(await caches.open(SHELL).catch(() => null));
    await self.clients.claim();
  })());
});
// The page is saved under the bare path only. Workers before 17 Oct saved each load under its own URL
// (/?board=…); found ahead of the bare path, such a copy opened every load on its old build.
async function dropOldPages(cache) {
  if (!cache) return;
  for (const key of await cache.keys()) {
    const u = new URL(key.url);
    if (u.pathname === BASE && u.search) await cache.delete(key);
  }
}

// The reader's cache: the last few opened PDFs, bounded by count and size (WebKit won't HTTP-cache them).
const READER = "strata-reader-v1";
const READER_MAX_FILES = 24, READER_MAX_BYTES = 400 * 1024 * 1024;
const READER_INDEX = `${BASE}__reader-index__`;   // [{url, bytes, at}], oldest first
let indexing = Promise.resolve();
function remember(url, bytes) {
  const run = async () => {
    const cache = await caches.open(READER);
    let list = [];
    try { const r = await cache.match(READER_INDEX); if (r) list = await r.json(); } catch { list = []; }
    list = list.filter((e) => e.url !== url);
    list.push({ url, bytes, at: Date.now() });
    let total = list.reduce((sum, e) => sum + (e.bytes || 0), 0);
    while (list.length > READER_MAX_FILES || total > READER_MAX_BYTES) {
      const old = list.shift();
      total -= old.bytes || 0;
      await cache.delete(old.url);
    }
    await cache.put(READER_INDEX, new Response(JSON.stringify(list), { headers: { "Content-Type": "application/json" } }));
  };
  // one bookkeeper at a time, so two opens landing together do not lose each other's entry
  indexing = indexing.then(run, run).catch(() => {});
  return indexing;
}

const isApi = (u) => u.origin === self.location.origin && u.pathname.startsWith(API_PATH);
const isRaw = (u) => isApi(u) && u.pathname.endsWith("/raw");

// An image URL names its bytes' hash, so the bytes never change: cache-first, bounded by count.
const IMAGES = "strata-images-v1";
const IMAGES_MAX = 1500;
const isImage = (u) => isApi(u) && /\/api\/images\/[0-9a-f]{16}$/.test(u.pathname);
async function imageFromShelf(event, req) {
  const cache = await caches.open(IMAGES).catch(() => null);
  const hit = await cache?.match(req.url).catch(() => null);
  if (hit) return hit;
  let r;
  try { r = await fetch(req.url, { credentials: "same-origin" }); }
  catch { return new Response("", { status: 503, headers: { "X-Strata-Shelf": "1" } }); }
  if (r.ok && cache) {
    const copy = r.clone();
    event.waitUntil((async () => {
      try {
        await cache.put(req.url, copy);
        const keys = await cache.keys();
        for (const k of keys.slice(0, Math.max(0, keys.length - IMAGES_MAX))) await cache.delete(k);
      } catch { /* storage full: this view still worked */ }
    })());
  }
  return r;
}

// Mark shelf fallbacks with X-Strata-Shelf so the client treats them as a doubt about the wire.
function markedFromShelf(hit) {
  if (!hit || hit.type === "opaque" || hit.status === 0) return hit;
  const h = new Headers(hit.headers);
  h.set("X-Strata-Shelf", "1");
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: h });
}

// API reads wait out the wire's grace before a saved copy answers: the log is saved over what it reads.
const SHELL_PATIENCE_MS = 1500;
const API_PATIENCE_MS = 8000;

async function networkFirst(event, req, cacheName, offline) {
  const cache = await caches.open(cacheName).catch(() => null);
  const hit = await cache?.match(req, { ignoreVary: true }).catch(() => null)
    || (req.mode === "navigate" ? await cache?.match(BASE, { ignoreVary: true }).catch(() => null) : null);
  const url = new URL(req.url);
  if (hit && cacheName === SHELL && isImmutableAsset(url)) return hit;
  const network = (async () => { try {
    const r = await fetch(new Request(req, { cache: "no-cache" }));
    // Only refresh copies already saved by an explicit download (or an older app).
    if (cache && r.ok && (hit || cacheName === SHELL)) {
      const headers = new Headers(r.headers);
      headers.delete("Content-Encoding"); headers.delete("Content-Length");
      headers.set("X-Strata-Saved-At", String(Date.now()));
      const copy = r.clone();
      event.waitUntil((async () => {
        try { await cache.put(req, new Response(copy.body, { status: r.status, headers })); } catch { /* storage full */ }
      })());
    }
    return r;
  } catch (err) {
    if (hit) return markedFromShelf(hit);
    return offline();
  } })();
  // a saved room stays usable on a hanging connection; the refresh finishes in the worker
  if (!hit) return network;
  event.waitUntil(network.then(() => {}));
  const patience = cacheName === API && req.headers.get("X-Strata-Wire") !== "down" ? API_PATIENCE_MS : SHELL_PATIENCE_MS;
  let timer;
  try { return await Promise.race([network, new Promise(resolve => { timer = setTimeout(() => resolve(markedFromShelf(hit)), patience); })]); }
  finally { clearTimeout(timer); }
}

// Stamped bundles, hashed chunks and the hashed font files never change under their URL.
const isImmutableAsset = (u) => u.searchParams.has("v") || /\/dist\/chunks\/.+-[A-Z0-9]{8}\.js$/i.test(u.pathname) || /\/dist\/[^/]+\.woff2$/.test(u.pathname);

function savedCopy(r, body) {
  const headers = new Headers(r.headers);
  headers.delete("Content-Encoding"); headers.delete("Content-Length");
  headers.set("X-Strata-Saved-At", String(Date.now()));
  return new Response(body, { status: r.status, headers });
}
const stampOf = (html) => (/\?v=([A-Za-z0-9]+)/.exec(html) || [])[1] || null;
// One build's shell at a time: every deploy would otherwise leave another main.js behind.
async function pruneStamps(cache, keep) {
  if (!keep) return;
  for (const key of await cache.keys()) {
    const v = new URL(key.url).searchParams.get("v");
    if (v && v !== keep) await cache.delete(key);
  }
}
async function tellClients(message) {
  try { for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage(message); } catch { /* no clients API in a test */ }
}

// The saved page answers at once and the live one is fetched behind it, so a new build opens on the next load.
// A 401 on the live page means the login lapsed: drop the copy, so the reload the app asks for reaches the login page.
async function shellNavigation(event, req) {
  const cache = await caches.open(SHELL).catch(() => null);
  const hit = await cache?.match(BASE, { ignoreVary: true }).catch(() => null);
  const refresh = async () => {
    const r = await fetch(new Request(req, { cache: "no-cache" }));
    if (!cache) return r;
    if (r.ok) {
      const body = await r.clone().arrayBuffer();
      try {
        await cache.put(BASE, savedCopy(r, body));
        await pruneStamps(cache, stampOf(new TextDecoder().decode(body)));
        await dropOldPages(cache);
      } catch { /* storage full: this visit still worked */ }
    } else if (r.status === 401 || r.status === 403) {
      for (const key of await cache.keys()) if (!/\/dist\//.test(new URL(key.url).pathname)) await cache.delete(key);
    }
    return r;
  };
  if (hit) { event.waitUntil(refresh().catch(() => {})); return hit; }
  try { return await refresh(); }
  catch {
    return new Response("Offline — this room has not been downloaded on this device. Reconnect to open Strata.", { status: 503 });
  }
}

// Boot reads the app marks as snapshot-safe: the last answer at once, the live one behind it; when the live one
// differs the page is told, and re-reads over the wire.
const isSnapshotRead = (req, u) => req.headers.get("X-Strata-Snapshot") === "ok" && /\/api\/(boards|register|review)$/.test(u.pathname);
async function snapshotFirst(event, req) {
  const cache = await caches.open(SNAPSHOT).catch(() => null);
  const hit = await cache?.match(req.url).catch(() => null);
  const old = hit ? await hit.arrayBuffer() : null;
  const refresh = async () => {
    const r = await fetch(req);
    if (!cache) return r;
    if (r.ok) {
      const body = await r.clone().arrayBuffer();
      try { await cache.put(req.url, savedCopy(r, body)); } catch { /* storage full */ }
      if (old && !sameBytes(old, body)) await tellClients({ type: "strata:snapshot", path: new URL(req.url).pathname });
    } else if (r.status === 401 || r.status === 403) await cache.delete(req.url).catch(() => {});
    return r;
  };
  if (!hit) {
    try { return await refresh(); }
    catch { return new Response(JSON.stringify({ error: "offline — this board hasn't been downloaded" }), { status: 503, headers: { "Content-Type": "application/json", "X-Strata-Shelf": "1" } }); }
  }
  event.waitUntil(refresh().catch(() => {}));
  const headers = new Headers(hit.headers);
  headers.set("X-Strata-Snapshot", "1");
  return new Response(old, { status: hit.status, headers });
}
function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// Cache-first on the whole file: the Cache API refuses 206s, so ranges are cut from the full copy here.
async function bytesFromShelf(event, req) {
  const cache = await caches.open(API).catch(() => null);
  const key = new Request(req.url, { headers: { Accept: req.headers.get("Accept") || "*/*" } });
  let full = await cache?.match(key, { ignoreVary: true }).catch(() => null);
  const reader = full ? null : await caches.open(READER).catch(() => null);
  if (!full) {
    full = await reader?.match(key, { ignoreVary: true }).catch(() => null);
    if (full) event.waitUntil(remember(key.url, Number(full.headers.get("Content-Length")) || 0));
  }

  if (!full) {
    let fetched;
    try {
      fetched = await fetch(key);                       // deliberately WITHOUT the Range header
    } catch (err) {
      return new Response(JSON.stringify({ error: "offline — this source hasn't been downloaded" }),
        { status: 503, headers: { "Content-Type": "application/json", "X-Strata-Shelf": "1" } });
    }
    if (!fetched.ok) return fetched;                    // a 401/404 is the server's to answer
    full = fetched;
    const len = Number(fetched.headers.get("Content-Length")) || 0;
    const pdf = (fetched.headers.get("Content-Type") || "").includes("pdf");
    if (reader && pdf && len > 0 && len <= READER_MAX_BYTES / 4) {
      const copy = fetched.clone();
      event.waitUntil((async () => {
        try {
          const headers = new Headers(copy.headers);
          headers.delete("Content-Encoding");
          await reader.put(key, new Response(copy.body, { status: 200, headers }));
          await remember(key.url, len);
        } catch { /* storage full or refused: this open still worked, the next one downloads again */ }
      })());
    }
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("Range") || "");
  if (!range || (range[1] === "" && range[2] === "")) return full;

  const body = await full.clone().arrayBuffer();
  const total = body.byteLength;
  const start = range[1] === "" ? Math.max(0, total - Number(range[2])) : Number(range[1]);
  const end = range[1] === "" ? total - 1 : (range[2] === "" ? total - 1 : Math.min(Number(range[2]), total - 1));
  if (!(start <= end) || start >= total) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  }
  const headers = new Headers(full.headers);
  headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, statusText: "Partial Content", headers });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // writes go to the wire or fail there
  if (req.cache === "no-store") return;                   // connectivity checks must reach the server
  const u = new URL(req.url);
  // The dashboard (Focus and Dispatch) is its own page: answered with the room's shell, it opened as Strata until the second visit.
  if (req.mode === "navigate" && (u.pathname === `${BASE}dashboard` || u.pathname === `${BASE}dispatch`)) return;
  if (req.mode === "navigate") { e.respondWith(shellNavigation(e, req)); return; }
  if (isRaw(u)) { e.respondWith(bytesFromShelf(e, req)); return; }
  if (isImage(u)) { e.respondWith(imageFromShelf(e, req)); return; }
  if (isSnapshotRead(req, u)) { e.respondWith(snapshotFirst(e, req)); return; }
  if (isApi(u)) {
    e.respondWith(networkFirst(e, req, API, () =>
      new Response(JSON.stringify({ error: "offline — this board hasn't been downloaded" }),
        { status: 503, headers: { "Content-Type": "application/json", "X-Strata-Shelf": "1" } })));
    return;
  }
  e.respondWith(networkFirst(e, req, SHELL, () => new Response("Not downloaded for offline use", { status: 503 })));
});
