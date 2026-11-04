import { join } from "node:path";
import { callGeminiJson, streamGemini, geminiAvailable } from "./llm/gemini.ts";

export const APP = "strata";
export const PORT = Number(process.env.STRATA_PORT ?? 8080);
export const HOST = process.env.STRATA_HOST ?? "127.0.0.1";
export const APP_DIR = join(import.meta.dirname, "..", "..");
export const DATA_DIR = process.env.STRATA_DATA ?? join(APP_DIR, "data");
export const DB_PATH = process.env.STRATA_DB ?? join(DATA_DIR, "strata.db");

// Naming the public origin decides which Origin may write and whether the auth cookie must be Secure.
function origin(name: string): URL | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${name} must be an absolute http(s) origin`); }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
    throw new Error(`${name} must be an origin such as https://sharing.example.com (no path)`);
  }
  return u;
}
export const PUBLIC_ORIGIN = origin("STRATA_ORIGIN");
export const LEGACY_ORIGINS = new Set((process.env.STRATA_LEGACY_ORIGINS ?? "").split(",")
  .map((s) => s.trim()).filter(Boolean).map((s) => {
    let u: URL;
    try { u = new URL(s); } catch { throw new Error("STRATA_LEGACY_ORIGINS entries must be absolute http(s) origins"); }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.pathname !== "/" || u.search || u.hash) {
      throw new Error("STRATA_LEGACY_ORIGINS entries must be origins with no path");
    }
    return u.origin;
  }));

// Exact proxy addresses only: trusting a private network would let another container forge forwarded headers.
export const TRUSTED_PROXY_IPS = new Set((process.env.STRATA_TRUSTED_PROXY_IPS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^::ffff:/, "")));

const rawBase = (process.env.STRATA_BASE_PATH ?? "/").trim();
export const BASE_PATH = rawBase === "/" || rawBase === "" ? "/" : `/${rawBase.replace(/^\/+|\/+$/g, "")}/`;
export const LEGACY_BASE_PATHS = (process.env.STRATA_LEGACY_BASE_PATHS ?? "").split(",")
  .map((s) => s.trim()).filter(Boolean).map((s) => `/${s.replace(/^\/+|\/+$/g, "")}/`)
  .filter((s) => s !== BASE_PATH);
export const externalPath = (path: string): string =>
  BASE_PATH === "/" ? `/${path.replace(/^\/+/, "")}` : `${BASE_PATH}${path.replace(/^\/+/, "")}`;
export function internalPath(path: string): string {
  if (BASE_PATH === "/") return path;
  const bare = BASE_PATH.slice(0, -1);
  if (path === bare || path === BASE_PATH) return "/";
  return path.startsWith(BASE_PATH) ? `/${path.slice(BASE_PATH.length)}` : path;
}
// An upload is base64 plus its page text, so the body cap is derived from the file cap with 4 MiB to spare.
export const MAX_UPLOAD_BYTES = Number(process.env.STRATA_MAX_UPLOAD ?? 48 * 1024 * 1024);
export const MAX_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4 * 1024 * 1024;
// A board is one context window (no retrieval); the budget is soft: metered, never blocking a drop.
export const BUDGET_TOKENS = Number(process.env.STRATA_BUDGET_TOKENS ?? 120_000);
export const BUDGET_TEXT_CHARS = BUDGET_TOKENS * 4;
// Bookmarked spans shorter than this are batched with their neighbours at ingest.
export const MIN_SECTION_WORDS = Number(process.env.STRATA_MIN_SECTION_WORDS ?? 20_000);
export const COURSES_DIR = process.env.STRATA_COURSES ?? join(DATA_DIR, "courses");

export const deps = { geminiAvailable, callGeminiJson, streamGemini };
