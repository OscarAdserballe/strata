import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, relative, isAbsolute } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { APP_DIR, BASE_PATH, MAX_BODY_BYTES, MAX_UPLOAD_BYTES } from "../config.ts";
import { sendEncoded } from "./encoding.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".pdf": "application/pdf",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".wasm": "application/wasm",
};

// The build stamp hashes the client files' mtimes and sizes, so a deploy moves it without a restart.
const CLIENT_FILES = [
  "public/index.html", "public/sw.js", "public/pdf.worker.min.js",
  "dist/main.js", "dist/main.css",
];
const stampCache = { v: "", at: 0 };
export async function buildStamp(): Promise<string> {
  if (Date.now() - stampCache.at < 3000) return stampCache.v;
  const parts = await Promise.all(CLIENT_FILES.map(async (f) => {
    try { const s = await stat(join(APP_DIR, f)); return `${f}:${Math.round(s.mtimeMs)}:${s.size}`; }
    catch { return f; }
  }));
  stampCache.v = createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);
  stampCache.at = Date.now();
  return stampCache.v;
}

// The build lists what the page should preload (tools/build.mjs); the tags are rendered once per stamp.
const preloadCache = { stamp: "", tags: "" };
async function preloadTags(stamp: string): Promise<string> {
  if (preloadCache.stamp === stamp) return preloadCache.tags;
  let tags = "";
  try {
    const { modules = [], fonts = [] } = JSON.parse(await readFile(join(APP_DIR, "dist/boot-preload.json"), "utf-8")) as { modules?: string[]; fonts?: string[] };
    tags = [
      ...modules.map((m) => `<link rel="modulepreload" href="${m}" />`),
      ...fonts.map((f) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="${f}" />`),
    ].join("\n");
  } catch { /* no build manifest: the page loads as before */ }
  preloadCache.stamp = stamp; preloadCache.tags = tags;
  return tags;
}

// Immutable only under a URL that can never mean other bytes: the current stamp, a hashed chunk, a hashed font.
const IMMUTABLE = "public, max-age=31536000, immutable";
export function cachingFor(rel: string, stamp: string | null, current: string): string {
  if (/^dist\/chunks\/.+-[A-Z0-9]{8}\.js$/i.test(rel) || /^dist\/[^/]+\.woff2$/.test(rel)) return IMMUTABLE;
  if (stamp && stamp === current && rel.startsWith("dist/")) return IMMUTABLE;
  return "no-cache";
}

// X-Strata-Epoch changes per boot: a restored backup moves revs backwards, so never compare across it.
export const EPOCH = randomBytes(8).toString("hex");
let readRev: (() => number) | null = null;
const revisioned = new WeakSet<ServerResponse>();
export const readRevisionWith = (read: () => number): void => { readRev = read; };
export const carriesRevision = (res: ServerResponse): void => { revisioned.add(res); };
function revisionHeaders(res: ServerResponse, headers: Record<string, string>): Record<string, string> {
  if (readRev && revisioned.has(res)) { headers["X-Strata-Rev"] = String(readRev()); headers["X-Strata-Epoch"] = EPOCH; }
  return headers;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (stampCache.v) headers["X-Strata-Build"] = stampCache.v;
  if (Date.now() - stampCache.at >= 3000) void buildStamp().catch(() => {});
  sendEncoded(res,status,JSON.stringify(body),revisionHeaders(res, headers));
}

export function sseOpen(res: ServerResponse): (ev: string, data: unknown) => void {
  res.writeHead(200, revisionHeaders(res, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" }));
  res.write(": keep-alive\n\n"); // nudge proxies to not buffer
  return (ev, data) => { if (!res.writableEnded) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
}

export const humanBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;

export const httpError = (status: number, message: string): Error & { httpStatus: number } =>
  Object.assign(new Error(message), { httpStatus: status });

// Over the cap: reject with a 413 and drain the rest, rather than destroying a socket the client can't read.
export const bodyTooBig = (maxBytes = MAX_BODY_BYTES): Error & { httpStatus: number } => httpError(413, maxBytes === MAX_BODY_BYTES
  ? `that is bigger than this server takes — a file may be up to ${humanBytes(MAX_UPLOAD_BYTES)} (${humanBytes(MAX_BODY_BYTES)} on the wire, once it is base64'd)`
  : `that request is bigger than this endpoint takes (${humanBytes(maxBytes)})`);

export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > maxBytes) {
        over = true;
        reject(bodyTooBig(maxBytes));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks).toString("utf-8")); });
    req.on("error", reject);
  });
}

// Resource bytes never change (a new upload is a new id), so they are immutable; ranges let pdf.js stream.
export const etagOf = (id: string, len: number, at: number, gen = 0): string => `"${id}-${len}-${at.toString(36)}${gen ? `-${gen}` : ""}"`;

