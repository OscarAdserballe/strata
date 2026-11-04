// Every query here is unscoped and asked once; never loop over boards per row.

import { q } from "../repo.ts";
import { kindOf } from "../sources/blobs.ts";
import { deckTotals } from "../decks/decks.ts";
import { INBOX_TYPE } from "../boards/unfiled.ts";
import type { KeptAt, RegisterEntry, RegisterOverview, RegisterResponse, RegisterStatus } from "../../../shared/types/index.ts";

const WEEK = 7 * 864e5;
export const KEPT_WINDOW_DAYS = 14;

export function registerOf(): RegisterResponse {
  const rows = q.allResources.all();

  const prog = new Map(q.readProgressAll.all()
    .filter((p) => p.resource)
    .map((p) => [p.resource as string, { deepest: p.deepest ?? 0, at: p.at ?? 0 }]));
  const viewed = new Map(q.readViewsAll.all()
    .filter((v) => v.resource)
    .map((v) => [v.resource as string, v.at ?? 0]));
  const trees = new Map(q.treeStateAll.all().map((t) => [t.resource_id, t]));

  const totals = deckTotals();
  const kept = new Map<string, number>();
  for (const r of q.keptCounts.all()) kept.set(r.course, r.n);
  const seen = new Map<string, number>();
  for (const r of q.deckSeenAll.all()) seen.set(r.slug, r.n);
  const benched = new Set<string>();
  for (const r of q.benchedDecks.all()) if (r.deck) benched.add(r.deck);

  const pairDecks = q.pairDecksAll.all();
  const decksOf = new Map<string, string[]>();
  for (const p of pairDecks) {
    const list = decksOf.get(p.resource_id) ?? [];
    list.push(p.deck);
    decksOf.set(p.resource_id, list);
  }
  const pairOf = new Map<string, string>();
  for (const p of q.pairsAll.all()) if (p.resource_id && !pairOf.has(p.resource_id)) pairOf.set(p.resource_id, p.id);
  const boardOfDeck = new Map<string, string>();
  for (const p of pairDecks) if (!boardOfDeck.has(p.deck)) boardOfDeck.set(p.deck, p.board_id);

  const entries: RegisterEntry[] = rows.map((r) => {
    const p = prog.get(r.id);
    const pct = p ? Math.min(100, Math.round(p.deepest)) : 0;
    const opened = !!p || viewed.has(r.id);
    const t = trees.get(r.id);

    let cards = 0, keptN = 0, seenN = 0, everBenched = false;
    for (const deck of decksOf.get(r.id) ?? []) {
      cards += totals.get(deck) ?? 0;
      keptN += kept.get(deck) ?? 0;
      seenN += seen.get(deck) ?? 0;
      if (benched.has(deck)) everBenched = true;
    }
    // Never curated is not curated to zero: it is only a debt once the bench has been opened.
    const allSeen = cards > 0 && seenN >= cards;

    let status: RegisterStatus;
    if (r.done_at) status = "done";
    else if (t && t.failed > 0 && !t.busy) status = "failed";
    else if (t && t.busy > 0) status = "distilling";
    else if (keptN > 0) status = "kept";
    else if (allSeen && everBenched) status = "to-review";
    else if (opened) status = "reading";
    else status = "fresh";

    const unfiled = (r.board_type ?? null) === INBOX_TYPE;
    return {
      resourceId: r.id,
      pairId: pairOf.get(r.id) ?? null,
      boardId: r.board_id,
      boardTitle: unfiled ? "" : r.board_title,
      unfiled,
      filename: r.filename ?? "resource",
      kind: kindOf(r),
      originUrl: r.origin_url ?? null,
      createdAt: r.created_at,
      status,
      readPct: pct,
      kept: keptN,
      cards,
      waiting: !r.done_at && keptN === 0,
    };
  });

  entries.reverse();                       // the ledger is read newest first

  // Found by date via idx_card_keeps_created, not a scan of every keep.
  const recentKeeps = q.keptSince.all(Date.now() - KEPT_WINDOW_DAYS * 864e5);

  const since = Date.now() - WEEK;
  const overview: RegisterOverview = {
    sources: entries.length,
    waiting: entries.filter((e) => e.waiting).length,
    unfiled: entries.filter((e) => e.unfiled && e.waiting).length,
    landed: entries.filter((e) => e.createdAt >= since).length,
    through: entries.filter((e) => !e.waiting && lastTouch(e, prog, viewed) >= since).length,
    kept: recentKeeps.filter((k) => k.created_at >= since).length,
    keptTotal: entries.reduce((n, e) => n + e.kept, 0),
  };

  // Raw timestamps, not day buckets: only the client knows the reader's midnight.
  const keptRecent: KeptAt[] = recentKeeps
    .map((k) => ({ boardId: boardOfDeck.get(k.course) ?? null, at: k.created_at }));

  return { entries, overview, keptRecent };
}

function lastTouch(
  e: RegisterEntry,
  prog: Map<string, { deepest: number; at: number }>,
  viewed: Map<string, number>,
): number {
  return Math.max(prog.get(e.resourceId)?.at ?? 0, viewed.get(e.resourceId) ?? 0, e.createdAt);
}
