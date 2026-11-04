import { createHash } from "node:crypto";
import { logEvent } from "../../platform/events/events.ts";
import { APP, externalPath } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { httpError, sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { imports, startImportPump } from "../imports/pump.ts";
import { idOf } from "../../../shared/agent/ids.ts";
import { agentRepo as a } from "./repo.ts";
import { answerMcp } from "./mcp.ts";
import { listTokens, mintToken, revokeToken, uploadAllowed } from "./tokens.ts";

const CHUNK = 512 * 1024;

// Answered before the room's login gate: each checks its own token or signed link.
export const agentPublicRoutes: Route[] = [
  route("POST", "/mcp", answerMcp, { receipt: "exempt" }),   // each write tool keys its own receipt from its `key` argument
  route("GET", "/mcp", ({ res }) => { res.setHeader("Allow", "POST"); sendJson(res, 405, { error: "this MCP server answers POST only (no event stream)" }); }),

  route("PUT", /^\/api\/agent\/v1\/upload\/([a-zA-Z0-9_-]{8,80})$/, async ({ req, res, url, params, commit }) => {
    const id = params[0];
    if (!uploadAllowed(id, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
      sendJson(res, 403, { error: "This upload link is wrong or has expired. Call request_upload again for a fresh one." }); return;
    }
    const row = a.importOne.get(id);
    if (!row) { sendJson(res, 404, { error: "No such upload." }); return; }
    if (row.stage !== "uploading") { sendJson(res, 409, { error: `This file was already received (${row.stage}). Check get_import.`, import: idOf("import", id) }); return; }
    const parts: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > row.size) throw httpError(413, `This upload was announced as ${row.size} bytes; more arrived.`);
        parts.push(chunk as Buffer);
      }
    } catch (e) {
      if ((e as { code?: string }).code === "ECONNRESET" || req.destroyed) return;   // the agent hung up mid-file; it sends again
      throw e;
    }
    if (size !== row.size) { sendJson(res, 400, { error: `Expected ${row.size} bytes, got ${size}. Send the whole file in one PUT.` }); return; }
    const bytes = Buffer.concat(parts);
    if (row.sha256 && createHash("sha256").update(bytes).digest("hex") !== row.sha256) {
      sendJson(res, 400, { error: "These bytes don't match the sha256 given to request_upload." }); return;
    }
    // chunk() accepts a part it already holds unchanged, so a resent PUT after a cut is safe.
    for (let at = 0; at < size; at += CHUNK) imports.chunk(id, at, bytes.subarray(at, Math.min(size, at + CHUNK)));
    commit(() => {
      imports.transition(id, "uploading", "stored");
      logEvent(db, APP, "agent_upload_done", { board: row.board_id, bytes: size }, null);
      return { status: 200, body: { import: idOf("import", id), stage: "stored", next: `get_import({ id: "${idOf("import", id)}" })` } };
    });
    startImportPump();
  }, { receipt: "exempt" }),   // streams req itself; a resend is made safe by chunk() and the stage check
];

export const agentRoutes: Route[] = [
  route("GET", "/api/agent/tokens", ({ res }) => {
    sendJson(res, 200, { tokens: listTokens(), mcpPath: externalPath("mcp") });
  }),
  route("POST", "/api/agent/tokens", async ({ body, ssn, commit }) => {
    const b = await body<{ name?: string; write?: boolean }>(4096);
    const name = String(b.name ?? "").trim().slice(0, 60) || "agent";
    commit(() => {
      const made = mintToken(name, b.write !== false);
      logEvent(db, APP, "agent_token_add", { write: b.write !== false }, ssn);
      return { status: 201, body: { ...made, tokens: listTokens(), mcpPath: externalPath("mcp") } };
    });
  }, { receipt: "exempt" }),   // the answer holds the token itself, which must never sit in a stored receipt
  route("DELETE", /^\/api\/agent\/tokens\/([a-zA-Z0-9_-]+)$/, ({ params, ssn, commit }) => {
    commit(() => {
      const gone = revokeToken(params[0]);
      if (gone) logEvent(db, APP, "agent_token_revoke", {}, ssn);
      return { status: gone ? 200 : 404, body: { tokens: listTokens(), mcpPath: externalPath("mcp") } };
    });
  }, { receipt: "atomic" }),
];
