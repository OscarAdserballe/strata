// Primers: the reader asks, the routine is woken, an agent's set_primer lands the page, and a revision marks it stale.
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
const sql = <T,>(q: string, ...args: (string | number)[]): T[] => { const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 }); try { return db.prepare(q).all(...args) as T[]; } finally { db.close(); } };
const age = () => { const db = new DatabaseSync(server.db, { timeout: 5000 }); try { db.prepare("UPDATE dashboard_routine SET ran_at = ran_at - 61000").run(); } finally { db.close(); } };

let n = 0, token = "";
async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}
const ok = async (name: string, args: Record<string, unknown>) => { const r = await call(name, args); assert.equal(r.isError, false, `${name}: ${r.text}`); return r.text; };
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail("timed out"); };
const PAGE = (body: string) => `<!doctype html><html><head><style>body{font:14px system-ui}</style></head><body>${body}</body></html>`;
const primerOf = async (board: string, rid: string) => ((await server.api(`/api/boards/${board}`)).body.resources as { id: string; primer?: { status: string; builtAt: number | null } }[]).find((r) => r.id === rid)?.primer;

let board = "", rid = "";

test("a press asks for a primer and wakes the routine once; a resent press replays, a second press changes nothing", async () => {
  token = ((await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "primer writer", write: true }) })).body as { token: string }).token;
  board = await newBoard(server, { title: "Primer board" });
  rid = await addMarkdown(server, board, "hedging.md", MD);
  assert.equal(await primerOf(board, rid), undefined, "a source has no primer until one is asked for");
  const unwired = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-press-0000");
  assert.equal(unwired.status, 200, JSON.stringify(unwired.body));
  assert.equal(unwired.body.woke, false, "with no routine connected the request still lands, for the agent to list");
  assert.equal(fired.length, 0);
  assert.equal((await send("/api/dashboard/routine", "PUT", { url: `${BASE}trig_01PRIMERPRIMER/fire`, token: "sk-ant-oat01-x" }, "primer-routine-01")).status, 200);
  // the first request is answered: clear it so this press asks afresh
  { const db = new DatabaseSync(server.db, { timeout: 5000 }); try { db.prepare("DELETE FROM primers").run(); } finally { db.close(); } }

  const press = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-press-0001");
  assert.equal(press.status, 200, JSON.stringify(press.body));
  assert.equal(press.body.asked, true);
  assert.equal(press.body.woke, true);
  assert.deepEqual(fired, ["Primer: hedging on Primer board"]);
  assert.equal(press.body.state.resources.find((r: { id: string }) => r.id === rid).primer.status, "requested", "the answer carries the board with the request on it");
  const again = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-press-0001");
  assert.equal(again.body.asked, true, "a resent press replays its answer");
  assert.equal(fired.length, 1, "a replay wakes nothing");
  const second = await send(`/api/boards/${board}/resources/${rid}/primer`, "POST", {}, "primer-press-0002");
  assert.equal(second.body.asked, false, "already asked for");
  assert.equal(fired.length, 1, "inside the minute the run already going picks it up");
  assert.equal(sql<{ n: number }>("SELECT COUNT(*) n FROM primers WHERE resource_id = ?", rid)[0].n, 1);
  assert.equal((await send(`/api/boards/${board}/resources/nope/primer`, "POST", {}, "primer-press-0003")).status, 404);
});

test("the agent sees what is asked for, and set_primer lands a complete page that the sandboxed route serves", async () => {
  const who = await ok("whoami", {});
  assert.match(who, new RegExp(`1 primer asked for \\(${board}/primers\\)`));
  const listed = await ok("get_context", { id: `${board}/primers` });
  assert.match(listed, new RegExp(`src_${rid} "hedging" · asked for`));
  assert.match(listed, /set_primer/);
  assert.match(await ok("get_context", { id: `src_${rid}` }), /primer: asked for · write it with apply: set_primer/);
  assert.match(await ok("get_outline", { board }), /\/primers — 1 asked for · 0 ready · 0 stale/);

  const bad = await call("apply", { board, key: "primer-set-bad1", ops: [{ op: "set_primer", source: `src_${rid}`, html: "<p>just a fragment</p>" }] });
  assert.ok(bad.isError && /complete document/.test(bad.text), bad.text);
  const huge = await call("apply", { board, key: "primer-set-bad2", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE("x".repeat(500_001)) }] });
  assert.ok(huge.isError && /at most 500000/.test(huge.text), huge.text);
  const other = await call("apply", { board, key: "primer-set-bad3", ops: [{ op: "set_primer", source: "src_elsewhere", html: PAGE("<h1>No</h1>") }] });
  assert.ok(other.isError && /not a source on/.test(other.text), other.text);
  assert.equal(sql<{ status: string }>("SELECT status FROM primers WHERE resource_id = ?", rid)[0].status, "requested", "a refused op wrote nothing");

  const set = await ok("apply", { board, key: "primer-set-0001", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE('<h1>Shape of the hedge</h1><a data-page="2">p. 2</a></body>') }] });
  assert.match(set, new RegExp(`primer set for src_${rid}`));
  const p = await primerOf(board, rid);
  assert.equal(p?.status, "ready");
  assert.ok(p?.builtAt);
  const page = await server.fetch(`/api/boards/${board}/resources/${rid}/primer`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts/, "the same sandbox as a live source");
  assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
  const html = await page.text();
  assert.match(html, /Shape of the hedge/);
  assert.match(html, /strataPrimer/, "the panel's link script rides along, before the last </body>");
  assert.ok(html.indexOf("strataPrimer") < html.lastIndexOf("</body>"));
  assert.match(await ok("get_context", { id: `${board}/primers` }), /· ready · written/);
  assert.doesNotMatch(await ok("whoami", {}), /primer asked for/);
  assert.equal((await server.fetch(`/api/boards/${board}/resources/nope/primer`)).status, 404);
});

