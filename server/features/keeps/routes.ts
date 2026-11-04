// Keep events carry no board, so curating does not bump touched_at and reorder the launcher.

import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { now, parseJson } from "../../platform/db/sql.ts";
import { deckRev } from "../decks/repo.ts";
import type { MintedRow, PairRow } from "../../platform/db/rows.ts";
import { ideasCovered } from "../review/ladder.ts";
import { deMaterializeQuestion, enrollQuestion } from "../author/lifecycle.ts";
import { flatten } from "../review/routes.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
// Side-effect import: the board-state builder registers itself on load.
import "../boards/state.ts";
import type { Card, CollectionGroup, DeckKeepsResponse, TreeNode } from "../../../shared/types/index.ts";

const isDeck = (slug: string): boolean => !!q.course.get(slug);
const keptOf = (slug: string): DeckKeepsResponse => ({ ids: q.keepsOf.all(slug).map((r) => r.id), rev: deckRev(slug) });

const claimIdsOf = (sectionId: string | null): Set<string> => {
  const row = sectionId ? q.tree.get(sectionId) : null;
  const json = row && row.json ? parseJson<{ nodes?: TreeNode[] }>(row.json, {}) : null;
  return new Set(flatten(json?.nodes, 0, []).map((c) => c.id));
};

// Computed once per request and passed down, so the events reads are paid once.
type KeepFacts = { benched: Set<string>; lastKeep: Map<string, number> };
const keepFacts = (): KeepFacts => {
  const benched = new Set<string>();
  for (const r of q.benchedDecks.all()) if (r.deck) benched.add(r.deck);
  const lastKeep = new Map<string, number>();
  for (const r of q.lastKeepOf.all()) if (r.deck) lastKeep.set(r.deck, r.t);
  return { benched, lastKeep };
};

const groupOf = (deck: string, label: string, sectionId: string | null, facts: KeepFacts): CollectionGroup | null => {
  const slim = q.cardsCoverageOf.all(deck);
  if (!slim.length) return null;
  const ids = new Set(slim.map((r) => r.id));
  // keep-order, live only: a stale keep matches nothing and must not count
  const keptIds = q.keepsOf.all(deck).map((r) => r.id).filter((id) => ids.has(id));
  const claims = claimIdsOf(sectionId);
  const cov = ideasCovered(slim, new Set(keptIds), claims);
  const cards = keptIds.flatMap((id) => {
    const c = q.cardAny.get(id);
    return c ? [{ ...parseJson<Record<string, unknown>>(c.payload, {}), id: c.id, deck: c.deck, type: c.type, ord: c.ord } as Card] : [];
  });
  return {
    deck, label, total: slim.length, kept: keptIds.length,
    ideasKept: cov.usable ? cov.ideasKept : null,
    ideasTotal: cov.usable ? claims.size : null,
    lastKeepAt: facts.lastKeep.get(deck) ?? null,
    benched: facts.benched.has(deck),
    cards,
  };
};

const boardGroupsOf = (boardId: string, facts: KeepFacts, claimed?: Set<string>): CollectionGroup[] => {
  const secRows = q.sectionsOfBoard.all(boardId);
  const perRes = new Map<string, number>();
  for (const s of secRows) perRes.set(s.resource_id, (perRes.get(s.resource_id) || 0) + 1);
  const secLabel = new Map<string, string>();
  for (const s of secRows) if (s.label && (perRes.get(s.resource_id) || 0) > 1) secLabel.set(s.id, s.label);
  const groups: CollectionGroup[] = [];
  const seen = claimed ?? new Set<string>();
  for (const p of q.pairsOf.all(boardId) as PairRow[]) {
    if (!p.deck || seen.has(p.deck)) continue;
    seen.add(p.deck);
    const g = groupOf(p.deck, (p.section_id && secLabel.get(p.section_id)) || p.label || p.deck, p.section_id, facts);
    if (g) groups.push(g);
  }
  return groups;
};

