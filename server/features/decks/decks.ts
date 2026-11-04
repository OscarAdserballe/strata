// Generated deck slugs are `src-<sectionId>`, so loading courses/*.json at boot never wipes one.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cardsToBundle } from "../distil/distil.ts";
import { asFlashcard } from "../../../shared/cards/flashcard.ts";
import { COURSES_DIR } from "../../platform/config.ts";
import { tx } from "../../platform/db/tx.ts";
import { q } from "../repo.ts";
import { now, parseJson, slugify } from "../../platform/db/sql.ts";
import type { PairRow } from "../../platform/db/rows.ts";
import { SECTION_TO_END } from "../../platform/db/schema.ts";
import { kindOf, pagesOf, sectionsCount } from "../sources/blobs.ts";
import type { QuoteText } from "../../../shared/reading/compile-quote.ts";
import { applyKeptQuestions } from "../author/lifecycle.ts";

export const genSlug = (sid: string): string => "src-" + sid.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** The text cards on a source are placed in: within the section's pages, for a PDF in sections. */
export function quoteTextOf(boardId: string, rid: string, sid: string | null): QuoteText | null {
  const r = q.resource.get(boardId, rid);
  if (!r) return null;
  if (kindOf(r) !== "pdf") return { text: r.text ?? "" };
  const pages = pagesOf(r.id);
  const s = sid ? q.section.get(sid) : undefined;
  if (!s || sectionsCount(r.id) <= 1) return { pages };
  return { pages, firstPage: s.first_page, lastPage: s.last_page === SECTION_TO_END ? pages.length : s.last_page };
}

/** The text a deck's cards are placed in: its pair's source. */
export function quoteTextOfDeck(boardId: string, slug: string): QuoteText | null {
  const p = (q.pairsOf.all(boardId) as PairRow[]).find((x) => x.deck === slug && x.resource_id);
  return p?.resource_id ? quoteTextOf(boardId, p.resource_id, p.section_id ?? null) : null;
}

/** A card rewritten, by the reader or an agent: the patch is kept beside the deck so it outlives a re-distil.
 *  `edited` marks faces the reader rewrote; a new place alone is not a rewrite. Null when there is no such card. */
export function writeCardEdit(slug: string, cid: string, patch: Record<string, unknown>, edited = true): { next: Record<string, unknown>; live: boolean } | null {
  const live = q.card.get(slug, cid);
  const c = live ?? q.drop.get(slug, cid);
  if (!c) return null;
  const prev = q.edit.get(cid);
  const merged = { ...(prev ? parseJson<Record<string, unknown>>(prev.patch, {}) : {}), ...patch, ...(edited ? { edited: true } : {}) };
  const next = { ...parseJson<Record<string, unknown>>(c.payload, {}), ...merged };
  q.insEdit.run(cid, slug, JSON.stringify(merged), now());
  (live ? q.setCardPayload : q.setDropPayload).run(JSON.stringify(next), cid);
  return { next, live: !!live };
}

export function deckTotals(): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of q.cardCounts.all()) out.set(r.course, r.n);
  return out;
}

// Writes only changed cards: the cards trigger bumps rev on every UPDATE, which would stale edit bases.
export function applyEdits(slug?: string): void {
  for (const e of q.edits.all()) {
    if (slug !== undefined && e.course !== slug) continue;
    const c = q.cardAny.get(e.id);
    if (!c) continue;
    let payload: Record<string, unknown>, patch: Record<string, unknown>;
    try {
      payload = JSON.parse(c.payload) as Record<string, unknown>;
      patch = JSON.parse(e.patch) as Record<string, unknown>;
    } catch { continue; }
    // Retired mcq/trick patches may name stem/options/solution; those are already folded into front/back.
    if (c.type === "flashcard" && ["mcq", "trick"].includes(e.id.split("/")[1] || "")) {
      patch = Object.fromEntries(Object.entries(patch).filter(([k]) => ["front", "back", "edited"].includes(k)));
    }
    const next = JSON.stringify({ ...payload, ...patch });
    if (next !== c.payload) q.setCardPayload.run(next, e.id);
  }
}

interface Bundle { course?: { slug?: string; title?: string; meta?: unknown }; decks?: { type?: string; title?: string; cards?: Record<string, unknown>[] }[] }

