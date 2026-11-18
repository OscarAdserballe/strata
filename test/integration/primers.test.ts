// A source's primer: asked for in the reader or by an agent, written by the routine with set_primer, stale when its source is revised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { useServer } from "../support/server.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const server = useServer({ env: { STRATA_ROUTINE_STUB: "1" } });
const PAGE = `<!doctype html><html><head><style>body{font:14px sans-serif}</style></head><body><h1>Duration hedging, before you start</h1><p>Three threads.</p></body></html>`;
let token = "", board = "", rid = "";
let n = 0;

const rpc = async (method: string, params?: unknown) => {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
  return (await r.json()).result as { content: { text: string }[]; isError?: boolean };
};
const call = async (name: string, args: Record<string, unknown>) => { const r = await rpc("tools/call", { name, arguments: args }); return { text: r.content[0].text, isError: !!r.isError }; };
const ok = async (name: string, args: Record<string, unknown>) => { const r = await call(name, args); assert.equal(r.isError, false, `${name}: ${r.text}`); return r.text; };
const primer = async (r = rid) => (await server.api(`/api/boards/${board}/resources/${r}/primer`)).body as { status: string; hasPage: boolean; rev: number; builtAt: number | null };
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail("timed out"); };

test("a board and a source with no primer", async () => {
  token = (await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "routine", write: true }) })).body.token;
  board = await newBoard(server, { title: "Rates" });
  rid = await addMarkdown(server, board, "duration.md", MD);
  await ok("apply", { board, key: "primer-handle-1", ops: [{ op: "set_handle", handle: "rates" }] });
  assert.equal((await primer()).status, "none");
  assert.equal((await server.api(`/api/boards/${board}/resources/nope/primer`)).status, 404);
  assert.equal((await server.fetch(`/api/boards/${board}/resources/${rid}/primer/page`)).status, 404);
  assert.match(await ok("get_context", { id: `src_${rid}` }), /primer: none/);
});

test("Primer in the reader asks for one and wakes the routine; the routine finds it on the board", async () => {
  const from = server.written();
  const r = await server.api(`/api/boards/${board}/resources/${rid}/primer`, { method: "POST", headers: { "Idempotency-Key": "primer-ask-0001" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "requested");
  assert.match(server.output(from), /\[routine stub\] would fire the routine: Primer asked for: duration\.md on Rates/);
  assert.equal((await primer()).status, "requested");
  const again = await server.api(`/api/boards/${board}/resources/${rid}/primer`, { method: "POST", headers: { "Idempotency-Key": "primer-ask-0001" } });
  assert.deepEqual(again.body, r.body, "a resent ask replays its answer");
  assert.equal((await server.api(`/api/boards/${board}/resources/nope/primer`, { method: "POST" })).status, 404);

  const overview = await ok("get_context", { id: "rates" });
  assert.match(overview, new RegExp(`## Primers asked for\\n- src_${rid} "duration" · requested`));
  assert.match(await ok("get_outline", { board: "rates" }), /rates\/primers — 1 requested · 0 ready · 0 stale/);
  assert.match(await ok("get_context", { id: "rates/primers" }), new RegExp(`src_${rid} "duration" · requested`));
});

test("set_primer writes the page, served only inside the live sandbox", async () => {
  const said = await ok("apply", { board: "rates", key: "primer-write-1", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE }] });
  assert.match(said, new RegExp(`primer ready for src_${rid}`));
  const p = await primer();
  assert.equal(p.status, "ready");
  assert.ok(p.hasPage && p.builtAt && p.rev > 0, JSON.stringify(p));
  const page = await server.fetch(`/api/boards/${board}/resources/${rid}/primer/page`);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /connect-src 'none'/);
  const html = await page.text();
  assert.ok(html.startsWith(PAGE.slice(0, PAGE.indexOf("</body>"))), "the page itself");
  assert.match(html, /<\/script><\/body>/, "with the bridge before </body>");
  assert.doesNotMatch(await ok("get_context", { id: "rates" }), /Primers asked for/, "a written primer is no longer waiting");
  assert.match(await ok("get_context", { id: `src_${rid}` }), /primer: ready, written \d{4}-/);
});

