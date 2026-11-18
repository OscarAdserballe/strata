// A source's primer: asked for by the reader, a board press or an agent's upload; written by the routine through set_primer; staled by a revision.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const fired: string[] = [];
const routine = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => { fired.push(JSON.parse(raw).text); res.writeHead(200, { "Content-Type": "application/json" }).end("{}"); });
});
await new Promise<void>((resolve) => routine.listen(0, "127.0.0.1", resolve));
after(() => { routine.close(); });
const BASE = `http://127.0.0.1:${(routine.address() as AddressInfo).port}/v1/claude_code/routines/`;

const server = useServer({ env: { STRATA_ROUTINE_BASE: BASE } });
let token = "", board = "", rid = "", n = 0;
const PAGE = `<!doctype html><html><head><style>body{font:15px system-ui}</style></head><body><h1>Map</h1><p>Three strands.</p><a href="#page=2">p. 2</a></body></html>`;

const send = (path: string, method = "POST", body?: unknown, key?: string) => server.api(path, {
  method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
});
async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}
const ok = async (name: string, args: Record<string, unknown>) => { const r = await call(name, args); assert.equal(r.isError, false, `${name}: ${r.text}`); return r.text; };
function read<T>(sql: string, ...args: (string | number)[]): T | undefined {
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  try { return db.prepare(sql).get(...args) as T | undefined; } finally { db.close(); }
}
const until = async (fn: () => Promise<boolean> | boolean) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail("timed out"); };
const status = async (b: string, r: string) => (await server.api(`/api/boards/${b}/resources/${r}/primer`)).body.primer.status as string;

test("a room with a board, a source and a connected routine", async () => {
  token = (await send("/api/agent/tokens", "POST", { name: "routine", write: true })).body.token;
  board = await newBoard(server, { title: "Hedging" });
  rid = await addMarkdown(server, board, "hedging.md", MD);
  const put = await send("/api/dashboard/routine", "PUT", { url: `${BASE}trig_01ABCDEFGHJK/fire`, token: "sk-ant-oat01-secret" });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(await status(board, rid), "none");
});

test("the reader's press queues one primer, moves the board's rev, wakes the routine once, and a resend writes nothing more", async () => {
  const rev = read<{ rev: number }>("SELECT rev FROM boards WHERE id = ?", board)!.rev;
  const asked = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-press-0001");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.primer.status, "requested");
  assert.ok(read<{ rev: number }>("SELECT rev FROM boards WHERE id = ?", board)!.rev > rev, "a primer row stamps its board");
  await until(() => fired.length === 1);
  assert.match(fired[0], /^Primer: hedging\.md/);
  const again = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-press-0001");
  assert.deepEqual(again.body, asked.body, "a resent press replays its answer");
  const second = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-press-0002");
  assert.equal(second.body.primer.status, "requested", "pressing while it is being written changes nothing");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fired.length, 1, "nothing new to write, so no second wake");
  const board_ = (await server.api(`/api/boards/${board}`)).body;
  assert.doesNotMatch(JSON.stringify(board_), /primer/i, "a primer is never a source of its own");
});

test("an agent sees what waits, and set_primer checks the page before storing it", async () => {
  assert.match(await ok("whoami", {}), /1 primer waiting/);
  const waiting = await ok("get_context", { id: `${board}/primers`, filter: { state: "requested" } });
  assert.match(waiting, new RegExp(`src_${rid} "hedging" · requested`));
  assert.match(await ok("get_context", { id: `src_${rid}` }), /## Primer\nrequested: waiting to be written: write it with apply: set_primer/);
  const bad = async (html: string, why: RegExp) => {
    const r = await call("apply", { board, key: `primer-bad-${++n}xx`, ops: [{ op: "set_primer", source: `src_${rid}`, html }] });
    assert.ok(r.isError, `refused: ${html.slice(0, 40)}`);
    assert.match(r.text, why);
  };
  await bad("<p>just a fragment</p>", /one whole document/);
  await bad(`${PAGE}${PAGE}`, /single document/);
  await bad(PAGE.replace("<style>", `<script src="app.js"></script><style>`), /only from https/);
  await bad(PAGE.replace("<style>", `<link rel="stylesheet" href="http://cdn.example/x.css"><style>`), /only from https/);
  await bad(PAGE.replace("Three strands.", "x".repeat(600 * 1024)), /at most 512 KB/);
  const done = await ok("apply", { board, key: "primer-write-0001", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE.replace("<style>", `<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0"></script><style>`) }] });
  assert.match(done, /primer ready for src_/);
  assert.equal(await status(board, rid), "ready");
  assert.doesNotMatch(await ok("whoami", {}), /primer waiting/);
  const live = await server.fetch(`/api/boards/${board}/resources/${rid}/primer/live`);
  assert.equal(live.status, 200);
  assert.match(live.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
  assert.match(await live.text(), /Three strands/);
});