export function loadCourses(): void {
  let files: string[] = [];
  try { files = readdirSync(COURSES_DIR).filter((f) => f.endsWith(".json")); } catch { return; }
  let courses = 0, cards = 0;
  for (const f of files) {
    try {
      const b = JSON.parse(readFileSync(join(COURSES_DIR, f), "utf-8")) as Bundle;
      const cslug = slugify(b.course?.slug);
      if (!cslug || !Array.isArray(b.decks)) throw new Error("needs course.slug and decks[]");
      const decks = b.decks;
      // one pack, one transaction: a pack that fails halfway keeps the cards it had
      cards += tx(() => {
        q.delCourseCards.run(cslug);
        q.upsertCourse.run(cslug, String(b.course?.title ?? cslug), b.course?.meta != null ? JSON.stringify(b.course.meta) : null, now());
        const seen = new Set<string>();
        let ord = 0;
        decks.forEach((deck, di) => {
          const sourceType = slugify(deck.type) || "flashcard";
          const deckId = `${cslug}/${di}-${sourceType}`;
          (deck.cards ?? []).forEach((card, ci) => {
            const key = card.id != null ? slugify(card.id) : slugify((card.title ?? card.stem ?? card.front ?? ci) as string);
            // Keep the old id: grades, keeps, drops and edits are keyed to it.
            let id = `${cslug}/${sourceType}/${key}`;
            if (seen.has(id)) id = `${id}-${ci}`;
            seen.add(id);
            const saved = q.edit.get(id);
            const patch = saved ? parseJson<Record<string, unknown>>(saved.patch, {}) : {};
            const payload = asFlashcard(sourceType, { ...card, ...patch, id });
            q.insCard.run(id, cslug, deckId, "flashcard", JSON.stringify(payload), ord++);
          });
        });
        return ord;
      });
      courses++;
    } catch (e) { console.error(`  skip ${f}: ${e instanceof Error ? e.message : e}`); }
  }
  q.applyDrops.run();
  applyKeptQuestions();
  applyEdits();
  if (courses) console.log(`  decks: ${courses} courses, ${cards} cards from ${COURSES_DIR}`);
}

export function installDeck(boardId: string, sid: string, title: string, cards: Record<string, unknown>[], force = false): number {
  const slug = genSlug(sid);
  const bundle = cardsToBundle(slug, title, cards as never);
  // tx() nests, so inside the distil job's commit this runs as a savepoint.
  return tx(() => {
    q.delMadeCards.run(slug);
    q.upsertCourse.run(slug, title, null, now());
    let ord = 0, n = 0;
    const seen = new Set<string>();
    bundle.decks.forEach((deck, di) => {
      const deckId = `${slug}/${di}-${deck.type}`;
      deck.cards.forEach((card, ci) => {
        const key = slugify((card.front ?? card.stem ?? card.problem ?? ci) as string) || String(ci);
        let id = `${slug}/${deck.type}/${key}`;
        if (seen.has(id)) id = `${id}-${ci}`;
        seen.add(id);
        const payload = asFlashcard(deck.type, { ...card, id });
        q.insCard.run(id, slug, deckId, "flashcard", JSON.stringify(payload), ord++);
        n++;
      });
    });
    q.applyDrops.run();
    applyKeptQuestions();
    applyEdits(slug);
    n = (q.cardsOf.all(slug) as unknown[]).length;
    // Match on section_id: a divided source has one pair per chapter.
    for (const p of q.pairsOf.all(boardId) as PairRow[]) {
      if (p.section_id === sid && (force || !p.deck)) q.updPair.run(p.label, p.resource_id, slug, boardId, p.id);
    }
    return n;
  });
}

/** The deck a pair's cards go in: its own, or, for a source read without one, a new empty deck that distil may fill later. */
export function deckForPair(boardId: string, p: PairRow): string | null {
  if (p.deck && q.course.get(p.deck)) return p.deck;
  if (p.deck || !p.resource_id) return null;
  const sid = p.section_id ?? (q.sectionsOf.all(p.resource_id) as { id: string }[])[0]?.id;
  if (!sid) return null;
  const slug = genSlug(sid);
  if (!q.course.get(slug)) q.upsertCourse.run(slug, p.label || "cards", null, now());
  q.updPair.run(p.label, p.resource_id, slug, boardId, p.id);
  return slug;
}

export function attachGeneratedDeck(boardId: string, pairId: string, sid: string): string | null {
  const t = q.tree.get(sid) as { status: string } | undefined;
  if (!t || t.status !== "ready") return null;
  const slug = genSlug(sid);
  if (!(q.cardsOf.all(slug) as unknown[]).length) return null;
  const p = (q.pairsOf.all(boardId) as PairRow[]).find((x) => x.id === pairId);
  if (!p || p.deck) return null;
  q.updPair.run(p.label, p.resource_id, slug, boardId, p.id);
  return slug;
}

/** Tombstones every card in a deck, each with its keep, so restoring the deck brings back both. */
export function dropDeck(slug: string): number {
  const cards = q.cardsOf.all(slug);
  const t = now();
  for (const c of cards) {
    q.insDrop.run(c.id, slug, c.deck, c.type, c.payload, c.ord, t); q.delCard.run(c.id);
    const kept = q.keep.get(c.id);
    if (kept) q.setDropKeptAt.run(kept.created_at, c.id);
    q.delKeep.run(c.id);
  }
  return cards.length;
}