test("set_primer is idempotent under its key, and refuses what isn't a source on the board", async () => {
  const first = await ok("apply", { board: "rates", key: "primer-write-1", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE }] });
  assert.match(first, /primer ready/);
  const rev = (await primer()).rev;
  await ok("apply", { board: "rates", key: "primer-write-1", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE }] });
  assert.equal((await primer()).rev, rev, "a resent key writes nothing");

  const unknown = await call("apply", { board: "rates", key: "primer-write-2", ops: [{ op: "set_primer", source: "src_nope", html: PAGE }] });
  assert.ok(unknown.isError && /src_nope is not a source on rates/.test(unknown.text), unknown.text);
  const other = await newBoard(server, { title: "Elsewhere" });
  const theirs = await addMarkdown(server, other, "other.md", MD);
  const cross = await call("apply", { board: "rates", key: "primer-write-3", ops: [{ op: "set_primer", source: `src_${theirs}`, html: PAGE }] });
  assert.ok(cross.isError, "a source on another board is refused");
  assert.equal((await server.api(`/api/boards/${other}/resources/${theirs}/primer`)).body.status, "none");
  const empty = await call("apply", { board: "rates", key: "primer-write-4", ops: [{ op: "set_primer", source: `src_${rid}`, html: " " }] });
  assert.ok(empty.isError && /html is the page/.test(empty.text));
  const big = await call("apply", { board: "rates", key: "primer-write-5", ops: [{ op: "set_primer", source: `src_${rid}`, html: "x".repeat(2 * 1024 * 1024 + 1) }] });
  assert.ok(big.isError && /at most 2 MB/.test(big.text));
});

const upload = async (name: string, body: string, key: string, extra: Record<string, unknown> = {}) => {
  const bytes = Buffer.from(body);
  const asked = await ok("request_upload", { board: "rates", key, files: [{ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }], origin: { from: "claude", ref: name }, ...extra });
  const url = new URL(/upload_url: (\S+)/.exec(asked)![1]);
  const imp = /import (imp_\S+)/.exec(asked)![1];
  assert.equal((await server.fetch(`${url.pathname}${url.search}`, { method: "PUT", body: new Uint8Array(bytes) })).status, 200);
  await until(async () => /imported/.test(await ok("get_import", { id: imp })));
  return { asked, src: /source: src_(\S+)/.exec(await ok("get_import", { id: imp }))![1] };
};

test("an agent's upload can ask for a primer, and revising the source in place makes a ready one stale", async () => {
  const { asked, src } = await upload("notes.md", "# Notes\n\nFirst version of the notes.\n", "primer-upload-1", { primer: true });
  assert.match(asked, /primer asked for/);
  assert.equal((await primer(src)).status, "requested");
  await ok("apply", { board: "rates", key: "primer-write-6", ops: [{ op: "set_primer", source: `src_${src}`, html: PAGE }] });
  assert.equal((await primer(src)).status, "ready");

  const revised = await upload("notes.md", "# Notes\n\nSecond version, with more in it.\n", "primer-upload-2");
  assert.equal(revised.src, src, "revised in place");
  const p = await primer(src);
  assert.equal(p.status, "stale");
  assert.equal(p.hasPage, true, "a stale primer still shows");
  assert.match(await ok("get_context", { id: "rates/primers" }), new RegExp(`src_${src} "notes" · stale`));

  const rebuild = await server.api(`/api/boards/${board}/resources/${src}/primer`, { method: "POST" });
  assert.equal(rebuild.body.status, "requested");
  assert.equal(rebuild.body.hasPage, true, "the old page stays up until the new one lands");
  assert.match(await ok("get_context", { id: "rates" }), new RegExp(`src_${src} "notes" · requested .*rebuild`));
});

test("a source's primer goes with it", async () => {
  assert.equal((await server.api(`/api/boards/${board}/resources/${rid}`, { method: "DELETE" })).status, 200);
  assert.equal((await server.fetch(`/api/boards/${board}/resources/${rid}/primer/page`)).status, 404);
  assert.doesNotMatch(await ok("get_context", { id: "rates/primers" }), new RegExp(`src_${rid}`));
});