// Headers are ASCII: an ASCII `filename` fallback plus the real name under `filename*` (RFC 6266).
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/[";\\]/g, "");
  // encodeURIComponent leaves '()* alone; RFC 5987 wants them encoded too
  const starred = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${starred}`;
}

// Takes a length and a slice reader, not the bytes, so a 304 or a range never loads the whole file.
export function sendRanged(
  req: IncomingMessage, res: ServerResponse,
  o: {
    len: number; tag: string; type: string; disposition?: string;
    read: (start: number, len: number) => Buffer | null;
    open?: (start: number, end: number) => Readable | null;
  },
): void {
  const body = (start: number, end: number): void => {
    if (end < start) { res.end(); return; }
    const stream = o.open?.(start, end);
    if (!stream) { res.end(o.read(start, end - start + 1) ?? undefined); return; }
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  };
  const base: Record<string, string> = {
    "Content-Type": o.type,
    ETag: o.tag,
    "Cache-Control": "private, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
  };
  if (o.disposition) base["Content-Disposition"] = o.disposition;

  const inm = req.headers["if-none-match"];
  if (inm && inm.split(",").some((t) => t.trim() === o.tag)) { res.writeHead(304, base); res.end(); return; }

  // Only single ranges, which is all pdf.js asks for; anything else gets the whole file.
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (m && !(m[1] === "" && m[2] === "")) {
    const [, rawStart, rawEnd] = m;
    const start = rawStart === "" ? Math.max(0, o.len - Number(rawEnd)) : Number(rawStart);
    const end = rawStart === "" ? o.len - 1 : (rawEnd === "" ? o.len - 1 : Math.min(Number(rawEnd), o.len - 1));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= o.len) {
      res.writeHead(416, { ...base, "Content-Range": `bytes */${o.len}` }); res.end(); return;
    }
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${o.len}`, "Content-Length": String(end - start + 1) });
    if (req.method === "HEAD") { res.end(); return; }
    body(start, end); return;
  }

  res.writeHead(200, { ...base, "Content-Length": String(o.len) });
  if (req.method === "HEAD") { res.end(); return; }
  body(0, o.len - 1);
}


const PUBLIC_FILES = new Set([
  "index.html", "sw.js", "pdf.worker.min.js", "manifest.json",
  "apple-touch-icon.png", "icon-512.png", "dashboard.html",
]);
const fileFor = (rel: string): string | null => rel.startsWith("dist/") ? rel : PUBLIC_FILES.has(rel) ? `public/${rel}` : null;

export async function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string, nonce: string): Promise<void> {
  // /dispatch is the room itself, opened with the dashboard's thread pane beside the reader.
  const rel = urlPath === "/" || urlPath === "/dispatch" ? "index.html" : urlPath === "/dashboard" ? "dashboard.html" : urlPath.slice(1);
  const file = fileFor(rel);
  if (!file) { sendJson(res, 404, { error: "not found" }); return; }
  const full = normalize(join(APP_DIR, file));
  const within = relative(APP_DIR, full);
  if (within.startsWith("..") || isAbsolute(within)) { sendJson(res, 403, { error: "forbidden" }); return; }
  try {
    // `no-cache` means revalidate: without it the browser applies heuristic freshness to stale scripts.
    const type = MIME[extname(full)] ?? "application/octet-stream";
    if (type.startsWith("text/html")) {
      const stamp = await buildStamp();
      const html = (await readFile(full, "utf-8"))
        .replace("<!--STRATA_PRELOAD-->", await preloadTags(stamp))
        .replace(/\?v=[A-Za-z0-9]+/g, `?v=${stamp}`)
        .replace(/STRATA_BUILD = "dev"/, `STRATA_BUILD = "${stamp}"`)
        .replace(/STRATA_BASE = "__STRATA_BASE__"/, `STRATA_BASE = ${JSON.stringify(BASE_PATH)}`)
        .replace(/<script(?![^>]*\bsrc=)([^>]*)>/g, `<script nonce="${nonce}"$1>`);
      // The CSP nonce changes per response, so HTML gets no ETag: a 304 would pair an old nonce with a new policy.
      sendEncoded(res,200,html,{ "Content-Type": type, "Cache-Control": "no-cache" }); return;
    }
    const s = await stat(full);
    const stamp = new URL(req.url ?? "/", "http://strata").searchParams.get("v");
    const caching = cachingFor(rel, stamp, stamp ? await buildStamp() : "");
    const etag = `W/"${s.size}-${Math.round(s.mtimeMs)}"`;
    if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": caching, Vary:"Accept-Encoding" }); res.end(); return; }
    const data = await readFile(full);
    sendEncoded(res,200,data,{ "Content-Type": type, "Cache-Control": caching, ETag: etag });
  } catch { sendJson(res, 404, { error: "not found" }); }
}
