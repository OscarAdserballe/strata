// A primer end to end: the reader asks, the routine finds the ask, draws a page and links it, and the reader sees both doors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const server = useServer();
let n = 0;
const PAGE = '<!doctype html><html><body><h1 data-strata-id="answer">Duration hedging, in one picture</h1><script>document.title = "x";</script></body></html>';

async function tool(token: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}
const meta = async (board: string, rid: string) =>
  ((await server.api(`/api/boards/${board}`)).body.resources as { id: string; primer?: { id: string | null; askedAt: number | null }; primerOf?: string }[]).find((r) => r.id === rid)!;

test("the reader asks for a primer, the routine draws it, and each page opens the other", async () => {
  const token = ((await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "routine", write: true }) })).body as { token: string }).token;
  const board = await newBoard(server, { title: "Rates" });
  const rid = await addMarkdown(server, board, "hedging.md", MD);
  assert.equal((await meta(board, rid)).primer, undefined, "no primer until one is asked for");

  const asked = await server.api(`/api/boards/${board}/resources/${rid}/primer`, { method: "POST", headers: { "Idempotency-Key": "primer-ask-0001" } });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal((await meta(board, rid)).primer?.id, null);
  assert.ok((await meta(board, rid)).primer?.askedAt);

  const who = await tool(token, "whoami", {});
  assert.match(who.text, /## Primers asked for/);
  assert.ok(who.text.includes(`src_${rid} "hedging"`), who.text);
  assert.match((await tool(token, "get_context", { id: `src_${rid}` })).text, /primer: none yet · asked for/);
  assert.doesNotMatch((await tool(token, "get_guide", { topic: "primer" })).text, /<!doctype html>/i, "a brief, not a template");

  const pid = await addMarkdown(server, board, "Primer · hedging.html", PAGE);
  const wrong = await tool(token, "apply", { board, key: "primer-link-bad1", ops: [{ op: "set_primer", source: `src_${pid}`, primer: `src_${rid}` }] });
  assert.ok(wrong.isError && /not an HTML page/.test(wrong.text), wrong.text);
  const linked = await tool(token, "apply", { board, key: "primer-link-0001", ops: [{ op: "set_primer", source: `src_${rid}`, primer: `src_${pid}` }] });
  assert.equal(linked.isError, false, linked.text);

  assert.deepEqual((await meta(board, rid)).primer, { id: pid, askedAt: null }, "linking clears the ask");
  assert.equal((await meta(board, pid)).primerOf, rid);
  const pairs = (await server.api(`/api/boards/${board}`)).body.pairs as { resourceId: string | null }[];
  assert.ok(pairs.some((p) => p.resourceId === pid), "the primer gets a pair, so its button opens it");
  assert.doesNotMatch((await tool(token, "whoami", {})).text, /Primers asked for/);
  const self = await server.api(`/api/boards/${board}/resources/${pid}/primer`, { method: "POST", headers: { "Idempotency-Key": "primer-ask-0002" } });
  assert.equal(self.status, 422, "a primer has no primer of its own");

  await server.api(`/api/boards/${board}/resources/${pid}`, { method: "DELETE", headers: { "Idempotency-Key": "primer-del-00001" } });
  assert.equal((await meta(board, rid)).primer, undefined, "deleting the page drops the link");
});
