import type { IncomingMessage } from "node:http";
import { httpError } from "../http/http.ts";

export interface ConflictBody { error: "changed elsewhere"; conflict: { rev: number; value: unknown } }

/** Thrown inside ctx.commit, so the transaction rolls back and nothing is written. */
export class Conflict extends Error {
  readonly rev: number;
  readonly value: unknown;
  constructor(rev: number, value: unknown) { super("changed elsewhere"); this.rev = rev; this.value = value; }
  get body(): ConflictBody { return { error: "changed elsewhere", conflict: { rev: this.rev, value: this.value } }; }
}

export const conflictError = (rev: number, value: unknown): Conflict => new Conflict(rev, value);

const TAG = /^(?:"(\d{1,15})"|(\d{1,15}))$/;

/** A header that names no revision is a 400: ignoring it would silently turn the guard off. */
export function ifMatchOf(req: IncomingMessage): number | null {
  const raw = req.headers["if-match"];
  if (raw === undefined) return null;
  const text = (Array.isArray(raw) ? raw.join(",") : raw).trim();
  if (text === "*") return null;
  const m = TAG.exec(text);
  if (!m) throw httpError(400, `If-Match names the revision a write was based on, as "12" — not ${JSON.stringify(text.slice(0, 40))}`);
  return Number(m[1] ?? m[2]);
}

export function checkIfMatch(req: IncomingMessage, rev: number, value: () => unknown): void {
  const want = ifMatchOf(req);
  if (want !== null && want !== rev) throw conflictError(rev, value());
}
