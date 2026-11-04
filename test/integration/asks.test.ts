// A question asked at words: its turns are the source thread's, and the words are kept with them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

const server = useServer();
const send = (method: string, path: string, body?: unknown) => server.api(path, {
  method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
});

let token = "", rpcN = 0;
async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  if (!token) token = (await send("POST", "/api/agent/tokens", { name: "reader" })).body.token;
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcN, method: "tools/call", params: { name, arguments: args } }) });
  return (await r.json()).result.content[0].text as string;
}

const words = { id: "ak-00000001ab12cd34", start: 6, end: 16, quote: "beta gamma", page: null, rects: [], box: null };

test("a question at words keeps them, and its answer and follow-ups are under the same ask", async () => {
  const board = await newBoard(server, { title: "Asked at words" });
  const { body: res } = await send("POST", `/api/boards/${board}/resources`, { filename: "a.md", text: "Alpha beta gamma delta epsilon." });
  const asked = await send("POST", `/api/boards/${board}/chat`, { message: "Why these two?", here: { thread: res.id }, ask: words });
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.body.state.asks.map((a: { id: string; quote: string; resourceId: string; start: number }) => [a.id, a.quote, a.resourceId, a.start]),
    [[words.id, "beta gamma", res.id, 6]]);
  const again = await send("POST", `/api/boards/${board}/chat`, { message: "And after them?", here: { thread: res.id }, ask: { ...words, quote: "moved words" } });
  assert.equal(again.status, 200);
  assert.equal(again.body.state.asks.length, 1, "a follow-up asks under the same words, which never move");
  assert.equal(again.body.state.asks[0].quote, "beta gamma");
  const { body: page } = await server.api(`/api/boards/${board}/messages?resource=${res.id}`);
  assert.deepEqual(page.messages.map((m: { role: string; ask: string | null }) => [m.role, m.ask]),
    [["user", words.id], ["assistant", words.id], ["user", words.id], ["assistant", words.id]]);

  const plain = await send("POST", `/api/boards/${board}/chat`, { message: "And the whole page?", here: { thread: res.id } });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.state.messages.at(-1).ask, null, "a turn asked at no words names none");

  const chat = await tool("get_context", { id: `${board}/chat` });
  assert.match(chat, /at the words "beta gamma"/, "an agent reads where a question was asked");
});

test("an ask is refused when its words are malformed, missing a source, or on another source", async () => {
  const board = await newBoard(server, { title: "Asks refused" });
  const { body: a } = await send("POST", `/api/boards/${board}/resources`, { filename: "a.md", text: "Alpha beta gamma delta epsilon." });
  const { body: b } = await send("POST", `/api/boards/${board}/resources`, { filename: "b.md", text: "Zeta eta theta iota kappa." });
  assert.equal((await send("POST", `/api/boards/${board}/chat`, { message: "?", here: { thread: a.id }, ask: { ...words, id: "nope" } })).status, 400);
  assert.equal((await send("POST", `/api/boards/${board}/chat`, { message: "?", here: { thread: a.id }, ask: { ...words, quote: " " } })).status, 400);
  assert.equal((await send("POST", `/api/boards/${board}/chat`, { message: "?", here: { thread: null }, ask: words })).status, 400);
  assert.equal((await send("POST", `/api/boards/${board}/chat`, { message: "First", here: { thread: a.id }, ask: words })).status, 200);
  assert.equal((await send("POST", `/api/boards/${board}/chat`, { message: "Elsewhere", here: { thread: b.id }, ask: words })).status, 409);
});

test("deleting a source takes the words asked at on it", async () => {
  const board = await newBoard(server, { title: "Asks deleted" });
  const { body: res } = await send("POST", `/api/boards/${board}/resources`, { filename: "a.md", text: "Alpha beta gamma delta epsilon." });
  assert.equal((await send("POST", `/api/boards/${board}/chat`, { message: "Why?", here: { thread: res.id }, ask: words })).status, 200);
  assert.ok((await send("DELETE", `/api/boards/${board}/resources/${res.id}`)).status < 300);
  const { body: st } = await server.api(`/api/boards/${board}`);
  assert.deepEqual(st.asks, []);
});
