import { compileImportPlan, type ImportHeading, type ImportPlan, type StudyUnit } from "../../../shared/imports/import-plan.ts";

import { extname } from "node:path";
import { countGeminiTokens } from "../../platform/llm/gemini.ts";
import { db } from "../../platform/db/db.ts";
import { SECTION_TO_END } from "../../platform/db/schema.ts";
import { tx } from "../../platform/db/tx.ts";
import { q } from "../repo.ts";
import { now, genId } from "../../platform/db/sql.ts";
import type { SectionRow } from "../../platform/db/rows.ts";
import { classifyThenQueue } from "../distil/queue.ts";
import { sourceTokens, studyTokens } from "../../../shared/imports/budget.ts";
import { httpError } from "../../platform/http/http.ts";
import { BUDGET_TOKENS, MIN_SECTION_WORDS } from "../../platform/config.ts";
import { batchSections } from "../../../shared/reading/sections.ts";
import { htmlTwin, rendersAsPage } from "../../../shared/reading/html-twin.ts";

export function sourceFor(filename: string, base64?: string, text?: string): { text?: string; file?: { mimeType: string; data: string } } {
  if (text && text.trim()) return { text };
  if (!base64) return {};
  const data = base64.includes(",") ? base64.split(",").pop()! : base64;
  if (extname(filename).toLowerCase() === ".pdf") return { file: { mimeType: "application/pdf", data } };
  return { text: Buffer.from(data, "base64").toString("utf-8") }; // md / txt / other
}

// Every HTML file keeps its bytes, so how it shows can change without a re-upload; its text twin is what everything else reads.
export function htmlSource(filename: string, html: string): Pick<SourceInput, "kind" | "text" | "data" | "mime"> | null {
  if (!/\.html?$/i.test(filename)) return null;
  return { kind: rendersAsPage(html) ? "html" : "text", text: htmlTwin(html), data: Buffer.from(html, "utf-8").toString("base64"), mime: "text/html" };
}

export interface IncomingSection { label: string; firstPage: number; lastPage: number }

// Sections come only from the author's bookmarks; small adjacent ones are batched, never invented.
export function insertSections(boardId: string, rid: string, filename: string, incoming?: IncomingSection[], pageText?: string[], wholeTokens?: number | null, selected?: StudyUnit[]): number {
  const clean = (incoming ?? [])
    .map((s) => ({ label: String(s.label ?? "").trim().slice(0, 200), firstPage: Math.max(1, Math.floor(Number(s.firstPage) || 1)), lastPage: Math.max(0, Math.floor(Number(s.lastPage) || 0)) }))
    .filter((s) => s.label)
    .sort((a, b) => a.firstPage - b.firstPage);
  const batched = batchSections(clean, pageText, MIN_SECTION_WORDS);
  const divided = batched.length > 1;
  const rows = selected ?? (divided ? batched : [{ label: filename || "the whole source", firstPage: 1, lastPage: SECTION_TO_END }]);
  rows.forEach((s, i) => {
    let tokens = wholeTokens ?? 0;
    if ((divided || selected) && pageText?.length) {
      const last = s.lastPage === SECTION_TO_END ? pageText.length : Math.min(s.lastPage, pageText.length);
      const chars = selected ? selected[i].ranges.reduce((n,r) => n + r.end-r.start + 12,0) : pageText.slice(Math.max(0, s.firstPage - 1), last).reduce((a, t) => a + t.length + 12, 0);
      tokens = Math.ceil(chars / 4);
    }
    const sid = "s" + genId();
    q.insSection.run(sid, rid, boardId, i, s.label, s.firstPage, s.lastPage, now(), tokens);
    if (selected) q.setSectionRanges.run(JSON.stringify(selected[i].ranges),sid);
  });
  return rows.length;
}

export interface SourceInput { filename: string; kind: string; text?: string; data?: string; mime?: string; originUrl?: string | null; sections?: IncomingSection[]; pageText?: string[]; importPlan?: unknown; outline?: ImportHeading[]; createPair?: boolean; importId?: string; tokens?: number | null; study?: boolean }

export interface PreparedSource { rid: string; input: SourceInput; selected?: StudyUnit[]; tokens: number | null; pageText: string | null; bytes: Buffer | null }

// Two halves because a write that awaits cannot sit in a transaction: prepare awaits, write commits.
export async function prepareSource(r: SourceInput): Promise<PreparedSource> {
  const selected = r.importPlan === undefined ? undefined : compileImportPlan(r.importPlan,r.pageText ?? []);
  const rid = r.importId ? `res-${r.importId}` : genId("res-");
  const tokens = r.tokens !== undefined ? r.tokens : await countGeminiTokens(r.data && r.kind === "pdf" ? { files: [{ mimeType: r.mime ?? "application/pdf", data: r.data }] } : { text: r.text ?? "" });
  const total = sourceTokens({ tokens, text: r.text, bytes: r.data && r.kind === "pdf" ? Buffer.byteLength(r.data, "base64") : 0, pages: r.pageText });
  if (total > BUDGET_TOKENS && !selected) {
    throw httpError(428, `This source exceeds the ${BUDGET_TOKENS.toLocaleString("en-US")}-token budget. Confirm smaller study groups before distilling.`);
  }
  if (selected?.some(unit => studyTokens(unit, r.pageText ?? []) > BUDGET_TOKENS)) {
    throw httpError(400, "A study group exceeds the token budget. Split it or exclude more material.");
  }
  const pageText = r.pageText?.length ? JSON.stringify(r.pageText) : null;
  const bytes = r.data ? Buffer.from(r.data, "base64") : null;
  return { rid, input: r, selected, tokens, pageText, bytes };
}

