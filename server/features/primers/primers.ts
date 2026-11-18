// A primer: a page the reader's agent writes to show a source's shape before it is read; set_primer lands it.
import { now } from "../../platform/db/sql.ts";
import type { PrimerMeta } from "../../../shared/types/index.ts";
import { primersRepo as p, type PrimerRow } from "./repo.ts";

export const PRIMER_MAX = 500_000;
/** How many sources one press of "Primers for this board" asks for. */
export const BOARD_BATCH = 10;

/** Why this is not a page the primer panel can show, or null. */
export function primerProblem(html: unknown): string | null {
  if (typeof html !== "string" || !html.trim()) return "html is the whole page, as one string.";
  if (html.length > PRIMER_MAX) return `html is ${html.length} characters; a primer is at most ${PRIMER_MAX}.`;
  if (!/^\s*(<!--[\s\S]*?-->\s*)*<!doctype html\b/i.test(html)) return "html is a complete document: it starts with <!doctype html>.";
  if (!/<html[\s>]/i.test(html) || !/<\/html>\s*$/i.test(html)) return "html is a complete document: one <html> element, ending with </html>.";
  if (!/<body[\s>]/i.test(html)) return "html is a complete document with a <body>.";
  return null;
}

export const primerMeta = (r: PrimerRow): PrimerMeta => ({ status: r.status, requestedAt: r.requested_at, builtAt: r.built_at });
export const primersOfBoard = (boardId: string): Map<string, PrimerMeta> => new Map(p.primersOf.all(boardId).map((r) => [r.resource_id, primerMeta(r)]));

/** Inside a commit. True when this asked for one; a primer already asked for is left as it was. */
export const requestPrimer = (boardId: string, rid: string): boolean => p.request.run(rid, boardId, now()).changes > 0;

/** Inside a commit: up to BOARD_BATCH of the board's sources that have no primer, oldest first. */
export function requestBoard(boardId: string): { asked: number; left: number } {
  const todo = p.unprimed.all(boardId, BOARD_BATCH);
  for (const r of todo) requestPrimer(boardId, r.id);
  return { asked: todo.length, left: p.unprimedCount.get(boardId)?.n ?? 0 };
}

/** Inside a commit: the page is the source's primer now, whatever was asked. */
export function putPrimer(boardId: string, rid: string, html: string): void {
  p.put.run(rid, boardId, html, Buffer.byteLength(html, "utf8"), now());
}

/** A source revised in place: its primer described the old text, so it says so until it is rebuilt. */
export const stalePrimer = (rid: string): void => { p.stale.run(rid); };

export const primerPage = (boardId: string, rid: string): string | null => p.primerPage.get(boardId, rid)?.html ?? null;

// The panel follows [data-page] links in the page by asking the reader to turn there; nothing else crosses.
export const PRIMER_LINKS = `<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("[data-page]");if(!a)return;var n=parseInt(a.getAttribute("data-page"),10);if(!(n>0))return;e.preventDefault();parent.postMessage({strataPrimer:{page:n}},"*")},true);</script>`;
