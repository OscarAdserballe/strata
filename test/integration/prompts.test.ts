// Prompts: the reader's own text for a guide topic is what agents read, a guided topic's receipt follows it, and a posted page keeps which topics were the reader's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const server = useServer({ env: { STRATA_ROUTINE_STUB: "1" } });
let token = "", n = 0, k = 0;

const put = (topic: string, text: string | null, rev: number | null) => server.api(`/api/agent/prompts/${topic}`, {
  method: "PUT", body: JSON.stringify({ text }),
  headers: { "Content-Type": "application/json", "Idempotency-Key": `prompt-${++k}-${Date.now()}`, ...(rev === null ? {} : { "If-Match": `"${rev}"` }) },
});
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return { text: res.content[0].text as string, isError: !!res.isError };
}
const topic = async (t: string) => ((await server.api("/api/agent/prompts")).body as { topics: any[] }).topics.find((x) => x.topic === t);

test("a topic in the reader's own text is what get_guide answers, until it is reset", async () => {
  token = ((await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "prompts", write: true }) })).body as { token: string }).token;
  const shipped = await call("get_guide", { topic: "proposal" });
  const was = await topic("proposal");
  assert.deepEqual([was.own, was.rev, was.text], [false, 0, was.shipped]);
  assert.equal(shipped.text, was.shipped);

  const mine = "## proposal\n\nTwo options, side by side, and a Figma frame for anything visual.";
  const saved = await put("proposal", mine, 0);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.own, saved.body.rev, saved.body.text], [true, 1, mine]);
  assert.equal((await call("get_guide", { topic: "proposal" })).text, mine, "the next run reads the reader's text");
  assert.ok((await call("get_guide")).text.includes(mine), "and so does the whole guide");

  const stale = await put("proposal", "lost", 0);
  assert.equal(stale.status, 409, "a write on an older rev is refused");
  assert.equal((await topic("proposal")).text, mine, "and nothing is written");

  const reset = await put("proposal", null, 1);
  assert.deepEqual([reset.status, reset.body.own, reset.body.rev], [200, false, 2], "a reset keeps the rev rising");
  assert.equal((await call("get_guide", { topic: "proposal" })).text, shipped.text);
  assert.equal((await put("nosuch", "x", null)).status, 404);
});

test("a guided topic's receipt follows the reader's text", async () => {
  const receipt = (s: string) => /Receipt: (primer-[0-9a-f]{8})/.exec(s)![1];
  const before = receipt((await call("get_guide", { topic: "primer" })).text);
  const r = await put("primer", "## primer\n\nDraw the plan first, then the page.", 0);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await call("get_guide", { topic: "primer" });
  assert.ok(after.text.startsWith("## primer\n\nDraw the plan first"), after.text);
  assert.notEqual(receipt(after.text), before, "the receipt is the text the agent read");
});

test("a posted page keeps which topics were in the reader's own text", async () => {
  const id = `t_${Math.random().toString(36).slice(2, 12)}`;
  const made = await server.api("/api/dashboard/tasks", { method: "POST", body: JSON.stringify({ id, title: "Prompts snapshot" }), headers: { "Content-Type": "application/json", "Idempotency-Key": `prompt-t-${Date.now()}` } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await server.api(`/api/dashboard/tasks/${id}/send`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "Idempotency-Key": `prompt-s-${Date.now()}` } });
  await call("dashboard_open", { id });
  const p = await call("dashboard_post", { key: `prompt-post-${Date.now()}`, id, page: "<!doctype html><html><body><h1>v1</h1></body></html>", ask: "a", heard: "b" });
  assert.equal(p.isError, false, p.text);
  const v = ((await server.api("/api/dashboard/dispatch")).body as { threads: any[] }).threads.find((t) => t.id === id).versions[0];
  assert.deepEqual(v.told.map((t: { topic: string }) => t.topic), ["primer"]);
});
