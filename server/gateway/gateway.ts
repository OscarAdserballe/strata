import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { collectRooms, createUsageSnapshot } from "./admin/usage-collector.mjs";
import { usagePage } from "./admin/usage-page.mjs";
import { startRooms } from "./rooms.ts";

export interface GatewayAccount { username: string; password: string; upstream: string; basePath: string; admin?: boolean }
export interface GatewayConfig {
  sessionSecret: string;
  accounts: GatewayAccount[];
  host?: string;
  port?: number;
  origin?: string;
  sessionDays?: number;
  minFreeBytes?: number;
  adminUsage?: ReturnType<typeof createUsageSnapshot>;
}

interface Account extends GatewayAccount { key: string; basePath: string; upstreamUrl: URL }

const cookieName = "strata_session";
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const normalizeUser = (s: string): string => s.trim().toLocaleLowerCase("en-US");
const normalizeBase = (s: string): string => `/${s.replace(/^\/+|\/+$/g, "")}/`;
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function securityHeaders(res: ServerResponse, nonce: string): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", `default-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
}

function secure(req: IncomingMessage, origin?: string): boolean {
  return origin?.startsWith("https://") || req.headers["x-forwarded-proto"] === "https";
}

// Lax, not Strict: a link to Strata from another app is a top-level GET, and Strict would drop the cookie on it.
function cookie(req: IncomingMessage, value: string, maxAge: number, origin?: string): string {
  return `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure(req, origin) ? "; Secure" : ""}`;
}

function loginPage(nonce: string, error = ""): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Strata</title><style>body{background:#fbf8f2;color:#403d38;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}form{text-align:center}p{font-style:italic;color:#6c6861;font-size:18px;margin-bottom:22px}input{display:block;font:15px ui-monospace,monospace;color:#403d38;background:transparent;border:none;border-bottom:1px solid #ddd7cd;padding:8px 2px;text-align:center;outline:none;width:220px;margin:8px auto}button{font:12px ui-monospace,monospace;color:#6c6861;background:transparent;border:0;padding:10px;cursor:pointer}.err{font:11px ui-monospace,monospace;color:#a24f39;margin-top:6px;min-height:14px}</style></head><body><form id="f"><p>Login:</p><input id="u" autocomplete="username" placeholder="name" autofocus><input id="p" type="password" autocomplete="current-password" placeholder="password"><button type="submit">enter</button><div class="err" id="e">${error}</div></form><script nonce="${nonce}">document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('u').value,password:document.getElementById('p').value})});if(r.ok)location.href=(await r.json()).path;else document.getElementById('e').textContent=r.status===429?'too many tries — wait a bit':'not that name and word';});</script></body></html>`;
}

async function readBody(req: IncomingMessage, max = 16 * 1024): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n <= max) chunks.push(c); else reject(new Error("request too large")); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function originAllowed(req: IncomingMessage, configured?: string): boolean {
  if (safeMethods.has(req.method ?? "GET")) return true;
  const raw = req.headers.origin;
  if (!raw) return true;
  const expected = configured || `${secure(req, configured) ? "https" : "http"}://${req.headers.host}`;
  try { return new URL(raw).origin === new URL(expected).origin; } catch { return false; }
}

function proxy(req: IncomingMessage, res: ServerResponse, account: Account, setCookie: string | null = null): void {
  const headers: IncomingHttpHeaders = { "x-forwarded-host": req.headers.host, ...req.headers, host: account.upstreamUrl.host };
  delete headers.connection; delete headers["proxy-connection"]; delete headers.upgrade;
  const ask = account.upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = ask({
    protocol: account.upstreamUrl.protocol,
    hostname: account.upstreamUrl.hostname,
    port: account.upstreamUrl.port,
    method: req.method,
    path: req.url,
    headers,
  }, (answer) => {
    const out = { ...answer.headers };
    delete out.connection; delete out["keep-alive"]; delete out["transfer-encoding"];
    if (setCookie) out["set-cookie"] = [...[out["set-cookie"] ?? []].flat(), setCookie];
    res.writeHead(answer.statusCode ?? 502, out);
    answer.pipe(res);
  });
  upstream.on("error", (e) => { if (!res.headersSent) json(res, 502, { error: `room unavailable — ${e.message}` }); else res.end(); });
  req.pipe(upstream);
}

