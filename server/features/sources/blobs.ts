import { rangeText, type ContentRange } from "../../../shared/imports/import-plan.ts";
import { DB_PATH } from "../../platform/config.ts";
import { Readable } from "node:stream";
import { blobCacheBeside } from "./blob-cache.ts";
import { SECTION_TO_END } from "../../platform/db/schema.ts";
import { sourcesRepo as q } from "./repo.ts";
import { parseJson } from "../../platform/db/sql.ts";
import type { SectionRow, ResourceRow } from "../../platform/db/rows.ts";

// Fallback when countTokens was unavailable: ~bytes/27 (calibrated on a real PDF), never loading the file.
const PDF_TOKENS_PER_BYTE = 1 / 27;
export function estTokens(r: ResourceRow): number {
  if (typeof r.tokens === "number" && r.tokens > 0) return r.tokens;
  if (r.text) return Math.ceil(r.text.length / 4);
  if (r.bytes_len) return Math.ceil(r.bytes_len * PDF_TOKENS_PER_BYTE);
  return 0;
}

export const bytesOf = (rid: string): Buffer | null => {
  const row = q.blobOf.get(rid) as { bytes: Uint8Array | null } | undefined;
  return row?.bytes ? Buffer.from(row.bytes) : null;
};
// substr() is 1-based, hence the +1.
export const sliceOf = (rid: string, start: number, len: number): Buffer | null => {
  const row = q.blobSlice.get(start + 1, len, rid) as { chunk: Uint8Array | null } | undefined;
  return row?.chunk ? Buffer.from(row.chunk) : null;
};
export const rawCache = blobCacheBeside(DB_PATH);
const sweepRaw = (): void => { try { rawCache.sweep((rid) => !!q.blobExists.get(rid)); } catch { /* next time */ } };
setTimeout(sweepRaw, 60_000).unref();
setInterval(sweepRaw, 864e5).unref();
export function rawOpen(rid: string, len: number, start: number, end: number): Readable | null {
  const cached = rawCache.open(rid, len, start, end);
  if (cached) return cached;
  const bytes = (q.blobOf.get(rid) as { bytes: Uint8Array | null } | undefined)?.bytes;
  if (!bytes || bytes.byteLength !== len) return null;
  rawCache.keep(rid, bytes);
  return Readable.from([Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start + 1)]);
}
export const pagesOf = (rid: string): string[] =>
  parseJson<string[]>((q.pageTextOf.get(rid) as { page_text: string | null } | undefined)?.page_text ?? null, []);

export const kindOf = (r: Pick<ResourceRow, "kind" | "mime" | "filename">): string =>
  r.kind ?? (((r.mime ?? "").includes("pdf") || (r.filename ?? "").toLowerCase().endsWith(".pdf")) ? "pdf" : "text");
export const isPdf = (r: ResourceRow): boolean => kindOf(r) === "pdf";

export const sectionsCount = (rid: string): number => (q.sectionsOf.all(rid) as SectionRow[]).length;

export function sourceOfResource(r: ResourceRow): { text?: string; file?: { mimeType: string; data: string } } {
  const bytes = r.bytes_len ? bytesOf(r.id) : null;
  if (isPdf(r) && bytes) return { file: { mimeType: r.mime ?? "application/pdf", data: bytes.toString("base64") } };
  const text = r.text ?? (bytes ? bytes.toString("utf-8") : "");
  return { text };
}

// A divided source is sent as labelled page text: the server has no PDF library to cut the file.
export function sectionSource(r: ResourceRow, s: SectionRow, total: number): { text?: string; file?: { mimeType: string; data: string } } {
  if (s.content_ranges) {
    const pages = pagesOf(r.id);
    const ranges = JSON.parse(s.content_ranges) as ContentRange[];
    if (!pages.length) throw new Error("The selected source text is missing; re-import the PDF.");
    return {text:`${s.label}\n\n${rangeText(ranges,pages)}`};
  }
  if (total <= 1) return sourceOfResource(r);
  const pages = pagesOf(r.id);
  if (!pages.length) return sourceOfResource(r);   // no extraction (old row) → whole file
  const last = s.last_page === SECTION_TO_END ? pages.length : Math.min(s.last_page, pages.length);
  const body = pages.slice(Math.max(0, s.first_page - 1), last)
    .map((t, i) => `[page ${s.first_page + i}]\n${t}`)
    .join("\n\n");
  return { text: `${s.label}\n(pages ${s.first_page}–${last} of ${r.filename ?? "the source"})\n\n${body}` };
}