export function writeSource(boardId: string, p: PreparedSource, ssn?: string | null): string {
  const { rid, input: r, tokens, pageText, bytes, selected } = p;
  if (!q.board.get(boardId)) throw httpError(404, "The destination board was deleted while the source was being prepared.");
  tx(() => {
    q.insResource.run(rid, boardId, r.filename, r.mime ?? "text/plain", r.text ?? null, tokens, now(), r.kind, r.originUrl ?? null, bytes ? bytes.length : null);
    if (bytes || pageText) q.insBlob.run(rid, bytes, pageText);
    const outline = r.outline ?? (selected ? (r.importPlan as ImportPlan).outline : undefined);
    if (outline && pageText) q.setOutline.run(JSON.stringify(outline), rid);
    const count = insertSections(boardId, rid, r.filename, r.sections, r.pageText, tokens, selected);
    if (r.createPair !== false || count > 1) pairForResource(boardId, r.filename.replace(/\.[^.]+$/, ""), rid);
    if (r.study === false) for (const s of q.sectionsOf.all(rid)) q.upsertTree.run(s.id, rid, boardId, s.label, "", null, null, "unstudied", null, 0, now());
    if (r.importId) finishImport(r.importId, rid);
  });
  // Queued, never awaited: the upload must not wait minutes for a distil.
  if (r.study !== false) classifyThenQueue(boardId, rid, r.filename.replace(/\.[^.]+$/, ""), ssn ?? null, "arrival");
  return rid;
}

function finishImport(importId: string, rid: string): void {
  const saved = db.prepare("UPDATE imports SET stage='imported',resource_id=?,prepared=NULL,plan=NULL,error=NULL,updated_at=? WHERE id=? AND stage='finalizing'").run(rid,now(),importId);
  if (!saved.changes) throw httpError(409,"Import was cancelled.");
  db.prepare('DELETE FROM import_chunks WHERE import_id=?').run(importId);
}

/** The source an import revises in place: the last one imported under the same ref, when neither side is a PDF. */
export function revisedBy(boardId: string, importId: string, ref: string | null, filename: string): string | null {
  if (!ref || /\.pdf$/i.test(filename)) return null;
  const prior = q.sourceOfRef.get(boardId, ref, importId);
  return prior && prior.kind !== "pdf" ? prior.resource_id : null;
}

/** Where a highlight's words sit in the revised text: the occurrence nearest where they were, or an empty range when they are gone. */
export function reanchor(was: string, next: string, start: number, end: number): [number, number] {
  const words = was.slice(start, end);
  if (!words) return [start, end];
  let best = -1;
  for (let at = next.indexOf(words); at >= 0; at = next.indexOf(words, at + 1)) {
    if (best < 0 || Math.abs(at - start) < Math.abs(best - start)) best = at;
  }
  return best < 0 ? [0, 0] : [best, best + words.length];
}

// One source, its bytes swapped: highlights follow their words, and cards already made stay.
export function reviseSource(boardId: string, rid: string, p: PreparedSource): boolean {
  const { input: r, tokens, bytes } = p;
  return tx(() => {
    const was = q.resource.get(boardId, rid);
    if (!was) throw httpError(404, "The source this revises was removed.");
    // bytes can land out of order; a revision asked for earlier never overwrites a later one
    if (r.importId && q.newerRevision.get(rid, r.importId)) {
      q.dropStaleRevision.run("A later revision of this file had already landed.", now(), r.importId);
      q.dropImportChunks.run(r.importId);
      return false;
    }
    q.reviseResource.run(r.mime ?? "text/plain", r.text ?? null, tokens, r.kind, bytes ? bytes.length : null, boardId, rid);
    // prose marks are offsets into the text; a live page finds its marks by quote itself
    if (was.kind !== "html" && r.kind !== "html" && was.text != null) {
      for (const m of q.marksOfResource.all(rid)) q.setMarkOffsets.run(...reanchor(was.text, r.text ?? "", m.start_off, m.end_off), m.id);
    }
    if (bytes) q.insBlob.run(rid, bytes, null); else q.delBlob.run(rid);
    q.dropImportsOf.run(rid);
    if (r.importId) finishImport(r.importId, rid);
    return true;
  });
}

export async function insertResource(boardId: string, r: SourceInput, ssn?: string | null): Promise<string> {
  return writeSource(boardId, await prepareSource(r), ssn);
}

export function pairForResource(boardId: string, label: string, resourceId: string): string {
  const sections = q.sectionsOf.all(resourceId) as SectionRow[];
  const base = label.slice(0, 160) || "untitled";
  let first = "";
  for (const s of sections) {
    const existing = q.pairsOf.all(boardId).find(p => p.section_id === s.id && p.resource_id === resourceId);
    if (existing) { if (!first) first = existing.id; continue; }
    const pid = genId("pr-");
    const name = sections.length > 1 ? `${base} · ${s.label}`.slice(0, 200) : base;
    q.insPair.run(pid, boardId, name, resourceId, null, (q.nextOrd.get(boardId) as { n: number }).n, s.id);
    if (!first) first = pid;
  }
  return first;
}
