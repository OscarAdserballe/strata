import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { now } from "../../platform/db/sql.ts";
import { IMAGE_MAX_BYTES } from "../../../shared/images/ref.ts";
import { imagesRepo } from "./repo.ts";
import { imageIdOf, refusal } from "./images.ts";
import { sniffImage } from "./sniff.ts";

// base64 is 4/3 of the bytes, and the JSON around it is a few dozen more
const MAX_BODY = Math.ceil(IMAGE_MAX_BYTES * 4 / 3) + 1024;

export const imageRoutes: Route[] = [
  route("POST", "/api/images", async ({ res, body, commit }) => {
    const b = await body<{ data?: unknown }>(MAX_BODY);
    if (typeof b.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) { sendJson(res, 400, { error: "send the image as base64 `data`" }); return; }
    const bytes = new Uint8Array(Buffer.from(b.data, "base64"));
    const sniffed = sniffImage(bytes);
    const why = refusal(bytes, sniffed);
    if (why || !sniffed) { sendJson(res, why?.includes(" over ") ? 413 : 415, { error: why }); return; }
    // The server hashes: over plain http the client has no crypto.subtle.
    const id = imageIdOf(bytes);
    commit(() => {
      imagesRepo.insImage.run(id, sniffed.mime, sniffed.w, sniffed.h, bytes.length, bytes, now());
      return { status: 200, body: { image: { id, mime: sniffed.mime, w: sniffed.w, h: sniffed.h, size: bytes.length } } };
    });
  }, { receipt: "atomic", maxBody: MAX_BODY }),

  route("GET", /^\/api\/images\/([0-9a-f]{16})$/, ({ req, res, params }) => {
    const id = params[0];
    const tag = `"img-${id}"`;
    const headers: Record<string, string> = {
      ETag: tag,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    };
    // the bytes behind an id never change: a device that has them is told so, and nothing is read
    const inm = req.headers["if-none-match"];
    if (inm && inm.split(",").some((t) => t.trim() === tag)) { res.writeHead(304, headers); res.end(); return; }
    const row = imagesRepo.imageBytes.get(id);
    if (!row) { sendJson(res, 404, { error: "no such image" }); return; }
    res.writeHead(200, { ...headers, "Content-Type": row.mime, "Content-Length": String(row.bytes.length) });
    res.end(Buffer.from(row.bytes));
  }),
];