export const keepRoutes: Route[] = [
  route("GET", /^\/api\/decks\/([a-z0-9-]+)\/keeps$/, ({ res, params }) => {
    const slug = params[0];
    if (!isDeck(slug)) { sendJson(res, 404, { error: "no such deck" }); return; }
    sendJson(res, 200, keptOf(slug));
  }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/collection$/, ({ res, params }) => {
    const boardId = params[0];
    if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    sendJson(res, 200, { board: boardId, groups: boardGroupsOf(boardId, keepFacts()) });
  }),

  route("GET", "/api/collection", ({ res }) => {
    const facts = keepFacts();
    const covered = new Set<string>();
    const boards = [];
    for (const b of q.boards.all()) {
      const groups = boardGroupsOf(b.id, facts, covered);
      if (!groups.length) continue;
      boards.push({
        id: b.id, title: b.title,
        kept: groups.reduce((n, g) => n + g.kept, 0),
        total: groups.reduce((n, g) => n + g.total, 0),
        decksBenched: groups.filter((g) => g.benched).length,
        decksTotal: groups.length,
        lastKeepAt: groups.reduce<number | null>((m, g) => (g.lastKeepAt !== null && (m === null || g.lastKeepAt > m) ? g.lastKeepAt : m), null),
        benched: groups.some((g) => g.benched),
        groups,
      });
    }
    const unfiled: CollectionGroup[] = [];
    const titles = new Map((q.courses.all() as { slug: string; title: string }[]).map((c) => [c.slug, c.title]));
    for (const r of q.keptCounts.all()) {
      if (covered.has(r.course)) continue;
      const g = groupOf(r.course, titles.get(r.course) || r.course, null, facts);
      if (g && g.kept) unfiled.push(g);
    }
    sendJson(res, 200, { boards, unfiled });
  }),

  // Idempotent: a double-tap re-ensures the keep rather than minting the same words twice.
  route("POST", /^\/api\/decks\/([a-z0-9-]+)\/keeps\/minted$/, async ({ res, ssn, params, body, commit }) => {
    const slug = params[0];
    if (!isDeck(slug)) { sendJson(res, 404, { error: "no such deck" }); return; }
    const b = await body<{ board?: string; mint?: string }>();
    const boardId = String(b.board ?? ""), mid = String(b.mint ?? "");
    const m = q.minted.get(boardId, mid) as MintedRow | undefined;
    if (!m) { sendJson(res, 404, { error: "no such question" }); return; }
    if (m.state !== "closed") { sendJson(res, 400, { error: "still open — a card closes on your sentence, and there isn't one yet" }); return; }
    const home = m.card_id ? q.cardAny.get(m.card_id) : null;
    if (home && home.course !== slug) {
      const title = q.course.get(home.course)?.title ?? home.course;
      sendJson(res, 400, { error: `already kept into ${title} — a question has one home` });
      return;
    }
    commit(() => {
      const cid = enrollQuestion(m, slug, boardId, ssn);
      const c = q.cardAny.get(cid);
      return { status: 200, body: {
        ...keptOf(slug),
        // parseJson: the write already landed, so a malformed payload must not 500 a successful request.
        card: c ? { ...parseJson<Record<string, unknown>>(c.payload, {}), id: c.id, deck: c.deck, type: c.type, ord: c.ord, rev: c.rev ?? 0 } : null,
        state: stateOf(boardId),
      } };
    });
  }, { receipt: "atomic" }),

  route("POST", /^\/api\/decks\/([a-z0-9-]+)\/keeps$/, async ({ res, ssn, params, body, commit }) => {
    const slug = params[0];
    if (!isDeck(slug)) { sendJson(res, 404, { error: "no such deck" }); return; }
    const b = await body<{ add?: unknown; remove?: unknown }>();
    const add = Array.isArray(b.add) ? b.add.map(String) : [];
    const remove = Array.isArray(b.remove) ? b.remove.map(String) : [];
    if (!add.length && !remove.length) { sendJson(res, 400, { error: "nothing to keep or unkeep" }); return; }
    // Validated whole before anything is written; a stale keep must still be removable.
    const adding = new Map<string, { deck: string }>();
    for (const id of add) {
      const c = q.card.get(slug, id);
      if (!c) { sendJson(res, 400, { error: `not a card of this deck: ${id}` }); return; }
      adding.set(id, c);
    }
    const removing = new Map<string, { course: string }>();
    for (const id of remove) {
      const k = q.keep.get(id);
      if (!k) { sendJson(res, 400, { error: `not a kept card: ${id}` }); return; }
      removing.set(id, k);
    }
    const t = now();
    commit(() => {
      for (const [id, c] of adding) {
        if (q.keep.get(id)) continue;                       // already kept — a no-op writes no event
        q.insKeep.run(id, slug, c.deck, t);
        logEvent(db, APP, "card_keep", { deck: slug, card: id }, ssn);
      }
      // The unkeep event names the keep's own course, not this route's slug.
      let benchBoard: string | null = null;
      for (const [id, k] of removing) {
        q.delKeep.run(id);
        logEvent(db, APP, "card_unkeep", { deck: k.course, card: id }, ssn);
        const c = q.cardAny.get(id);
        if (!c) continue;                                   // a stale keep has no card to unmake
        const pl = parseJson<Record<string, unknown>>(c.payload, {});
        if (pl.authored && typeof pl.mintId === "string" && typeof pl.board === "string"
            && q.minted.get(pl.board, pl.mintId)) {
          deMaterializeQuestion(id, pl.board, pl.mintId, ssn);
          benchBoard = pl.board;
        }
      }
      return { status: 200, body: { ...keptOf(slug), ...(benchBoard ? { state: stateOf(benchBoard) } : {}) } };
    });
  }, { receipt: "atomic" }),
];
