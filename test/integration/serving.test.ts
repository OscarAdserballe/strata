import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("health reports the models actually in use — chat (with its thinking budget) and distil", async () => {
  const { status, body } = await api("/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(String(body.chat), /^(gpt|gemini)-/);
  assert.match(String(body.distil), /^gemini-/);
  assert.ok(body.chatThinking !== undefined);
});

test("the page goes out stamped: every ?v= is the build, and the page knows its own", async () => {
  const r = await fetch(server.base + "/");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  const html = await r.text();
  assert.doesNotMatch(html, /\?v=dev/, "no dev token survives the rewrite");
  const stamps = new Set(Array.from(html.matchAll(/\?v=([a-z0-9]+)/g), (m) => m[1]));
  assert.equal(stamps.size, 1, "one stamp for every script");
  const own = html.match(/STRATA_BUILD = "([a-z0-9]+)"/);
  assert.ok(own, "the page carries its own build");
  assert.equal(own![1], [...stamps][0]);
  // HTML carries a per-response CSP nonce, so it must not 304 against a cached nonce.
  assert.equal(r.headers.get("etag"), null);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /img-src[^;]*https:/, "imported article images are allowed to load");
  assert.match(csp, /media-src[^;]*https:/, "imported article media is allowed to load");
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce && html.includes(`script nonce="${nonce}"`));
  const again = await fetch(server.base + "/", { headers: { "If-None-Match": 'W/"old-page"' } });
  assert.equal(again.status, 200);
});

test("static files revalidate instead of going heuristically stale", async () => {
  const r = await fetch(server.base + "/dist/main.js");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  const etag = r.headers.get("etag")!;
  assert.ok(etag, "an etag to revalidate with");
  const again = await fetch(server.base + "/dist/main.js", { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
});

test("API responses echo the build, and it matches the page's", async () => {
  await api("/api/health");
  const r = await fetch(server.base + "/api/health");
  const build = r.headers.get("x-strata-build");
  assert.ok(build, "the stamp rides API responses");
  const html = await (await fetch(server.base + "/")).text();
  assert.equal(html.match(/STRATA_BUILD = "([a-z0-9]+)"/)![1], build);
});

test("the current build's stamped assets and the hashed fonts are immutable; anything else revalidates", async () => {
  const html = await (await fetch(server.base + "/")).text();
  const stamp = html.match(/\?v=([a-z0-9]+)/)![1];
  const stamped = await fetch(`${server.base}/dist/main.js?v=${stamp}`);
  assert.equal(stamped.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const css = await fetch(`${server.base}/dist/main.css?v=${stamp}`);
  assert.equal(css.headers.get("cache-control"), "public, max-age=31536000, immutable");
  // a stale stamp could name other bytes after a deploy, so it is not promised forever
  assert.equal((await fetch(`${server.base}/dist/main.js?v=0ld5tamp00`)).headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(`${server.base}/dist/main.js`)).headers.get("cache-control"), "no-cache");
  const font = html.match(/href="(dist\/[^"]+\.woff2)"/)?.[1];
  assert.ok(font, "the page preloads a font file");
  assert.equal((await fetch(`${server.base}/${font}`)).headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("the page preloads esbuild's runtime chunk and the faces the app warms, so neither waits behind main.js", async () => {
  const html = await (await fetch(server.base + "/")).text();
  assert.doesNotMatch(html, /STRATA_PRELOAD/, "the placeholder is replaced");
  const modules = Array.from(html.matchAll(/<link rel="modulepreload" href="(dist\/chunks\/[^"]+\.js)"/g), (m) => m[1]);
  assert.ok(modules.length >= 1, "the chunk main.js imports statically is preloaded");
  for (const m of modules) assert.equal((await fetch(`${server.base}/${m}`)).status, 200);
  const fonts = Array.from(html.matchAll(/<link rel="preload" as="font" type="font\/woff2" crossorigin href="(dist\/[^"]+\.woff2)"/g), (m) => m[1]);
  assert.equal(fonts.length, 3, "Spectral 600 and 700 and IBM Plex Sans 600, the faces main.tsx warms");
  for (const f of fonts) assert.equal((await fetch(`${server.base}/${f}`)).status, 200);
});
