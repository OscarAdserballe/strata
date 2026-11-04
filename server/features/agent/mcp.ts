// MCP over plain HTTP: one POST per JSON-RPC message, answered with JSON. No sessions, no streams.
import { createHash } from "node:crypto";
import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { now } from "../../platform/db/sql.ts";
import { RECEIPT_KEY, receiptStore } from "../../platform/db/receipts.ts";
import { sendJson } from "../../platform/http/http.ts";
import type { Ctx } from "../../platform/router/router.ts";
import { AgentError } from "./kinds.ts";
import { callerOf, type Caller } from "./tokens.ts";
import { TOOL_BY_NAME, TOOLS, type Env } from "./tools.ts";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS = "Strata is the user's reading room: boards of sources, flashcards and notes. Call whoami first to find the board, then get_context on it. Kept cards (<board>/kept) are what the user chose to hold onto; treat them as the core of what they know. Read get_guide before apply or request_upload.";
const MAX_MESSAGE = 1024 * 1024;

type Id = string | number | null;
const result = (id: Id, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const error = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const said = (text: string, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

let receipts: ReturnType<typeof receiptStore> | null = null;
const store = () => (receipts ??= receiptStore(db));

export async function answerMcp(ctx: Ctx): Promise<void> {
  const { req, res } = ctx;
  const caller = callerOf(req);
  if (caller === "limited") { sendJson(res, 429, { error: "too many bad tokens from this address; wait ten minutes" }); return; }
  if (!caller) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="strata"');
    sendJson(res, 401, { error: "this needs a Strata agent token: Authorization: Bearer stk_…" });
    return;
  }
  let msg: { id?: Id; method?: string; params?: Record<string, unknown> };
  try { msg = await ctx.body(MAX_MESSAGE); }
  catch (e) { sendJson(res, 200, error(null, -32700, (e as Error).message)); return; }
  if (Array.isArray(msg)) { sendJson(res, 200, error(null, -32600, "batched messages are not supported; send one per request")); return; }
  const id = msg.id ?? null;
  if (msg.id === undefined) { res.writeHead(202).end(); return; }   // a notification needs no answer
  switch (msg.method) {
    case "initialize": {
      const asked = String(msg.params?.protocolVersion ?? "");
      sendJson(res, 200, result(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "strata", title: "Strata", version: "1" },
        instructions: INSTRUCTIONS,
      }));
      return;
    }
    case "ping": sendJson(res, 200, result(id, {})); return;
    case "tools/list":
      sendJson(res, 200, result(id, { tools: TOOLS.map((t) => ({
        name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
        annotations: { title: t.title, readOnlyHint: "read" in t, destructiveHint: false, idempotentHint: true, openWorldHint: t.name === "capture" },
      })) }));
      return;
    case "tools/call": await callTool(ctx, id, caller, msg.params ?? {}); return;
    default: sendJson(res, 200, error(id, -32601, `no method ${String(msg.method)}`));
  }
}

async function callTool(ctx: Ctx, id: Id, caller: Caller, params: Record<string, unknown>): Promise<void> {
  const { req, res } = ctx;
  const name = String(params.name ?? "");
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) { sendJson(res, 200, error(id, -32602, `no tool ${name}`)); return; }
  const answer = (text: string, isError = false) => sendJson(res, 200, result(id, said(text, isError)));
  if (!caller.scopes.has(tool.scope)) { answer(`This token can only read. Make one with write access in Strata (Desk → Connect an agent) to use ${name}.`, true); return; }
  const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
  const env: Env = { req, caller };
  const t0 = performance.now();
  try {
    if ("read" in tool) { answer(tool.read(args, env)); return; }
    const key = String(args.key ?? "");
    if (!RECEIPT_KEY.test(key)) throw new AgentError("key is a fresh id for this write: 8–80 letters, digits or dashes.");
    const { key: _key, ...rest } = args;
    const rkey = `mcp-${caller.id}-${key}`;
    const hash = createHash("sha256").update(`${name}\0${JSON.stringify(rest)}`).digest("hex");
    const replay = (): string | null => {
      const had = store().find(rkey);
      if (!had) return null;
      if (had.path !== name || had.body_hash !== hash) throw new AgentError(`The key "${key}" was already used for a different write. Use a fresh key.`);
      return had.body ?? "";
    };
    const before = replay();
    if (before !== null) { answer(before); return; }
    const write = await tool.write(args, env);
    ctx.commit(() => {
      const again = replay();
      const text = again ?? write();
      if (again === null) store().put({ key: rkey, method: "MCP", path: name, body_hash: hash, status: 200, body: text, rev: null, created_at: now() });
      return { status: 200, body: result(id, said(text)) };
    });
  } catch (e) {
    if (!(e instanceof AgentError)) console.error(`[mcp ${name}]`, e);
    if (!res.headersSent) answer(e instanceof AgentError ? e.message : `Something went wrong in Strata: ${(e as Error).message}`, true);
  } finally {
    logEvent(db, APP, "agent_call", { tool: name, ms: Math.round(performance.now() - t0), token: caller.id }, null);
  }
}
