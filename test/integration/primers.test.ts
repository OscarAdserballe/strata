// Primers: the page Claude writes about a source before it is read, asked for in the reader and written with set_primer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { useServer } from "../support/server.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const server = useServer({ env: { STRATA_ROUTINE_STUB: "1" } });
let token = "", board = "", rid = "", n = 0, k = 0;

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return { text: res.content[0].text as string, isError: !!res.isError };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await call(name, args); assert.equal(r.isError, false, `${name}: ${r.text}`); return r.text; };
const setPrimer = (source: string, html: unknown) => call("apply", { board: "primed", key: `primer-${++k}-${Date.now()}`, ops: [{ op: "set_primer", source, html }] });
const said = async (r = rid) => /^primer: (.*)$/m.exec(await ok("get_context", { id: `src_${r}` }))![1];
const PAGE = "<!doctype html><html><body><h1>Before page 1</h1><p>Follow the hedge, then where it fails.</p></body></html>";

test("set_primer checks its source and its page, and writes nothing it refuses", async () => {
  token = (await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "primers", write: true }) })).body.token;
  board = await newBoard(server, { title: "Primed" });
  rid = await addMarkdown(server, board, "duration-hedging.md", MD);
  await ok("apply", { board, key: "primer-handle-1", ops: [{ op: "set_handle", handle: "primed" }] });
  const other = await newBoard(server, { title: "Elsewhere" });
  const theirs = await addMarkdown(server, other, "elsewhere.md", MD);
  for (const [source, html, why] of [
    [`src_${theirs}`, PAGE, /is not a source on primed/],
    ["src_nope", PAGE, /is not a source on primed/],
    [`src_${rid}`, "   ", /html is the whole page/],
    [`src_${rid}`, "just some words, no markup", /is an HTML page/],
    [`src_${rid}`, `<html><body>${"x".repeat(400 * 1024)}</body></html>`, /at most 400 KB/],
  ] as const) {
    const r = await setPrimer(source, html);
    assert.ok(r.isError && why.test(r.text), r.text);
  }
  assert.equal(await said(), "none", "a refused primer writes nothing");
});

test("set_primer makes the primer ready, and the agent sees it on the board, its collection and the source", async () => {
  assert.match(await ok("get_context", { id: "primed/primers" }), /No primers yet/);
  assert.match((await setPrimer(`src_${rid}`, PAGE)).text, new RegExp(`primer ready on src_${rid}`));
  assert.match(await said(), /^ready · written \d{4}-/);
  assert.match(await ok("get_context", { id: "primed/primers" }), new RegExp(`- \\[ready\\] src_${rid} "duration-hedging" · written`));
  assert.match(await ok("get_outline", { board: "primed" }), /primed\/primers — 0 asked · 1 ready · 0 out of date/);
  const outline = await ok("get_outline", { board: "primed" });
  assert.equal(outline.match(/duration-hedging/g)?.length, 1, "a primer is never a source of its own");
});

test("replacing a text source in place marks its primer out of date", async () => {
  const page = (body: string) => Buffer.from(`<!doctype html><html><head><script>window.v = 1</script></head><body>${body}</body></html>`);
  const send = async (bytes: Buffer, key: string) => {
    const file = { name: "retrieval-map.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const asked = await ok("request_upload", { board: "primed", key, files: [file], origin: { from: "claude", ref: "primer-retrieval-map" } });
    const url = new URL(/upload_url: (\S+)/.exec(asked)![1]);
    assert.equal((await server.fetch(`${url.pathname}${url.search}`, { method: "PUT", body: new Uint8Array(bytes) })).status, 200);
    const imp = /import (imp_\S+)/.exec(asked)![1];
    for (let i = 0; i < 200 && !/imported/.test(await ok("get_import", { id: imp })); i++) await new Promise((r) => setTimeout(r, 50));
    return /source: src_(\S+)/.exec(await ok("get_import", { id: imp }))![1];
  };
  const live = await send(page("<h1>Retrieval map</h1><p>Dense retrieval misses rare names.</p>"), "primer-revise-1");
  await setPrimer(`src_${live}`, PAGE);
  assert.match(await said(live), /^ready/);
  assert.equal(await send(page("<h1>Retrieval map</h1><p>Dense retrieval misses rare names; BM25 catches them.</p>"), "primer-revise-2"), live);
  assert.match(await said(live), /^out of date/);
  assert.match(await said(), /^ready/, "only the replaced source's primer goes out of date");
  assert.match(await ok("get_context", { id: "primed/primers" }), new RegExp(`- \\[stale\\] src_${live}`));
  await setPrimer(`src_${live}`, PAGE);
  assert.match(await said(live), /^ready/, "a new primer is ready again");
});
