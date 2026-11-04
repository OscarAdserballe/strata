import { startImports } from "./features/imports/pump.ts";
import { createServer } from "node:http";
import { geminiAvailable } from "./platform/llm/gemini.ts";
import { logRequest, pruneRequestLog, sessionOf } from "./platform/events/events.ts";
import { prunePerfSamples, watchEventLoop } from "./platform/events/perf.ts";
import { pruneReceipts } from "./platform/db/receipts.ts";
import { BASE_PATH, PORT, HOST, DB_PATH, COURSES_DIR, internalPath } from "./platform/config.ts";
import { db } from "./platform/db/db.ts";
import { q } from "./features/repo.ts";
import { roomRev } from "./platform/db/sql.ts";
import { loadCourses } from "./features/decks/decks.ts";
import { backfillDistil } from "./features/distil/queue.ts";
import { CHAT_MODEL, CHAT_THINKING, FAKE_MODEL } from "./features/ask/turn.ts";
import { DISTIL_MODEL } from "./features/distil/distil.ts";
import { captureAvailable, TAVILY_KEY, FIRECRAWL_KEY } from "./features/capture/capture.ts";
import { authorized, authConfig, DEV_OPEN, loginPage, TRUST_TAILSCALE_HEADERS } from "./platform/security/auth.ts";
import { buildStamp, carriesRevision, readRevisionWith, sendJson, serveStatic } from "./platform/http/http.ts";
import { dispatch } from "./platform/router/router.ts";
import { publicRoutes, apiRoutes } from "./features/index.ts";
import { canonicalLocation, mutationOriginAllowed, responseNonce, setSecurityHeaders } from "./platform/security/security.ts";
import { guardProcess } from "./platform/background.ts";
import { runJob } from "./platform/jobs.ts";

guardProcess();
loadCourses();
readRevisionWith(roomRev);

const server = createServer(async (req, res) => {
  const nonce = responseNonce();
  setSecurityHeaders(res, nonce);
  logRequest(db, req, res);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = internalPath(url.pathname);
  url.pathname = path;
  const ssn = sessionOf(req);
  const base = { req, res, url, ssn };
  try {
    const canonical = canonicalLocation(req);
    if (canonical) { res.writeHead(308, { Location: canonical, "Cache-Control": "no-store" }); res.end(); return; }
    if (!mutationOriginAllowed(req)) { sendJson(res, 403, { error: "cross-origin writes are not allowed" }); return; }
    if (await dispatch(publicRoutes, base)) return;
    if (!authorized(req)) {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) { res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(loginPage(nonce)); }
      else sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (path.startsWith("/api/")) carriesRevision(res);
    if (await dispatch(apiRoutes, base)) return;

    if (req.method === "GET" || req.method === "HEAD") { await serveStatic(req, res, path, nonce); return; }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    // Errors carry their message: this is a single-user app behind auth.
    const err = e as Error & { httpStatus?: number };
    const status = err.httpStatus ?? 500;
    if (status === 500) console.error(`[${req.method} ${path}]`, e);
    const said = status === 500 ? `internal error — ${err.message || "no message"}` : (err.message || `HTTP ${status}`);
    if (!res.headersSent) sendJson(res, status, { error: said });
    else if (!res.writableEnded) res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`strata (reading room) listening on http://${HOST}:${PORT}`);
  console.log(`  base: ${BASE_PATH}`);
  console.log(`  db: ${DB_PATH}`);
  console.log(`  gemini: ${FAKE_MODEL ? "[FAKE MODEL — preview mode, no real calls]" : geminiAvailable ? `[key ok] tidy=${CHAT_MODEL}(think ${CHAT_THINKING ?? "default"}) distil=${DISTIL_MODEL}` : "[NO GEMINI_API_KEY — no cards are made]"}`);
  console.log(`  ask: ${FAKE_MODEL ? "[FAKE MODEL]" : geminiAvailable ? CHAT_MODEL : "[no GEMINI_API_KEY — offline placeholder]"}`);
  console.log(`  auth: ${DEV_OPEN ? "OPEN (dev)" : authConfig ? `password${TRUST_TAILSCALE_HEADERS ? " + trusted Tailscale headers" : ""}` : TRUST_TAILSCALE_HEADERS ? "trusted Tailscale headers only" : "closed (set STRATA_PASSWORD or STRATA_PASSWORD_FILE)"}`);
  console.log(`  decks: ${(q.courses.all() as unknown[]).length} courses in ${COURSES_DIR}`);
  console.log(`  capture: ${captureAvailable ? `articles via ${FIRECRAWL_KEY ? "firecrawl" : "tavily"}${FIRECRAWL_KEY && TAVILY_KEY ? " (tavily as fallback)" : ""}; youtube ${FIRECRAWL_KEY ? "via firecrawl" : "by pasted captions"}` : "[no TAVILY_API_KEY/FIRECRAWL_API_KEY — youtube by pasted captions]"}`);
  void runJob("distil-backfill", "boot", backfillDistil);
  startImports();
  const daily = (): void => {
    pruneRequestLog(db);
    pruneReceipts(db);
    prunePerfSamples(db);
    try { db.exec("PRAGMA optimize"); } catch (e) { console.error("strata: optimize failed", e); }
  };
  pruneRequestLog(db);
  pruneReceipts(db);
  setInterval(daily, 864e5).unref();
  let build = "";
  void buildStamp().then((b) => { build = b; }, () => {});
  watchEventLoop(db, () => build);
});

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`strata: ${signal}, closing`);
  server.close(() => { try { db.close(); } finally { process.exit(0); } });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
