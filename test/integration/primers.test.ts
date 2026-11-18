// A source's primer: asked for in the reader or by an agent's upload, written back by the routine with set_primer, stale once its source is revised.
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
  req.on("end", () => {
    fired.push(JSON.parse(raw).text);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ claude_code_session_url: "https://claude.ai/code/session_01PRIMER" }));
  });
});
await new Promise<void>((resolve) => routine.listen(0, "127.0.0.1", resolve));
after(() => { routine.close(); });
const BASE = `http://127.0.0.1:${(routine.address() as AddressInfo).port}/v1/claude_code/routines/`;

const server = useServer({ env: { STRATA_ROUTINE_BASE: BASE } });
const send = (path: string, method: string, body: unknown, key: string) => server.api(path, {
  method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", "Idempotency-Key": key },
});
const sql = <T,>(query: string, ...args: (string | number)[]): T[] => {
  const db = new DatabaseSync(server.db, { timeout: 5000 });
  try { return db.prepare(query).all(...args) as T[]; } finally { db.close(); }
};
// the minute between runs passes here instead of in the test
const age = () => { const db = new DatabaseSync(server.db, { timeout: 5000 }); try { db.prepare("UPDATE dashboard_routine SET ran_at = ran_at - 61000").run(); } finally { db.close(); } };

let token = "", n = 0, board = "", rid = "";
async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  assert.ok(body.result, `${name} answered ${JSON.stringify(body)}`);
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}
const ok = async (name: string, args: Record<string, unknown>) => { const r = await call(name, args); assert.equal(r.isError, false, `${name}: ${r.text}`); return r.text; };
const until = async (fn: () => Promise<boolean> | boolean) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail("timed out"); };
const PAGE = "<!doctype html><html><body><h1>Before you read</h1><p>Two strands: the hedge, and where it fails.</p><a href=\"#page=1\">p. 1</a></body></html>";

test("a room with a routine, a board and a source", async () => {
  token = (await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "routine", write: true }) })).body.token;
  board = await newBoard(server, { title: "Fixed income" });
  rid = await addMarkdown(server, board, "duration-hedging.md", MD);
  await ok("apply", { board, key: "primer-handle-1", ops: [{ op: "set_handle", handle: "bonds" }] });
  const put = await send("/api/dashboard/routine", "PUT", { url: `${BASE}trig_01ABCDEFGHJK/fire`, token: "sk-ant-oat01-secret" }, "primer-routine-1");
  assert.equal(put.status, 200, JSON.stringify(put.body));
});

test("a source has no primer until one is asked for, and the live page is a 404 until it is written", async () => {
  assert.deepEqual((await server.api(`/api/boards/${board}/resources/${rid}/primer`)).body, { status: "none", requestedAt: null, builtAt: null });
  assert.equal((await server.api(`/api/boards/${board}/resources/nope/primer`)).status, 404);
  assert.equal((await server.fetch(`/api/boards/${board}/resources/${rid}/primer/live`)).status, 404);
});

test("asking wakes the routine once, naming the source; a resent ask replays and a second press while it is asked for changes nothing", async () => {
  const asked = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-ask-0001");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.status, "requested");
  assert.deepEqual(fired, [`Primer: duration-hedging (src_${rid}) on bonds`]);
  const resent = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-ask-0001");
  assert.deepEqual(resent.body, asked.body, "a lost answer resent under its key replays");
  age();
  const again = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-ask-0002");
  assert.deepEqual(again.body, asked.body, "requested_at doesn't move");
  assert.equal(fired.length, 1, "a press while one is asked for wakes nothing");
  assert.equal(sql<{ n: number }>("SELECT COUNT(*) n FROM events WHERE event = 'primer_request'")[0].n, 1);
});

