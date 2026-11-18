// A source's primer: an overview page the reader's routine writes, read before page 1. Asking queues it and wakes the routine.
import { now } from "../../platform/db/sql.ts";
import { recordRun, wake } from "../dashboard/routine.ts";
import { primersRepo as p, type PrimerRow } from "./repo.ts";

export class PrimerError extends Error { httpStatus = 400; }
const fail = (msg: string): never => { throw new PrimerError(msg); };

export const PRIMER_MAX_BYTES = 512 * 1024;
export const BOARD_BATCH = 10;
export type PrimerStatus = "none" | "requested" | "ready" | "stale";
export interface PrimerView { status: PrimerStatus; requestedAt: number | null; builtAt: number | null; rev: number }

export const isDispatch = (boardId: string): boolean => p.boardHandle.get(boardId)?.handle === "dispatch";

export function primerView(rid: string): PrimerView {
  const r: PrimerRow | undefined = p.primer.get(rid);
  return r ? { status: r.status as PrimerStatus, requestedAt: r.requested_at, builtAt: r.built_at, rev: r.rev } : { status: "none", requestedAt: null, builtAt: null, rev: 0 };
}

/** Why a page can't be a primer, or null: one self-contained HTML document within the size limit. */
export function primerProblem(html: unknown): string | null {
  if (typeof html !== "string" || !html.trim()) return "html is the primer's whole HTML document.";
  if (Buffer.byteLength(html) > PRIMER_MAX_BYTES) return `html is at most ${PRIMER_MAX_BYTES / 1024} KB.`;
  const doc = html.replace(/<!--[\s\S]*?-->/g, "");
  if (!/^\s*(<!doctype html[^>]*>\s*)?<html[\s>]/i.test(doc) || !/<\/html>\s*$/i.test(doc)) return "html is one whole document, <!doctype html><html>…</html>.";
  if ((doc.match(/<html[\s>]/gi) ?? []).length !== 1) return "html is a single document: one <html> element.";
  if (/<(script|img|iframe|source|video|audio)\b[^>]*\bsrc\s*=\s*["']?\s*(?!https:|data:|blob:)[^\s"'>]/i.test(doc)) return "load scripts and media only from https:, or inline them; the page has no files beside it.";
  if (/<link\b[^>]*\bhref\s*=\s*["']?\s*(?!https:|data:)[^\s"'>]/i.test(doc)) return "load stylesheets and fonts only from https:, or inline them; the page has no files beside it.";
  return null;
}

/** Queues a primer for a source; true when this asked for a new one (none yet, or a stale one). Runs inside a commit. */
export function requestPrimer(boardId: string, rid: string): boolean {
  if (isDispatch(boardId)) fail("Dispatch pages don't get primers.");
  if (!p.sourceOn.get(boardId, rid)) fail("No such source on this board.");
  return p.request.run(rid, boardId, now()).changes > 0;
}

/** Every source on the board that lacks a primer, up to BOARD_BATCH; returns the ids queued. Runs inside a commit. */
export function requestBoardPrimers(boardId: string): string[] {
  if (isDispatch(boardId)) fail("Dispatch pages don't get primers.");
  return p.lacking.all(boardId, BOARD_BATCH).filter((r) => p.request.run(r.id, boardId, now()).changes > 0).map((r) => r.id);
}

export const lackingCount = (boardId: string): number => isDispatch(boardId) ? 0 : p.lacking.all(boardId, BOARD_BATCH).length;

/** Stores a written primer as ready. Runs inside a commit. */
export function setPrimer(boardId: string, rid: string, html: string): void {
  if (isDispatch(boardId)) fail("Dispatch pages don't get primers.");
  if (!p.sourceOn.get(boardId, rid)) fail("No such source on this board.");
  const why = primerProblem(html);
  if (why) fail(why);
  p.setReady.run(rid, boardId, html, now());
}

/** A source's text changed in place: its primer no longer describes it, until the reader asks again. */
export const markPrimerStale = (rid: string): void => { p.markStale.run(rid); };

export const primerHtml = (boardId: string, rid: string): string | null => p.primerHtml.get(boardId, rid)?.html ?? null;
export const waitingByBoard = (): Map<string, number> => new Map(p.waitingByBoard.all().map((r) => [r.board_id, r.n]));

let waking: Promise<void> | null = null;
/** Wakes the routine without holding the caller: a primer is written minutes later, so no answer waits on the fire. */
export function nudgeRoutine(why: string): void {
  // one fire in flight at a time; the routine's own minute between runs covers the rest
  if (waking) return;
  waking = wake(why).then((w) => { if (w.ran) recordRun(w.ran); }, (e: unknown) => { console.error("[primer] couldn't wake the routine:", e); })
    .finally(() => { waking = null; });
}
