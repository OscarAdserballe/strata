// MCP over plain HTTP: one POST per JSON-RPC message, answered with JSON, no streams. Each initialize hands out an
// Mcp-Session-Id that the client sends back on every call; it names the run, and nothing else is kept per session.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
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
import { releaseRun } from "../dashboard/dispatch.ts";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS = "Strata is the user's reading room: boards of sources, flashcards and notes. Call whoami first to find the board, then get_context on it. Kept cards (<board>/kept) are what the user chose to hold onto; treat them as the core of what they know. Read get_guide before apply or request_upload; a deck (add_deck) or a primer (set_primer) is refused without the receipt that ends get_guide \"flashcards\" or \"primer\".";
const MAX_MESSAGE = 1024 * 1024;

type Id = string | number | null;
const result = (id: Id, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const error = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const said = (text: string, isError = false) => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

const RUN = /^[\x21-\x7e]{8,128}$/;
/** The run a call belongs to: its Mcp-Session-Id, or null from a client that sends none. */
export function runOf(req: IncomingMessage): string | null {
  const h = req.headers["mcp-session-id"];
  return typeof h === "string" && RUN.test(h) ? h : null;
}

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
      res.setHeader("Mcp-Session-Id", `run_${randomBytes(12).toString("base64url")}`);
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

/** DELETE /mcp: the client ends its session, so the run's claims end with it. */
export function endMcp(ctx: Ctx): void {
  const caller = callerOf(ctx.req), run = runOf(ctx.req);
  if (!caller || caller === "limited") { sendJson(ctx.res, caller ? 429 : 401, { error: "this needs a Strata agent token" }); return; }
  if (!run) { sendJson(ctx.res, 400, { error: "send the Mcp-Session-Id to end" }); return; }
  ctx.commit(() => {
    const released = releaseRun(run);
    if (released) logEvent(db, APP, "dispatch_release", { threads: released }, run);
    return { status: 200, body: { released } };
  });
}

async function callTool(ctx: Ctx, id: Id, caller: Caller, params: Record<string, unknown>): Promise<void> {
  const { req, res } = ctx;
  const name = String(params.name ?? "");
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) { sendJson(res, 200, error(id, -32602, `no tool ${name}`)); return; }
  const answer = (text: string, isError = false) => sendJson(res, 200, result(id, said(text, isError)));
  if (!caller.scopes.has(tool.scope)) { answer(`This token can only read. Make one with write access in Strata (Desk → Connect an agent) to use ${name}.`, true); return; }
  const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
  const env: Env = { req, caller, run: runOf(req) };
  const t0 = performance.now();
  let failed = false;
  try {
    if ("read" in tool && tool.claims?.(args)) { ctx.commit(() => ({ status: 200, body: result(id, said(tool.read(args, env))) })); return; }
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
    failed = true;
    if (!(e instanceof AgentError)) console.error(`[mcp ${name}]`, e);
    if (!res.headersSent) answer(e instanceof AgentError ? e.message : `Something went wrong in Strata: ${(e as Error).message}`, true);
  } finally {
    logEvent(db, APP, "agent_call", { tool: name, ms: Math.round(performance.now() - t0), token: caller.id, ...(failed ? { failed } : {}), ...(name.startsWith("dashboard_") && typeof args.id === "string" ? { thread: args.id } : {}) }, env.run);
  }
}
