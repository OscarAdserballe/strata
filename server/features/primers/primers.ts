// A primer is one page an agent draws for a source, to read before page 1. The reader asks for one; the routine writes it.
import { primersRepo as q, type PrimerRow } from "./repo.ts";

export const PRIMER_MAX = 400_000;

export type PrimerStatus = "none" | "asked" | "ready";
export interface PrimerView { status: PrimerStatus; hasPage: boolean; askedAt: number | null; builtAt: number | null; rev: number }

export function primerView(board: string, rid: string): PrimerView {
  const r: PrimerRow | undefined = q.primer.get(board, rid);
  if (!r) return { status: "none", hasPage: false, askedAt: null, builtAt: null, rev: 0 };
  return { status: r.status === "asked" ? "asked" : "ready", hasPage: !!r.has_html, askedAt: r.asked_at, builtAt: r.built_at, rev: r.rev };
}

/** Why an agent's page can't be a primer, or null. */
export function primerProblem(html: unknown): string | null {
  if (typeof html !== "string" || !html.trim()) return "html is the whole page, as a string.";
  if (html.length > PRIMER_MAX) return `A primer is at most ${PRIMER_MAX} characters; this one is ${html.length}.`;
  if (!/<(html|body|main|div|svg|section)[\s>]/i.test(html)) return "html is a whole HTML page: it needs at least a <body> or a <main>.";
  return null;
}
