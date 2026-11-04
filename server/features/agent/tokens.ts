import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { q } from "../repo.ts";
import { genId, now } from "../../platform/db/sql.ts";
import { externalPath, PUBLIC_ORIGIN } from "../../platform/config.ts";
import { clientIp } from "../../platform/security/security.ts";
import { agentRepo as a, type TokenRow } from "./repo.ts";

export type Scope = "read" | "write";
export interface Caller { id: string; name: string; scopes: Set<Scope> }

const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export function mintToken(name: string, write: boolean): { id: string; token: string } {
  const token = `stk_${randomBytes(24).toString("base64url")}`;
  const id = genId("t-");
  a.insToken.run(id, name, hashOf(token), write ? "read write" : "read", now());
  return { id, token };
}

export const listTokens = (): TokenRow[] => a.tokens.all();
export const revokeToken = (id: string): boolean => Number(a.revokeToken.run(now(), id).changes) === 1;

const failures = new Map<string, { n: number; until: number }>();
const TOUCH_EVERY_MS = 60_000;

/** null = no or bad token; "limited" = too many bad tokens from this address. */
export function callerOf(req: IncomingMessage): Caller | null | "limited" {
  const ip = clientIp(req), t = now();
  const f = failures.get(ip);
  if (f && f.until > t && f.n >= 20) return "limited";
  const m = /^Bearer\s+(stk_[A-Za-z0-9_-]{16,64})$/.exec(String(req.headers.authorization ?? ""));
  const row = m ? a.tokenByHash.get(hashOf(m[1])) : undefined;
  if (!row) {
    if (failures.size > 4096) failures.clear();
    failures.set(ip, f && f.until > t ? { n: f.n + 1, until: f.until } : { n: 1, until: t + 10 * 60_000 });
    return null;
  }
  failures.delete(ip);
  // last-used is shown to the minute, so a burst of calls writes it once
  if (!row.last_used_at || t - row.last_used_at > TOUCH_EVERY_MS) a.touchToken.run(t, row.id);
  return { id: row.id, name: row.name, scopes: new Set(row.scopes.split(" ") as Scope[]) };
}

// One secret per room, made on first use; an upload link is only as good as this key.
let secret: Buffer | null = null;
function uploadSecret(): Buffer {
  if (secret) return secret;
  const key = "agent_upload_secret";
  const held = a.setting.get(key);
  if (held) return (secret = Buffer.from(held.value, "hex"));
  const made = randomBytes(32).toString("hex");
  q.setSetting.run(key, made);
  return (secret = Buffer.from(made, "hex"));
}

export const UPLOAD_TTL_MS = 15 * 60_000;
const sign = (id: string, exp: number): string => createHmac("sha256", uploadSecret()).update(`${id}.${exp}`).digest("base64url");

export function uploadUrl(req: IncomingMessage, id: string): { url: string; expiresAt: number } {
  const exp = now() + UPLOAD_TTL_MS;
  const path = `${externalPath(`api/agent/v1/upload/${encodeURIComponent(id)}`)}?exp=${exp}&sig=${sign(id, exp)}`;
  return { url: `${publicOrigin(req)}${path}`, expiresAt: exp };
}

export function uploadAllowed(id: string, exp: string | null, sig: string | null): boolean {
  const e = Number(exp);
  if (!sig || !Number.isSafeInteger(e) || e < now()) return false;
  const want = Buffer.from(sign(id, e)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The origin the agent reached us on: the configured one, else what the proxy or the client said. */
export function publicOrigin(req: IncomingMessage): string {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN.origin;
  const first = (v: string | string[] | undefined) => String(Array.isArray(v) ? v[0] : v ?? "").split(",")[0].trim();
  const host = first(req.headers["x-forwarded-host"]) || first(req.headers.host) || "localhost";
  const proto = first(req.headers["x-forwarded-proto"]) === "https" ? "https" : "http";
  return `${proto}://${host}`;
}
