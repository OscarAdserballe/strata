import type { BoardState, Budget } from "../../../shared/types/index.ts";
import { threadFor } from "../ask/turn.ts";
import { BUDGET_TOKENS } from "../../platform/config.ts";
import { buildStatesWith } from "../../platform/router/router.ts";
import { q } from "../repo.ts";
import { parseJson } from "../../platform/db/sql.ts";
import { boardRev } from "./repo.ts";
import type { MsgRow, PairRow, SectionRow, MarkRow, MintedRow } from "../../platform/db/rows.ts";
import { estTokens } from "../sources/blobs.ts";
import { resourceMeta } from "../sources/meta.ts";
import { touchedFor } from "../progress/touched.ts";
import { planOf } from "../plan/plan.ts";
import { mintedOut } from "../author/authored.ts";

export function budgetFor(boardId: string): Budget {
  const used = q.resourceSummariesOf.all(boardId).filter((r) => r.included !== 0).reduce((s, r) => s + estTokens(r), 0);
  return { usedTokens: used, targetTokens: BUDGET_TOKENS, over: used > BUDGET_TOKENS };
}

export function boardState(id: string, thread: string | null = null): BoardState | null {
  const board = q.board.get(id) as { id: string; title: string; type: string } | undefined;
  if (!board) return null;
  const messages = (q.threadPage.all(id, thread, thread, Number.MAX_SAFE_INTEGER, 100) as MsgRow[]).reverse()
    .map((m) => ({ role: m.role, text: m.text, idx: m.idx, resourceId: m.resource_id ?? null, ask: m.ask_id ?? null }));
  const deck = (q.prefs.get(id) as { deck: string | null } | undefined)?.deck ?? null;
  const pairs = (q.pairsOf.all(id) as PairRow[]).map((p) => ({ id: p.id, label: p.label ?? "", resourceId: p.resource_id, deck: p.deck, ord: p.ord, sectionId: p.section_id }));
  const log = q.notes.get(id);
  const notes = log?.text ?? "";
  const trees: BoardState["trees"] = Object.fromEntries((q.treesOf.all(id))
    .map((t) => [t.section_id, { status: t.status, cards: t.cards, error: t.error, at: t.updated_at }]));
  const sections = (q.sectionsOfBoard.all(id) as SectionRow[]).map((s) => ({
    id: s.id, resourceId: s.resource_id, ord: s.ord, label: s.label,
    firstPage: s.first_page, lastPage: s.last_page, kind: s.kind ?? "work", tokens: s.tokens ?? 0,
  }));
  const replies = new Map<string, { id: string; author: "you" | "agent"; text: string; at: number }[]>();
  for (const r of q.repliesOf.all(id)) {
    if (!replies.has(r.mark_id)) replies.set(r.mark_id, []);
    replies.get(r.mark_id)!.push({ id: r.id, author: r.author === "agent" ? "agent" : "you", text: r.text, at: r.created_at });
  }
  const marks = (q.marksOf.all(id) as MarkRow[]).map((m) => ({
    id: m.id, resourceId: m.resource_id, page: m.page,
    start: m.start_off, end: m.end_off, quote: m.quote, note: m.note,
    rects: parseJson<number[][]>(m.rects, []), box: m.box ?? null, createdAt: m.created_at,
    replies: replies.get(m.id) ?? [],
  }));
  const asks = q.asksOf.all(id).map((a) => ({
    id: a.id, resourceId: a.resource_id, page: a.page, start: a.start_off, end: a.end_off, quote: a.quote,
    rects: parseJson<number[][]>(a.rects, []), box: a.box ?? null, createdAt: a.created_at,
  }));
  const minted = (q.mintedOf.all(id) as MintedRow[]).map(mintedOut);
  const mintedEverywhere: BoardState["mintedEverywhere"] = [];
  const windowFrom: Record<string, number> = {};
  const byThread = new Map<string, typeof messages>();
  for (const m of messages) {
    const k = m.resourceId ?? "";
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k)!.push(m);
  }
  for (const [k, ms] of byThread) {
    const dropped = threadFor(ms.map((m) => ({ role: (m.role === "user" ? "user" : "model") as "user" | "model", text: m.text }))).dropped;
    windowFrom[k] = dropped > 0 ? ms[dropped].idx : 0;
  }
  const resources = resourceMeta(id);
  const usedTokens = resources.filter(r=>r.included).reduce((n,r)=>n+r.tokens,0);
  const budget = {usedTokens,targetTokens:BUDGET_TOKENS,over:usedTokens>BUDGET_TOKENS};
  // Read in the same synchronous pass, so the rev describes exactly this body.
  return { board, messages, resources, budget, deck, pairs, notes, trees, sections, marks, asks, minted, mintedEverywhere, windowFrom, touched: touchedFor(id), plan: planOf(id),
    rev: boardRev(id), notesRev: log?.rev ?? 0 };
}

// Registered here so every importer has the builder: a write must never land and then 500.
buildStatesWith(boardState);
