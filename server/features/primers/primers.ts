// A primer: an optional HTML overview of one source, written by the reader's routine and read before page 1.
import { now } from "../../platform/db/sql.ts";
import { primersRepo as p, type PrimerStatus } from "./repo.ts";

export const PRIMER_MAX_BYTES = 2 * 1024 * 1024;

export interface PrimerView { status: PrimerStatus | "none"; requestedAt: number | null; builtAt: number | null; hasPage: boolean; rev: number }

export function primerView(rid: string): PrimerView {
  const r = p.primer.get(rid);
  return r ? { status: r.status, requestedAt: r.requested_at, builtAt: r.built_at, hasPage: !!r.has_html, rev: r.rev }
    : { status: "none", requestedAt: null, builtAt: null, hasPage: false, rev: 0 };
}

/** Asks the routine for one; a ready or stale page stays up until the new one lands. */
export function requestPrimer(boardId: string, rid: string): void { p.requestPrimer.run(rid, boardId, now()); }

export function writePrimer(boardId: string, rid: string, html: string): void { p.putPrimer.run(rid, boardId, html, now()); }

/** The source's words changed under its primer: it still shows, marked as written for the old ones. */
export function stalePrimer(rid: string): void { p.stalePrimer.run(rid); }

export function dropPrimer(rid: string): void { p.delPrimer.run(rid); }
export function dropBoardPrimers(boardId: string): void { p.delBoardPrimers.run(boardId); }

export const primerHtml = (boardId: string, rid: string): string | null => p.primerHtml.get(boardId, rid)?.html ?? null;
export const primersOf = (boardId: string) => p.primersOf.all(boardId);

/** An agent's upload asked for one: it is requested once the source lands. */
export const askOnImport = (importId: string): void => { p.setImportPrimer.run(importId); };