test("the board's press queues every source lacking one, ten at a time", async () => {
  const other = await newBoard(server, { title: "Reading list" });
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(await addMarkdown(server, other, `paper-${i}.md`, `# Paper ${i}\n\nClaim number ${i} holds.\n`));
  await ok("apply", { board: other, key: "primer-one-0001", ops: [{ op: "set_primer", source: `src_${ids[0]}`, html: PAGE }] });
  const first = await send(`/api/boards/${other}/primers`, "POST", {}, "primer-board-0001");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.queued, ids.slice(1, 11), "the ten oldest without one, skipping the one already written");
  const second = await send(`/api/boards/${other}/primers`, "POST", {}, "primer-board-0002");
  assert.deepEqual(second.body.queued, [ids[11]], "the next press takes the rest");
  const third = await send(`/api/boards/${other}/primers`, "POST", {}, "primer-board-0003");
  assert.deepEqual(third.body.queued, []);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fired.length, 1, "inside the minute, the run already going picks them up");
});

test("dispatch pages never get one", async () => {
  const dispatch = await newBoard(server, { title: "Dispatch" });
  await ok("apply", { board: dispatch, key: "primer-dispatch-handle", ops: [{ op: "set_handle", handle: "dispatch" }] });
  const page = await addMarkdown(server, dispatch, "v1.md", "# Proposal\n\nTwo options.\n");
  const press = await send(`/api/boards/${dispatch}/resources/${page}/primer`, "POST", {}, "primer-dispatch-0001");
  assert.equal(press.status, 400);
  assert.match(press.body.error, /Dispatch pages/);
  assert.equal((await send(`/api/boards/${dispatch}/primers`, "POST", {}, "primer-dispatch-0002")).status, 400);
  const op = await call("apply", { board: "dispatch", key: "primer-dispatch-0003", ops: [{ op: "set_primer", source: `src_${page}`, html: PAGE }] });
  assert.ok(op.isError && /Dispatch pages/.test(op.text));
  const up = await call("request_upload", { board: "dispatch", key: "primer-dispatch-0004", primer: true, files: [{ name: "v2.md", bytes: 3, sha256: "0".repeat(64) }] });
  assert.ok(up.isError && /Dispatch pages/.test(up.text));
});

test("an upload with primer: true asks once it lands; a revision in place stales it until the next press", async () => {
  const page = (body: string) => Buffer.from(`<!doctype html><html><head><script>window.v = 1</script></head><body>${body}</body></html>`);
  const upload = async (bytes: Buffer, key: string, primer?: boolean) => {
    const file = { name: "retrieval.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const asked = await ok("request_upload", { board, key, files: [file], origin: { from: "claude", ref: "retrieval" }, ...(primer ? { primer } : {}) });
    const link = /upload_url: (\S+)/.exec(asked);
    if (!link) return { asked, src: "" };
    const url = new URL(link[1]);
    assert.equal((await server.fetch(`${url.pathname}${url.search}`, { method: "PUT", body: new Uint8Array(bytes) })).status, 200);
    const imp = /import (imp_\S+)/.exec(asked)![1];
    await until(async () => /imported/.test(await ok("get_import", { id: imp })));
    return { asked, src: /source: src_(\S+)/.exec(await ok("get_import", { id: imp }))![1] };
  };
  const first = await upload(page("<h1>Retrieval</h1><p>Dense retrieval misses rare names.</p>"), "primer-upload-0001", true);
  assert.match(first.asked, /primer: asked for once it lands/);
  assert.equal(await status(board, first.src), "requested");
  await ok("apply", { board, key: "primer-upload-0002", ops: [{ op: "set_primer", source: `src_${first.src}`, html: PAGE }] });
  assert.equal(await status(board, first.src), "ready");

  const revised = await upload(page("<h1>Retrieval</h1><p>Dense retrieval misses rare names; BM25 catches them.</p>"), "primer-upload-0003");
  assert.equal(revised.src, first.src, "revised in place");
  assert.equal(await status(board, first.src), "stale", "the page no longer describes the source");
  assert.match(await ok("get_context", { id: `${board}/primers`, filter: { state: "stale" } }), /stale: the source changed/);
  assert.equal((await server.fetch(`/api/boards/${board}/resources/${first.src}/primer/live`)).status, 200, "the old page still shows, marked stale");
  const again = await send(`/api/boards/${board}/resources/${first.src}/primer`, "POST", {}, "primer-upload-0004");
  assert.equal(again.body.primer.status, "requested", "the next press asks for a new one");
});

test("deleting a source takes its primer with it", async () => {
  assert.ok(read("SELECT 1 FROM primers WHERE resource_id = ?", rid));
  assert.equal((await send(`/api/boards/${board}/resources/${rid}?pairs=1`, "DELETE")).status, 200);
  assert.equal(read("SELECT 1 FROM primers WHERE resource_id = ?", rid), undefined);
});
