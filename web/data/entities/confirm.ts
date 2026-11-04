import type { BoardState, Card, Mark } from "../../../shared/types/index.ts";
import type { Store } from "../store.ts";
import { applyBoardState, marksKey, planKey, revOf, type PlanEntity } from "./boards.ts";

// Confirms an op by its answer's shape; each body's own rev orders its key, and meta.rev is the stamp.

export interface ConfirmMeta { rev: number; epoch: string }

const isState = (v: unknown): v is BoardState =>
  !!v && typeof v === "object" && typeof (v as BoardState).board?.id === "string";
const named = (path: string, kind: "boards" | "decks"): string | undefined => {
  const m = new RegExp(`^/api/${kind}/([^/?]+)`).exec(path);
  return m ? decodeURIComponent(m[1]) : undefined;
};
/** DELETE â€¦/messages?resource=r answers r's thread, empty; elsewhere the page names its thread. */
const threadOf = (path: string): string | null | undefined => {
  const url = new URL(path, "http://strata.invalid");
  return /^\/api\/boards\/[^/]+\/messages$/.test(url.pathname) ? url.searchParams.get("resource") || null : undefined;
};

export function upsertRow<T extends { id: string }>(list: T[] | undefined, row: T): T[] {
  const rows = list ?? [];
  const at = rows.findIndex((r) => r.id === row.id);
  if (at < 0) return [...rows, row];
  const next = rows.slice();
  next[at] = row;
  return next;
}

export function confirmByShape(op: { path: string }, body: unknown, meta: ConfirmMeta, s: Store): void {
  if (!body || typeof body !== "object") return;
  const b = body as { state?: unknown; destState?: unknown; plan?: PlanEntity; mark?: Mark; card?: Card; ids?: unknown; rev?: unknown };
  const at = { epoch: meta.epoch, stamp: meta.rev };
  const board = named(op.path, "boards");
  const slug = named(op.path, "decks");
  const rev = revOf(b.rev);
  s.batch(() => {
    if (isState(b.state)) applyBoardState(b.state, { ...at, thread: threadOf(op.path) }, s);
    if (isState(b.destState)) applyBoardState(b.destState, at, s);
    if (b.plan && typeof b.plan === "object" && board) s.apply<PlanEntity>(planKey(board), rev, { ...b.plan, rev: revOf(b.plan.rev) }, "wire", at);
    if (b.mark && typeof b.mark.id === "string" && board) s.patch<Mark[]>(marksKey(board), rev, (list) => upsertRow(list, b.mark!), at);
    if (b.card && typeof b.card.id === "string") s.apply(`card:${b.card.id}`, rev, b.card, "wire", at);
    if (Array.isArray(b.ids) && slug) s.apply(`keeps:${slug}`, rev, { ids: b.ids as string[] }, "wire", at);
  });
}