test("the board's snapshot never reads a primer's page", async () => {
  const rows = sql<{ detail: string }>("EXPLAIN QUERY PLAN SELECT resource_id,board_id,status,bytes,requested_at,built_at FROM primers WHERE board_id = ?", board);
  assert.ok(rows.some((r) => /USING INDEX idx_primers_board/.test(r.detail)), rows.map((r) => r.detail).join("\n"));
  const state = JSON.stringify((await server.api(`/api/boards/${board}`)).body);
  assert.doesNotMatch(state, /Shape of the hedge/, "the html stays out of the board state");
});

test("Primers for this board asks for at most ten sources without one, then the rest on the next press", async () => {
  const many = await newBoard(server, { title: "Twelve sources" });
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(await addMarkdown(server, many, `part-${i}.md`, `# Part ${i}\n\nThe ${i}th part of a long argument about hedging.\n`));
  { const db = new DatabaseSync(server.db, { timeout: 5000 }); try { db.prepare("INSERT INTO primers (resource_id,board_id,status,html,bytes,built_at) VALUES (?,?,'ready','<!doctype html><html><body></body></html>',40,1)").run(ids[0], many); } finally { db.close(); } }
  age();
  const first = await send(`/api/boards/${many}/primers`, "POST", {}, "primer-board-0001");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual([first.body.asked, first.body.left], [10, 1]);
  assert.equal(fired.at(-1), "Primers for this board: Twelve sources");
  const requested = sql<{ resource_id: string }>("SELECT resource_id FROM primers WHERE board_id = ? AND status = 'requested'", many).map((r) => r.resource_id);
  assert.equal(requested.length, 10);
  assert.ok(!requested.includes(ids[0]), "a source that has a primer is not asked again");
  const next = await send(`/api/boards/${many}/primers`, "POST", {}, "primer-board-0002");
  assert.deepEqual([next.body.asked, next.body.left], [1, 0]);
  const none = await send(`/api/boards/${many}/primers`, "POST", {}, "primer-board-0003");
  assert.deepEqual([none.body.asked, none.body.woke], [0, false], "nothing left: nothing asked, nothing woken");
});

test("an agent's upload asks for a primer only with primer: true, and revising it in place marks the primer stale", async () => {
  await ok("apply", { board, key: "primer-handle-01", ops: [{ op: "set_handle", handle: "primed" }] });
  const upload = async (body: string, key: string, primer?: boolean) => {
    const bytes = Buffer.from(PAGE(body));
    const asked = await ok("request_upload", { board: "primed", key, ...(primer === undefined ? {} : { primer }), origin: { from: "claude", ref: "hedge-map" },
      files: [{ name: "hedge-map.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] });
    const url = new URL(/upload_url: (\S+)/.exec(asked)![1]);
    assert.equal((await server.fetch(`${url.pathname}${url.search}`, { method: "PUT", body: new Uint8Array(bytes) })).status, 200);
    const imp = /import (imp_\S+)/.exec(asked)![1];
    await until(async () => /imported/.test(await ok("get_import", { id: imp })));
    return { asked, src: /source: (src_\S+)/.exec(await ok("get_import", { id: imp }))![1].replace(/^src_/, "") };
  };
  const plain = await upload("<h1>Hedge map</h1><p>DV01 first.</p>", "primer-up-0001");
  assert.doesNotMatch(plain.asked, /primer/);
  assert.equal(await primerOf(board, plain.src), undefined, "an agent's upload gets no primer by default");

  await ok("apply", { board, key: "primer-set-0002", ops: [{ op: "set_primer", source: `src_${plain.src}`, html: PAGE("<h1>Primer v1</h1>") }] });
  assert.equal((await primerOf(board, plain.src))?.status, "ready");
  await upload("<h1>Hedge map</h1><p>DV01 first, then convexity.</p>", "primer-up-0002");
  assert.equal((await primerOf(board, plain.src))?.status, "stale", "the source changed under its primer");
  assert.match(await (await server.fetch(`/api/boards/${board}/resources/${plain.src}/primer`)).text(), /Primer v1/, "a stale primer still shows");
  assert.match(await ok("get_context", { id: `${board}/primers` }), /stale \(the source was revised since\)/);

  age();
  const before = fired.length;
  const asked = await upload("<h1>Hedge map</h1><p>DV01, convexity, then key rates.</p>", "primer-up-0003", true);
  assert.match(asked.asked, /primer: asked for once it lands/);
  assert.equal((await primerOf(board, plain.src))?.status, "requested", "asked again with the revision: rebuilt on request");
  await until(async () => fired.length > before);
  assert.equal(fired.at(-1), "Primer: hedge-map on Primer board");
});

test("deleting a source takes its primer with it", async () => {
  assert.equal(sql<{ n: number }>("SELECT COUNT(*) n FROM primers WHERE resource_id = ?", rid)[0].n, 1);
  const del = await send(`/api/boards/${board}/resources/${rid}?pairs=1`, "DELETE", undefined, "primer-delete-01");
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(sql<{ n: number }>("SELECT COUNT(*) n FROM primers WHERE resource_id = ?", rid)[0].n, 0);
});