test("an agent sees what is wanted: whoami, the board, the source and <board>/primers", async () => {
  assert.match(await ok("whoami", {}), /bonds \(.*1 primer wanted \(bonds\/primers\)/);
  assert.match(await ok("get_context", { id: "bonds" }), new RegExp(`## Primers to write\\n- src_${rid} "duration-hedging" · requested`));
  assert.match(await ok("get_context", { id: `src_${rid}` }), /## Primer\nrequested/);
  const list = await ok("get_context", { id: "bonds/primers", filter: { state: "wanted" } });
  assert.match(list, new RegExp(`src_${rid} "duration-hedging" · requested`));
  assert.match(await ok("get_outline", { board: "bonds" }), /bonds\/primers — 1 requested · 0 stale · 0 ready/);
  assert.match((await call("get_context", { id: "bonds/primers", filter: { state: "open" } })).text, /state is one of wanted/);
  assert.match(await ok("get_guide", { topic: "primer" }), /set_primer/);
  assert.match(await ok("get_guide", { topic: "routine" }), /Primers\./);
});

test("set_primer checks its source and its size, then serves the page sandboxed, as a live source is", async () => {
  const other = await newBoard(server, { title: "Elsewhere" });
  assert.match((await call("apply", { board: other, key: "primer-wrong-1", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE }] })).text, /is not a source on/);
  assert.match((await call("apply", { board: "bonds", key: "primer-empty-1", ops: [{ op: "set_primer", source: `src_${rid}`, html: "just words" }] })).text, /whole HTML page/);
  const big = `<html><body>${"x".repeat(600 * 1024)}</body></html>`;
  assert.match((await call("apply", { board: "bonds", key: "primer-big-01", ops: [{ op: "set_primer", source: `src_${rid}`, html: big }] })).text, /at most 512 KB/);
  assert.equal(sql("SELECT 1 FROM primers WHERE status = 'ready'").length, 0, "nothing was written");

  assert.match(await ok("apply", { board: "bonds", key: "primer-set-01", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE }] }), /primer for src_\S+ is ready/);
  const view = (await server.api(`/api/boards/${board}/resources/${rid}/primer`)).body;
  assert.equal(view.status, "ready");
  assert.ok(view.builtAt);
  const live = await server.fetch(`/api/boards/${board}/resources/${rid}/primer/live`);
  assert.equal(live.status, 200);
  assert.match(live.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts.*connect-src 'none'/);
  assert.equal(live.headers.get("x-frame-options"), null);
  const html = await live.text();
  assert.match(html, /Two strands/);
  assert.match(html, /<script>[\s\S]*<\/script><\/body>/, "the bridge is in");
  assert.equal((await server.fetch(`/api/boards/${other}/resources/${rid}/primer/live`)).status, 404, "only from its own board");
  assert.match(await ok("get_context", { id: "bonds/primers", filter: { source: `src_${rid}` } }), /```html\n<!doctype html>/);
});

test("asking again over a ready primer asks for a new one; removing the source takes its primer", async () => {
  age();
  const asked = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-ask-0003");
  assert.equal(asked.body.status, "requested");
  assert.equal(fired.length, 2);
  const gone = await send(`/api/boards/${board}/resources/${rid}`, "DELETE", undefined, "primer-del-0001");
  assert.equal(gone.status, 200);
  assert.equal(sql("SELECT 1 FROM primers WHERE resource_id = ?", rid).length, 0);
});

test("an agent's upload can ask for a primer; revising the page in place makes a written one stale", async () => {
  age();
  const page = (body: string) => Buffer.from(`<!doctype html><html><head><script>window.v = 1</script></head><body>${body}</body></html>`);
  const upload = async (bytes: Buffer, key: string, primer: boolean) => {
    const file = { name: "yield-curve.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const asked = await ok("request_upload", { board: "bonds", key, files: [file], origin: { from: "claude", ref: "yield-curve" }, primer });
    const url = new URL(/upload_url: (\S+)/.exec(asked)![1]);
    assert.equal((await server.fetch(`${url.pathname}${url.search}`, { method: "PUT", body: new Uint8Array(bytes) })).status, 200);
    const imp = /import (imp_\S+)/.exec(asked)![1];
    await until(async () => /imported/.test(await ok("get_import", { id: imp })));
    return { asked, src: /source: src_(\S+)/.exec(await ok("get_import", { id: imp }))![1] };
  };
  const first = await upload(page("<h1>Yield curve</h1><p>Level, slope, curvature.</p>"), "primer-up-0001", true);
  assert.match(first.asked, /primer: asked for once it lands/);
  assert.equal(sql<{ status: string }>("SELECT status FROM primers WHERE resource_id = ?", first.src)[0]?.status, "requested");
  await until(() => fired.length === 3);
  assert.equal(fired[2], `Primer: yield-curve (src_${first.src}) on bonds`);

  await ok("apply", { board: "bonds", key: "primer-set-02", ops: [{ op: "set_primer", source: `src_${first.src}`, html: PAGE }] });
  const second = await upload(page("<h1>Yield curve</h1><p>Level, slope, curvature, and the butterfly.</p>"), "primer-up-0002", false);
  assert.equal(second.src, first.src, "revised in place");
  assert.equal(sql<{ status: string }>("SELECT status FROM primers WHERE resource_id = ?", first.src)[0]?.status, "stale");
  assert.equal(fired.length, 3, "a revision wakes nothing");
  assert.match(await ok("get_context", { id: "bonds/primers", filter: { state: "stale" } }), /stale: the source was revised after it was written/);
  assert.equal((await server.fetch(`/api/boards/${board}/resources/${first.src}/primer/live`)).status, 200, "a stale primer is still read");
});

test("Dispatch pages never get a primer", async () => {
  const thread = await send("/api/dashboard/tasks", "POST", { id: "t_primer01", title: "No primer here", area: "work" }, "primer-task-0001");
  assert.equal(thread.status, 201);
  age();
  await send("/api/dashboard/tasks/t_primer01/send", "POST", {}, "primer-task-0002");
  await ok("dashboard_post", { key: "primer-post-0001", id: "t_primer01", page: PAGE });
  const [v] = sql<{ resource_id: string; board_id: string }>("SELECT v.resource_id, r.board_id FROM dashboard_versions v JOIN resources r ON r.id = v.resource_id WHERE v.task_id = 't_primer01'");
  assert.equal(sql("SELECT 1 FROM primers WHERE resource_id = ?", v.resource_id).length, 0);
  const asked = await send(`/api/boards/${v.board_id}/resources/${v.resource_id}/primer`, "POST", {}, "primer-ask-0004");
  assert.equal(asked.status, 400);
  assert.match((await call("apply", { board: "dispatch", key: "primer-disp-01", ops: [{ op: "set_primer", source: `src_${v.resource_id}`, html: PAGE }] })).text, /without a primer/);
});