export function createGateway(config: GatewayConfig): { server: Server; listen(): Server } {
  if (!config.sessionSecret || config.sessionSecret.length < 32) throw new Error("gateway sessionSecret must be at least 32 characters");
  const accounts: Account[] = config.accounts.map((a) => ({ ...a, key: normalizeUser(a.username), basePath: normalizeBase(a.basePath), upstreamUrl: new URL(a.upstream) }));
  if (!accounts.length || accounts.some((a) => !a.key || !a.password || !/^\/u\/[a-z0-9-]+\/$/.test(a.basePath) || !["http:", "https:"].includes(a.upstreamUrl.protocol))) throw new Error("gateway accounts need a username, password, /u/name path, and HTTP upstream");
  if (new Set(accounts.map((a) => a.key)).size !== accounts.length || new Set(accounts.map((a) => a.basePath)).size !== accounts.length) throw new Error("gateway accounts need unique usernames and base paths");
  const byUser = new Map(accounts.map((a) => [a.key, a]));
  const byPath = [...accounts].sort((a, b) => b.basePath.length - a.basePath.length);
  // A device in use stays signed in: the cookie is re-minted past a third of its life. Chrome caps a cookie at 400 days.
  const ttl = Math.max(1, Math.min(config.sessionDays ?? 365, 400)) * 86400;
  const renewAfterMs = (ttl * 1000) / 3;
  const minFree = config.minFreeBytes ?? 2 * 1024 ** 3;
  const attempts = new Map<string, { n: number; until: number }>();
  const sign = (payload: string, account: Account): string => createHmac("sha256", config.sessionSecret).update(account.password).update("\0").update(payload).digest("base64url");
  const mint = (account: Account): string => { const payload = Buffer.from(JSON.stringify({ u: account.key, e: Date.now() + ttl * 1000, n: randomBytes(8).toString("hex") })).toString("base64url"); return `${payload}.${sign(payload, account)}`; };
  const session = (req: IncomingMessage): { account: Account; expires: number } | null => {
    const raw = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`))?.[1];
    if (!raw) return null;
    const [payload, mac] = raw.split(".");
    if (!payload || !mac) return null;
    try {
      const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: string; e?: number };
      const account = p.u ? byUser.get(p.u) : undefined;
      return account && p.e && p.e > Date.now() && same(sign(payload, account), mac) ? { account, expires: p.e } : null;
    } catch { return null; }
  };

  const server = createServer(async (req, res) => {
    const nonce = randomBytes(18).toString("base64");
    securityHeaders(res, nonce);
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!originAllowed(req, config.origin)) { json(res, 403, { error: "cross-origin writes are not allowed" }); return; }
    if (req.method === "GET" && url.pathname === "/api/health") {
      const fs = statfsSync("/"); const freeBytes = fs.bavail * fs.bsize;
      const probes = await Promise.all(accounts.map(async (a) => {
        try { const r = await fetch(new URL(`${a.basePath}api/health`, a.upstreamUrl), { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
      }));
      const ready = freeBytes >= minFree && probes.every(Boolean);
      json(res, ready ? 200 : 503, { ok: ready, ready, build: process.env.STRATA_COMMIT ?? "dev", freeBytes, accounts: accounts.length, rooms: probes.filter(Boolean).length }); return;
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const peer = String(req.headers["tailscale-user-login"] ?? req.socket.remoteAddress ?? "?").trim();
      const state = attempts.get(peer), now = Date.now();
      if (state && state.until > now && state.n >= 8) { json(res, 429, { error: "too many attempts" }); return; }
      let body: { username?: string; password?: string } = {};
      try { body = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "invalid login" }); return; }
      const account = byUser.get(normalizeUser(String(body.username ?? "")));
      if (!account || !same(account.password, String(body.password ?? ""))) {
        attempts.set(peer, state && state.until > now ? { n: state.n + 1, until: state.until } : { n: 1, until: now + 10 * 60_000 });
        json(res, 401, { error: "wrong username or password" }); return;
      }
      attempts.delete(peer);
      json(res, 200, { ok: true, path: account.basePath }, { "Set-Cookie": cookie(req, mint(account), ttl, config.origin) }); return;
    }
    // An agent's request carries its own credential (a bearer token or a signed upload link), which the room checks.
    const agent = byPath.find((a) => (req.method === "POST" && url.pathname === `${a.basePath}mcp` && /^Bearer\s/.test(String(req.headers.authorization ?? "")))
      || (req.method === "PUT" && url.pathname.startsWith(`${a.basePath}api/agent/v1/upload/`)));
    if (agent) { proxy(req, res, agent); return; }
    const held = session(req);
    const account = held?.account ?? null;
    const renewed = held && held.expires - Date.now() < ttl * 1000 - renewAfterMs ? cookie(req, mint(held.account), ttl, config.origin) : null;
    if (req.method === "POST" && (url.pathname === "/api/logout" || byPath.some((a) => url.pathname === `${a.basePath}api/logout`))) {
      json(res, 200, { ok: true }, { "Set-Cookie": cookie(req, "", 0, config.origin) }); return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      if (account) { res.writeHead(302, { Location: account.basePath, "Cache-Control": "no-store", ...(renewed ? { "Set-Cookie": renewed } : {}) }); res.end(); }
      else { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(loginPage(nonce)); }
      return;
    }
    if (!account) {
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) { res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(loginPage(nonce)); }
      else json(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/session") {
      json(res, 200, { username: account.username, adminPath: account.admin === true && config.adminUsage ? "/admin" : null }, renewed ? { "Set-Cookie": renewed } : {}); return;
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname === "/api/usage") {
      if (account.admin !== true) { json(res, 403, { error: "admin access required" }); return; }
      if (req.method !== "GET") { json(res, 405, { error: "read-only dashboard" }); return; }
      if (!["/admin", "/admin/", "/api/usage"].includes(url.pathname)) { json(res, 404, { error: "not found" }); return; }
      if (!config.adminUsage) { json(res, 503, { error: "usage collection not configured" }); return; }
      try {
        const data = await config.adminUsage();
        if (url.pathname === "/api/usage") { json(res, 200, data); return; }
        const requested = url.searchParams.get("period") ?? "all";
        const period = ["7", "30", "all"].includes(requested) ? requested : "all";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(usagePage(data, period, { backPath: account.basePath }));
      } catch { json(res, 503, { error: "usage collection unavailable" }); }
      return;
    }
    const target = byPath.find((a) => url.pathname === a.basePath.slice(0, -1) || url.pathname.startsWith(a.basePath));
    if (!target) { res.writeHead(302, { Location: account.basePath, "Cache-Control": "no-store" }); res.end(); return; }
    if (target.key !== account.key) { json(res, 403, { error: "that is another room" }); return; }
    proxy(req, res, account, renewed);
  });

  return {
    server,
    listen: () => server.listen(config.port ?? 8080, config.host ?? "0.0.0.0", () => console.log(`strata gateway listening on ${config.host ?? "0.0.0.0"}:${config.port ?? 8080} for ${accounts.length} named rooms`)),
  };
}

// Accounts with no upstream get a room of their own, started here, with its data in STRATA_DATA/<name>.
export function createGatewayFromEnv(): ReturnType<typeof createGateway> {
  const path = process.env.STRATA_ACCOUNTS_FILE ?? "/run/secrets/strata_accounts";
  const raw = JSON.parse(readFileSync(path, "utf8")) as Omit<GatewayConfig, "accounts"> & { accounts: Array<Omit<GatewayAccount, "upstream" | "basePath"> & Partial<GatewayAccount>> };
  const dataRoot = process.env.STRATA_DATA ?? "/data";
  const firstPort = Number(process.env.STRATA_ROOM_PORT ?? 9001);
  const rooms: Parameters<typeof startRooms>[0] = [];
  const accounts: GatewayAccount[] = raw.accounts.map((a, i) => {
    const key = normalizeUser(a.username);
    const basePath = a.basePath ?? `/u/${key}/`;
    if (a.upstream) return { ...a, basePath, upstream: a.upstream };
    const port = firstPort + i;
    rooms.push({ key, basePath, port, dataDir: join(dataRoot, key) });
    return { ...a, basePath, upstream: `http://127.0.0.1:${port}` };
  });
  const stop = startRooms(rooms);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stop(); process.exit(0); });
  return createGateway({ ...raw, accounts, host: process.env.STRATA_HOST ?? raw.host, port: Number(process.env.STRATA_PORT ?? raw.port ?? 8080), origin: process.env.STRATA_ORIGIN ?? raw.origin,
    adminUsage: rooms.length ? createUsageSnapshot(() => collectRooms(rooms.map((r) => ({ reader: r.key, db: join(r.dataDir, "strata.db") })))) : undefined });
}
