import { geminiAvailable } from "../../platform/llm/gemini.ts";
import { logEvent } from "../../platform/events/events.ts";
import { recordClientSamples } from "../../platform/events/perf.ts";
import { CHAT_MODEL, CHAT_THINKING } from "../ask/turn.ts";
import { DISTIL_MODEL } from "../distil/distil.ts";
import { captureAvailable, TAVILY_KEY, FIRECRAWL_KEY } from "../capture/capture.ts";
import { APP, MAX_UPLOAD_BYTES, MIN_SECTION_WORDS, BUDGET_TOKENS } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { now } from "../../platform/db/sql.ts";
import { sendJson } from "../../platform/http/http.ts";
import { authConfig, authCookie, clearAuthCookie, loginAllowed, loginSucceeded, passwordMatches } from "../../platform/security/auth.ts";
import { clientIp } from "../../platform/security/security.ts";
import { route, type Route } from "../../platform/router/router.ts";

export const publicRoutes: Route[] = [
  route("GET", "/api/health", ({ res }) => {
    sendJson(res, 200, { ok: true, gemini: geminiAvailable, chat: CHAT_MODEL, chatThinking: CHAT_THINKING ?? "default", distil: DISTIL_MODEL, capture: captureAvailable, tavily: !!TAVILY_KEY, firecrawl: !!FIRECRAWL_KEY, maxUpload: MAX_UPLOAD_BYTES, minSectionWords: MIN_SECTION_WORDS, budgetTokens: BUDGET_TOKENS });
  }),

  route("POST", "/api/login", async ({ req, res, ssn, body }) => {
    const ip = clientIp(req);
    if (!loginAllowed(ip)) { logEvent(db, APP, "login", { ok: false, why: "rate-limited" }, ssn); sendJson(res, 429, { error: "too many attempts" }); return; }
    const b = await body<{ password?: string }>(16 * 1024);
    // never the password, never the IP — only that a door was tried and whether it opened
    if (!authConfig || typeof b.password !== "string" || !passwordMatches(b.password)) { logEvent(db, APP, "login", { ok: false }, ssn); sendJson(res, 401, { error: "wrong password" }); return; }
    loginSucceeded(ip);
    logEvent(db, APP, "login", { ok: true }, ssn);
    res.writeHead(200, { "Set-Cookie": authCookie(req), "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, { receipt: "exempt" }), // Answered before the auth gate, so it never buffers a body up front.
];

export const systemRoutes: Route[] = [
  route("POST", "/api/logout", ({ req, res, ssn }) => {
    logEvent(db, APP, "logout", {}, ssn);
    res.writeHead(200, { "Set-Cookie": clearAuthCookie(req), "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
  }, { receipt: "exempt" }),

  route("POST", "/api/perf", async ({ res, body }) => {
    recordClientSamples(db, await body<Record<string, unknown>>(64 * 1024));
    res.writeHead(204).end();
  }, { receipt: "exempt" }),  // a beacon: a lost one is a lost sample, never a retried write
  route("POST", "/api/log", async ({ res, ssn, body }) => {
    const b = await body<{ event?: string; props?: Record<string, unknown> }>();
    const props = (b.props && typeof b.props === "object") ? b.props : {};
    // sendBeacon cannot set X-Session, so the session rides in props.
    const eventSsn = ssn ?? (typeof props.session === "string" ? (props.session as string).slice(0, 64) : null);
    if (typeof b.event === "string" && b.event) logEvent(db, APP, b.event.slice(0, 40), props, eventSsn);
    // touched_at is bumped here, not on board GET: the offline warm pass fetches every board on boot.
    if (typeof props.board === "string") q.touchBoard.run(now(), props.board);
    res.writeHead(204).end();
  }, { receipt: "exempt" }),
];
