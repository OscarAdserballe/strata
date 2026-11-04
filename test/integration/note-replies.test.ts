// A note can be answered: by you, or by an agent, each reply sent the moment it is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

const server = useServer();
const send = (method: string, path: string, body?: unknown) => server.api(path, {
  method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" },
});

let token = "", rpcN = 0;
async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (!token) token = (await send("POST", "/api/agent/tokens", { name: "replier", write: true })).body.token;
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcN, method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}

async function noted(board: string) {
  const { body: res } = await send("POST", `/api/boards/${board}/resources`, { filename: "a.md", text: "Alpha beta gamma delta epsilon." });
  const { body: mk } = await send("POST", `/api/boards/${board}/marks`, { resourceId: res.id, start: 6, end: 16, quote: "beta gamma", note: "the load-bearing bit" });
  return mk.id as string;
}

test("you reply under a note; the reply is the reader's, kept in order, and a retry lands once", async () => {
  const board = await newBoard(server, { title: "Note replies" });
  try {
    const mid = await noted(board);
    const at = `/api/boards/${board}/marks/${mid}/replies`;
    const first = await send("POST", at, { id: "mr-00000001ab12cd34", text: "  and why it holds  " });
    assert.equal(first.status, 201);
    assert.deepEqual({ author: first.body.reply.author, text: first.body.reply.text }, { author: "you", text: "and why it holds" });
    assert.equal((await send("POST", at, { id: "mr-00000001ab12cd34", text: "and why it holds" })).status, 200, "a retry of the same reply is the same reply");
    assert.equal((await send("POST", at, { id: "mr-00000001ab12cd34", text: "something else" })).status, 409);
    assert.equal((await send("POST", at, { text: "   " })).status, 400);
    assert.equal((await send("POST", `/api/boards/${board}/marks/mk-nope/replies`, { text: "x" })).status, 404);
    await send("POST", at, { text: "second thought" });
    const { body: st } = await server.api(`/api/boards/${board}`);
    assert.deepEqual(st.marks[0].replies.map((r: { text: string }) => r.text), ["and why it holds", "second thought"]);
  } finally { await send("DELETE", `/api/boards/${board}`); }
});

test("an agent replies under a note with reply_note, and sees the reply in the highlight", async () => {
  const board = await newBoard(server, { title: "Agent replies" });
  try {
    const mid = await noted(board);
    const r = await tool("apply", { board, key: "note-reply-1", ops: [{ op: "reply_note", id: `hl_${mid}`, text: "It holds because the check gates the cost." }] });
    assert.equal(r.isError, false, r.text);
    const { body: st } = await server.api(`/api/boards/${board}`);
    assert.deepEqual(st.marks[0].replies.map((x: { author: string }) => x.author), ["agent"]);
    const ctx = await tool("get_context", { id: `hl_${mid}` });
    assert.match(ctx.text, /agent · .*: It holds because the check gates the cost\./);

    const { body: res } = await send("POST", `/api/boards/${board}/resources`, { filename: "b.md", text: "Plain words here." });
    const { body: bare } = await send("POST", `/api/boards/${board}/marks`, { resourceId: res.id, start: 0, end: 5, quote: "Plain" });
    const refused = await tool("apply", { board, key: "note-reply-2", ops: [{ op: "reply_note", id: `hl_${bare.id}`, text: "hm" }] });
    assert.equal(refused.isError, true, "a highlight with no note has nothing to answer");
  } finally { await send("DELETE", `/api/boards/${board}`); }
});

test("removing a note takes its replies with it", async () => {
  const board = await newBoard(server, { title: "Replies go" });
  try {
    const mid = await noted(board);
    await send("POST", `/api/boards/${board}/marks/${mid}/replies`, { text: "a reply" });
    await send("DELETE", `/api/boards/${board}/marks/${mid}`);
    const again = await noted(board);
    const { body: st } = await server.api(`/api/boards/${board}`);
    assert.deepEqual(st.marks.find((m: { id: string }) => m.id === again).replies, []);
  } finally { await send("DELETE", `/api/boards/${board}`); }
});
