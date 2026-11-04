// Cookie name and path derive from the base path, so two rooms can share one origin.
// Lax, not Strict: a link from another app is a top-level GET, and Strict would drop the cookie on it.

import type { IncomingMessage } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BASE_PATH, DATA_DIR, TRUSTED_PROXY_IPS, externalPath } from "../config.ts";
import { envGet } from "../llm/llm.ts";
import { isHttps, isTrustedProxy } from "./security.ts";

const AUTH_CONFIG_PATH = process.env.STRATA_AUTH ?? join(DATA_DIR, "auth.json");
const instance = BASE_PATH === "/" ? "root" : BASE_PATH.replace(/[^a-z0-9]/gi, "_").replace(/^_+|_+$/g, "");
const AUTH_COOKIE = process.env.STRATA_COOKIE_NAME ?? `st_auth_${instance || "root"}`;
const sessionDays = Number(process.env.STRATA_SESSION_DAYS ?? 7);
export const AUTH_TTL_MS = Math.max(1, Math.min(Number.isFinite(sessionDays) ? sessionDays : 7, 180)) * 24 * 60 * 60 * 1000;
export const DEV_OPEN = process.env.STRATA_OPEN === "1";
export const TRUST_TAILSCALE_HEADERS = process.env.STRATA_TRUST_TAILSCALE_HEADERS === "1";
if (TRUST_TAILSCALE_HEADERS && !TRUSTED_PROXY_IPS.size) {
  throw new Error("STRATA_TRUST_TAILSCALE_HEADERS requires exact STRATA_TRUSTED_PROXY_IPS; forwarded identity is never trusted from the open network");
}

function loadAuthConfig(): { password: string; secret: string } | null {
  let raw: { password?: string; secret?: string } = {};
  try { raw = JSON.parse(readFileSync(AUTH_CONFIG_PATH, "utf-8")) as typeof raw; } catch { /* first boot */ }
  const password = envGet("STRATA_PASSWORD") ?? raw.password;
  if (!password) return null;
  if (typeof raw.secret !== "string" || raw.secret.length < 32) {
    raw.secret = randomBytes(32).toString("hex");
    mkdirSync(DATA_DIR, { recursive: true });
    // An environment/file-provided password stays out of persistent state.
    const stored = envGet("STRATA_PASSWORD") ? { secret: raw.secret } : raw;
    writeFileSync(AUTH_CONFIG_PATH, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }
  return { password, secret: raw.secret };
}
export const authConfig = loadAuthConfig();

// The password is part of the session key, so changing it invalidates every outstanding cookie.
const sessionKey = authConfig ? createHmac("sha256", authConfig.secret).update("strata-session\0").update(authConfig.password).digest() : Buffer.alloc(0);
const signExpiry = (e: number): string => createHmac("sha256", sessionKey).update(String(e)).digest("hex");

export function authCookie(req: IncomingMessage): string {
  const exp = Date.now() + AUTH_TTL_MS;
  return `${AUTH_COOKIE}=${exp}.${signExpiry(exp)}; Path=${BASE_PATH}; Max-Age=${Math.floor(AUTH_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`;
}

export function clearAuthCookie(req: IncomingMessage): string {
  return `${AUTH_COOKIE}=; Path=${BASE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`;
}

function hasValidCookie(req: IncomingMessage): boolean {
  if (!authConfig) return false;
  const m = (req.headers.cookie ?? "").match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=(\\d+)\\.([0-9a-f]+)`));
  if (!m) return false; const exp = Number(m[1]); if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = Buffer.from(signExpiry(exp)), got = Buffer.from(m[2]);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const isTailnet = (req: IncomingMessage): boolean => TRUST_TAILSCALE_HEADERS && isTrustedProxy(req) && typeof req.headers["tailscale-user-login"] === "string" && req.headers["tailscale-user-login"] !== "";
export const authorized = (req: IncomingMessage): boolean => DEV_OPEN || isTailnet(req) || hasValidCookie(req);

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_BUCKETS = 4096;
export function loginAllowed(ip: string): boolean {
  const t = Date.now(), s = loginAttempts.get(ip);
  if (s && t <= s.resetAt) { s.count++; return s.count <= 8; }
  if (s) loginAttempts.delete(ip);
  if (loginAttempts.size >= MAX_LOGIN_BUCKETS) {
    for (const [key, value] of loginAttempts) { if (t > value.resetAt || loginAttempts.size >= MAX_LOGIN_BUCKETS) loginAttempts.delete(key); else break; }
  }
  loginAttempts.set(ip, { count: 1, resetAt: t + 6e5 });
  return true;
}
export function loginSucceeded(ip: string): void { loginAttempts.delete(ip); }

export function passwordMatches(input: string): boolean { if (!authConfig) return false; const a = createHmac("sha256", authConfig.secret).update(input).digest(); const b = createHmac("sha256", authConfig.secret).update(authConfig.password).digest(); return timingSafeEqual(a, b); }

export const loginPage = (nonce: string): string => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Strata</title><style>body{background:#fbf8f2;color:#403d38;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}form{text-align:center}p{font-style:italic;color:#6c6861;font-size:18px;margin-bottom:22px}input{font:15px ui-monospace,monospace;color:#403d38;background:transparent;border:none;border-bottom:1px solid #ddd7cd;padding:6px 2px;text-align:center;outline:none;width:220px}.err{font:11px ui-monospace,monospace;letter-spacing:.08em;color:#a24f39;margin-top:16px;min-height:14px}</style></head><body><form id="f"><p>the word, first —</p><input id="p" type="password" autofocus autocomplete="current-password"><div class="err" id="e"></div></form><script nonce="${nonce}">document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const r=await fetch(${JSON.stringify(externalPath("api/login"))},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});if(r.ok)location.reload();else document.getElementById('e').textContent=r.status===429?'too many tries — wait a bit':'not the word';});</script></body></html>`;
