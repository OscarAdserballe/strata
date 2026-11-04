// A live page keeps one JSON value through window.strata: stored per source, replaced whole, guarded by If-Match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

const PAGE = `<!doctype html><html><body><h1>Decisions</h1><input type="checkbox" id="w1"><script>window.x = 1</script></body></html>`;

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);
const put = (path: string, value: unknown, rev?: number) => api(path, {
  method: "PUT", body: JSON.stringify({ value }), headers: { "Content-Type": "application/json", ...(rev === undefined ? {} : { "If-Match": `"${rev}"` }) },
});
const upload = async (board: string, filename: string, html: string) => {
  const { status, body } = await api(`/api/boards/${board}/resources`, { method: "POST", body: JSON.stringify({ filename, base64: Buffer.from(html).toString("base64") }) });
  assert.equal(status, 201, JSON.stringify(body));
  return body.id as string;
};

test("a live page's state starts empty, saves over its rev, and a stale rev is refused with the current value", async () => {
  const id = await newBoard(server, { title: "Page state" });
  try {
    const rid = await upload(id, "decisions.html", PAGE);
    const at = `/api/boards/${id}/resources/${rid}/state`;
    assert.deepEqual((await api(at)).body, { value: null, rev: 0 });

    const first = await put(at, JSON.stringify({ w1: "go" }), 0);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.rev > 0);
    assert.deepEqual((await api(at)).body, { value: '{"w1":"go"}', rev: first.body.rev });

    const stale = await put(at, JSON.stringify({ w1: "drop" }), 0);
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body.conflict, { rev: first.body.rev, value: { value: '{"w1":"go"}' } });
    assert.equal((await api(at)).body.value, '{"w1":"go"}', "nothing written on a conflict");

    const second = await put(at, JSON.stringify({ w1: "drop" }), first.body.rev);
    assert.equal(second.status, 200);
    assert.ok(second.body.rev > first.body.rev);
  } finally { await api(`/api/boards/${id}`, { method: "DELETE" }); }
});

test("state must be JSON text of at most 64 KB, and only a live page has any", async () => {
  const id = await newBoard(server, { title: "Page state limits" });
  try {
    const rid = await upload(id, "decisions.html", PAGE);
    const at = `/api/boards/${id}/resources/${rid}/state`;
    assert.equal((await put(at, "{not json")).status, 400);
    assert.equal((await put(at, { w1: "go" })).status, 400, "the value is the page's JSON text, not an object");
    assert.equal((await put(at, JSON.stringify("x".repeat(64 * 1024)))).status, 400);
    assert.equal((await put(at, JSON.stringify("x".repeat(64 * 1024 - 2)))).status, 200, "exactly 64 KB fits");

    const plain = await upload(id, "essay.html", "<html><body><p>Just words.</p></body></html>");
    assert.equal((await api(`/api/boards/${id}/resources/${plain}/state`)).status, 404);
    assert.equal((await put(`/api/boards/${id}/resources/${plain}/state`, "{}")).status, 404);
    assert.equal((await api(`/api/boards/${id}/resources/res-nope/state`)).status, 404);
  } finally { await api(`/api/boards/${id}`, { method: "DELETE" }); }
});

test("an agent reads what the page saved, and the state goes with its source", async () => {
  const id = await newBoard(server, { title: "Page state for agents" });
  const { token } = (await api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "reader", write: false }) })).body as { token: string };
  try {
    const rid = await upload(id, "decisions.html", PAGE);
    const at = `/api/boards/${id}/resources/${rid}/state`;
    await put(at, JSON.stringify({ decisions: { w1: "go", o2: "drop" } }));
    const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_context", arguments: { id: `src_${rid}` } } }) });
    const text = (await r.json()).result.content[0].text as string;
    assert.match(text, /## What the page saved/);
    assert.match(text, /"o2": "drop"/);

    assert.equal((await api(`/api/boards/${id}/resources/${rid}`, { method: "DELETE" })).status, 200);
    const left = await upload(id, "again.html", PAGE);
    assert.deepEqual((await api(`/api/boards/${id}/resources/${left}/state`)).body, { value: null, rev: 0 });
  } finally { await api(`/api/boards/${id}`, { method: "DELETE" }); }
});
