// A primer: the reader asks for one, the routine writes it through set_primer, and the reader opens it in a sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const server = useServer();
const PAGE = `<!doctype html><html><body><main><h1>Three threads</h1><svg viewBox="0 0 10 10"></svg></main></body></html>`;
let token = "", n = 0;

const rpc = async (method: string, params?: unknown) => {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
  return (await r.json()).result as { content: { text: string }[]; isError?: boolean };
};
const call = async (name: string, args: Record<string, unknown>) => { const r = await rpc("tools/call", { name, arguments: args }); return { text: r.content[0]!.text, isError: !!r.isError }; };

test("asking marks the source for the routine, set_primer fills it, and the page is served sandboxed", async () => {
  token = (await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "routine", write: true }) })).body.token;
  const board = await newBoard(server, { title: "Panel data" });
  try {
    const rid = await addMarkdown(server, board, "panel.md", MD);
    const at = `/api/boards/${board}/resources/${rid}/primer`;
    assert.equal((await server.api(at)).body.status, "none");
    assert.equal((await server.api(`${at}/page`)).status, 404, "no page before one is written");

    const asked = await server.api(at, { method: "POST", body: "{}" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.status, "asked");
    assert.match((await call("whoami", {})).text, /1 primer asked for/);
    assert.match((await call("get_outline", { board })).text, new RegExp(`src_${rid} .*primer asked`));

    const bad = await call("apply", { board, key: "primer-bad-1", ops: [{ op: "set_primer", source: `src_${rid}`, html: "just words" }] });
    assert.ok(bad.isError && /whole HTML page/.test(bad.text), bad.text);
    const other = await call("apply", { board, key: "primer-other-1", ops: [{ op: "set_primer", source: "src_res-nope", html: PAGE }] });
    assert.ok(other.isError && /not a source/.test(other.text), other.text);

    const set = await call("apply", { board, key: "primer-set-1", ops: [{ op: "set_primer", source: `src_${rid}`, html: PAGE }] });
    assert.equal(set.isError, false, set.text);
    const ready = (await server.api(at)).body;
    assert.equal(ready.status, "ready");
    assert.equal(ready.hasPage, true);
    assert.ok(ready.rev > asked.body.rev, "writing it moves the row's rev");
    assert.doesNotMatch((await call("whoami", {})).text, /primer asked for/, "nothing left to write");

    const page = await server.fetch(`${at}/page`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /^sandbox allow-scripts/);
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
    assert.equal(await page.text(), PAGE, "served as written, with no save bridge");

    const again = await server.api(at, { method: "POST", body: "{}" });
    assert.equal(again.body.status, "asked");
    assert.equal(again.body.hasPage, true, "the old page stays while a new one is written");

    await server.api(`/api/boards/${board}/resources/${rid}`, { method: "DELETE" });
    assert.equal((await server.api(at)).status, 404);
    assert.equal((await server.api(`${at}/page`)).status, 404, "the primer goes with its source");
  } finally { await server.api(`/api/boards/${board}`, { method: "DELETE" }); }
});

test("asking for a source that isn't on the board is a 404", async () => {
  const board = await newBoard(server, { title: "Elsewhere" });
  try {
    assert.equal((await server.api(`/api/boards/${board}/resources/res-nope/primer`, { method: "POST", body: "{}" })).status, 404);
  } finally { await server.api(`/api/boards/${board}`, { method: "DELETE" }); }
});
