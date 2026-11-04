import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { now, parseJson } from "../../platform/db/sql.ts";
import { deckRev } from "./repo.ts";
import type { CardRow } from "../../platform/db/rows.ts";
import { deckTotals, dropDeck, writeCardEdit } from "./decks.ts";
import { facesOf } from "../../../shared/cards/faces.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";

const FACE_MAX = 4000;

const cardOut = (c: CardRow) => ({ ...parseJson<Record<string, unknown>>(c.payload, {}), id: c.id, deck: c.deck, type: c.type, ord: c.ord, rev: c.rev ?? 0 });

export const deckRoutes: Route[] = [
  route("GET", "/api/decks", ({ res }) => {
    const totals = deckTotals();
    const dropped: Record<string, number> = {};
    for (const r of q.dropCounts.all()) dropped[r.course] = r.n;
    // `benched` reads the event log: only it tells never-curated from curated-to-zero.
    const keptN: Record<string, number> = {};
    for (const r of q.keptCounts.all()) keptN[r.course] = r.n;
    const benched = new Set(q.benchedDecks.all().map((r) => r.deck).filter(Boolean));
    const decks = (q.courses.all() as { slug: string; title: string; meta: string | null }[])
      .map((c) => ({ slug: c.slug, title: c.title, meta: parseJson(c.meta, null), total: totals.get(c.slug) ?? 0, ignored: dropped[c.slug] ?? 0,
        kept: keptN[c.slug] ?? 0, benched: benched.has(c.slug) }));
    sendJson(res, 200, { decks });
  }),

  route("GET", /^\/api\/decks\/([a-z0-9-]+)$/, ({ res, ssn, params }) => {
    const slug = params[0];
    const course = q.course.get(slug) as { slug: string; title: string } | undefined;
    if (!course) { sendJson(res, 404, { error: "no such deck" }); return; }
    const cards = q.cardsOf.all(slug).map(cardOut);
    logEvent(db, APP, "deck_open", { deck: slug, cards: cards.length }, ssn);
    sendJson(res, 200, { deck: { slug: course.slug, title: course.title }, cards, rev: deckRev(slug) });
  }),

  route("GET", /^\/api\/decks\/([a-z0-9-]+)\/ignored$/, ({ res, params }) => {
    const slug = params[0];
    if (!q.course.get(slug)) { sendJson(res, 404, { error: "no such deck" }); return; }
    const cards = q.dropsOf.all(slug).map(cardOut);
    sendJson(res, 200, { cards, rev: deckRev(slug) });
  }),

  // The body is read first, so nothing awaits between the reads below and the commit.
  route("PATCH", /^\/api\/decks\/([a-z0-9-]+)\/cards\/([A-Za-z0-9\/_-]+)$/, async ({ res, ssn, params, body, commit, ifMatch }) => {
    const [slug, cid] = params;
    const b = await body<Record<string, unknown>>();
    const live = q.card.get(slug, cid);
    const c = live ?? q.drop.get(slug, cid);
    if (!c) { sendJson(res, 404, { error: "no such card" }); return; }
    const payload = parseJson<Record<string, unknown>>(c.payload, {});
    const faces = facesOf(c.type);
    const patch: Record<string, unknown> = {};
    for (const f of faces) {
      const v = b[f.key];
      if (v === undefined) continue;
      // Options are rewritten in place, same order, so `correct` keeps pointing at the right answer.
      if (f.key === "options") {
        const cur = Array.isArray(payload.options) ? payload.options : null;
        if (!cur || !Array.isArray(v) || v.length !== cur.length || v.some((o) => typeof o !== "string")) {
          sendJson(res, 400, { error: "the options are rewritten in place — same number, same order" }); return;
        }
        patch.options = (v as string[]).map((o) => o.slice(0, FACE_MAX));
        continue;
      }
      if (typeof v !== "string") { sendJson(res, 400, { error: `${f.key} is text` }); return; }
      patch[f.key] = v.slice(0, FACE_MAX);
    }
    if (!Object.keys(patch).length) { sendJson(res, 400, { error: "nothing to rewrite" }); return; }
    const ask = faces[0].key;
    if (patch[ask] !== undefined && !String(patch[ask]).trim()) { sendJson(res, 400, { error: "a card needs its question" }); return; }
    commit(() => {
      const cur = q.card.get(slug, cid) ?? q.drop.get(slug, cid);
      ifMatch(cur?.rev ?? 0, () => (cur ? cardOut(cur) : null));
      // The patch accumulates, so a later edit does not undo an earlier one.
      const { next } = writeCardEdit(slug, cid, patch)!;
      logEvent(db, APP, "card_edit", { deck: slug, card: cid, faces: Object.keys(patch).join(","), ignored: !live }, ssn);
      const cardRev = (live ? q.card : q.drop).get(slug, cid)?.rev ?? 0;
      return { status: 200, body: { ok: true, card: { ...next, id: c.id, deck: c.deck, type: c.type, ord: c.ord, rev: cardRev }, rev: deckRev(slug) } };
    });
  }, { receipt: "atomic" }),

  route("DELETE", /^\/api\/decks\/([a-z0-9-]+)\/cards\/([A-Za-z0-9/_-]+)$/, ({ res, ssn, params, commit }) => {
    const [slug, cid] = params;
    const c = q.card.get(slug, cid);
    if (!c) { sendJson(res, 404, { error: "no such card" }); return; }
    commit(() => {
      q.insDrop.run(c.id, c.course, c.deck, c.type, c.payload, c.ord, now());
      q.delCard.run(c.id);
      // A drop outranks a keep: the keep goes too, and the tombstone records when it was kept for the undo.
      const kept = q.keep.get(c.id);
      if (kept) q.setDropKeptAt.run(kept.created_at, c.id);
      q.delKeep.run(c.id);
      logEvent(db, APP, "card_drop", { deck: slug, card: cid }, ssn);
      return { status: 200, body: { ok: true, total: (q.cardsOf.all(slug) as unknown[]).length } };
    });
  }, { receipt: "atomic" }),

  route("POST", /^\/api\/decks\/([a-z0-9-]+)\/cards\/([A-Za-z0-9/_-]+)\/restore$/, ({ res, ssn, params, commit }) => {
    const [slug, cid] = params;
    const d = q.drop.get(slug, cid);
    if (!d) { sendJson(res, 404, { error: "not a dropped card" }); return; }
    commit(() => {
      q.insCard.run(d.id, d.course, d.deck, d.type, d.payload, d.ord);
      if (d.kept_at != null) q.insKeep.run(d.id, d.course, d.deck, d.kept_at);
      q.delDrop.run(d.id);
      logEvent(db, APP, "card_restore", { deck: slug, card: cid, kept: d.kept_at != null }, ssn);
      return { status: 200, body: { ok: true } };
    });
  }, { receipt: "atomic" }),

  route("POST", /^\/api\/decks\/([a-z0-9-]+)\/ignore$/, ({ res, ssn, params, commit }) => {
    const slug = params[0];
    if (!q.course.get(slug)) { sendJson(res, 404, { error: "no such deck" }); return; }
    commit(() => {
      const cards = dropDeck(slug);
      logEvent(db, APP, "deck_ignore", { deck: slug, cards }, ssn);
      return { status: 200, body: { ok: true, cards } };
    });
  }, { receipt: "atomic" }),

  route("POST", /^\/api\/decks\/([a-z0-9-]+)\/restore$/, ({ res, ssn, params, commit }) => {
    const slug = params[0];
    if (!q.course.get(slug)) { sendJson(res, 404, { error: "no such deck" }); return; }
    commit(() => {
      const drops = q.dropRowsOf.all(slug);
      for (const d of drops) {
        q.insCard.run(d.id, d.course, d.deck, d.type, d.payload, d.ord);
        if (d.kept_at != null) q.insKeep.run(d.id, d.course, d.deck, d.kept_at);
        q.delDrop.run(d.id);
      }
      logEvent(db, APP, "deck_restore", { deck: slug, cards: drops.length }, ssn);
      return { status: 200, body: { ok: true, cards: drops.length } };
    });
  }, { receipt: "atomic" }),

];
