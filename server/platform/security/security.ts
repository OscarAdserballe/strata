import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { BASE_PATH, LEGACY_BASE_PATHS, LEGACY_ORIGINS, PUBLIC_ORIGIN, TRUSTED_PROXY_IPS, externalPath, internalPath } from "../config.ts";

const normIp = (ip: string | undefined): string => (ip ?? "?").replace(/^::ffff:/, "");
export const isTrustedProxy = (req: IncomingMessage): boolean => TRUSTED_PROXY_IPS.has(normIp(req.socket.remoteAddress));

const forwarded = (req: IncomingMessage, name: string): string | null => {
  if (!isTrustedProxy(req)) return null;
  const v = req.headers[name];
  return typeof v === "string" ? (v.split(",")[0]?.trim() || null) : null;
};

export function clientIp(req: IncomingMessage): string {
  const peer = normIp(req.socket.remoteAddress);
  if (!isTrustedProxy(req)) return peer;
  const chain = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => normIp(s.trim())).filter(Boolean);
  chain.push(peer);
  for (let i = chain.length - 1; i >= 0; i--) if (!TRUSTED_PROXY_IPS.has(chain[i])) return chain[i];
  return peer;
}

export const isHttps = (req: IncomingMessage): boolean =>
  PUBLIC_ORIGIN?.protocol === "https:" || forwarded(req, "x-forwarded-proto") === "https" || !!(req.socket as typeof req.socket & { encrypted?: boolean }).encrypted;

export function requestOrigin(req: IncomingMessage): string | null {
  const host = forwarded(req, "x-forwarded-host") ?? req.headers.host;
  if (!host) return null;
  const proto = forwarded(req, "x-forwarded-proto") ?? ((req.socket as typeof req.socket & { encrypted?: boolean }).encrypted ? "https" : "http");
  try { return new URL(`${proto}://${host}`).origin; } catch { return null; }
}

// Only explicitly named old origins redirect, so health checks and Host-rewriting proxies never loop.
export function canonicalLocation(req: IncomingMessage): string | null {
  const from = requestOrigin(req);
  const originMoved = !!(PUBLIC_ORIGIN && from && LEGACY_ORIGINS.has(from));
  const current = new URL(req.url ?? "/", from ?? PUBLIC_ORIGIN ?? "http://localhost");
  let pathMoved = false;
  for (const legacy of LEGACY_BASE_PATHS) {
    const bare = legacy.slice(0, -1);
    if (current.pathname === bare || current.pathname === legacy) {
      current.pathname = BASE_PATH;
      pathMoved = true;
      break;
    }
    if (current.pathname.startsWith(legacy)) {
      current.pathname = BASE_PATH + current.pathname.slice(legacy.length);
      pathMoved = true;
      break;
    }
  }
  if (!originMoved && !pathMoved) return null;
  const target = PUBLIC_ORIGIN?.origin ?? from;
  if (!target) return null;
  // A path-mount proxy may strip the room's prefix: accept both forms, and add the prefix back exactly once.
  return new URL(externalPath(internalPath(current.pathname)) + current.search, target).href;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
export function mutationOriginAllowed(req: IncomingMessage): boolean {
  if (SAFE.has(req.method ?? "GET")) return true;
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
  const raw = req.headers.origin;
  if (raw === undefined) return true; // CLI/native clients do not carry browser Origin
  if (typeof raw !== "string" || raw === "null") return false;
  let supplied: string;
  try { supplied = new URL(raw).origin; } catch { return false; }
  const expected = PUBLIC_ORIGIN?.origin ?? requestOrigin(req);
  return !!expected && supplied === expected;
}

export function responseNonce(): string { return randomBytes(18).toString("base64"); }

export function setSecurityHeaders(res: ServerResponse, nonce: string): void {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:", "font-src 'self' data:", "connect-src 'self'",
    "worker-src 'self' blob:", "media-src 'self' blob: https: http:", "object-src 'none'", "frame-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "manifest-src 'self'",
  ].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}
