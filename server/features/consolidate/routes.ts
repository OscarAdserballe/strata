import type { GeminiUsage } from "../../platform/llm/gemini.ts";
import type { DistilFace, DistilMeta } from "../../../shared/types/index.ts";
import { logEvent } from "../../platform/events/events.ts";
import { CHAT_MODEL, CHAT_THINKING, FAKE_MODEL } from "../ask/turn.ts";
import { APP, deps } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { now, parseJson } from "../../platform/db/sql.ts";
import { q } from "../repo.ts";
import { deMaterializeQuestion, enrollQuestion } from "../author/lifecycle.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
import { consolidateRepo as c } from "./repo.ts";
import { checkedMap, DISTIL_SYSTEM, distilledOn, fakeMap, gatherMarks } from "./consolidate.ts";

const IDEA = /^i[0-9a-f]{8}$/;
const DRAFTED = new Set(["agent", "edited", "you"]);
// thrown inside the commit so it rolls back, and answered as a 409 outside it
const ALREADY = new Error("that idea is already kept");

export const consolidateRoutes: Route[] = [
  // Writes nothing: the map is a proposal the reader works through; only keeping an idea writes.
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/distil\/map$/, async ({ res, ssn, params, body }) => {
    const board = q.board.get(params[0]);
    if (!board) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ decks?: unknown }>();
    const decks = Array.isArray(b.decks) ? b.decks.map(String) : null;
    const fallback = c.boardDecks.all(board.id)[0]?.deck;
    const marks = gatherMarks(board.id, decks);
    if (!fallback || marks.length < 2) { sendJson(res, 200, { ideas: [], loose: marks.map((m) => m.ref), marks, drafted: false }); return; }
    if (FAKE_MODEL || !deps.geminiAvailable) { sendJson(res, 200, fakeMap(marks, fallback)); return; }
    const user = JSON.stringify({ project: board.title, marks: marks.map(({ ref, kind, text, said, from }) => ({ ref, kind, text, said, from })) });
    const t0 = Date.now();
    let usage: GeminiUsage | undefined;
    try {
      const out = await deps.callGeminiJson({ system: DISTIL_SYSTEM, user, model: CHAT_MODEL, thinkingBudget: CHAT_THINKING, timeoutMs: 90_000, onUsage: (u) => { usage = u; } });
      const map = checkedMap(out, marks, fallback);
      logEvent(db, APP, "distil_map", { board: board.id, marks: marks.length, ideas: map.ideas.length, loose: map.loose.length, ms: Date.now() - t0,
        ...(usage ? { promptTokens: usage.prompt, outputTokens: usage.output } : {}) }, ssn);
      sendJson(res, 200, map);
    } catch (e) {
      console.error("[distil map]", e);
      sendJson(res, 502, { error: "Claude couldn't group your marks. Try again in a moment." });
    }
  }, { receipt: "none" }),

  // One idea becomes the reader's card(s), kept; the kept cards it folds in leave review.
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/distil\/keep$/, async ({ res, ssn, params, body, commit }) => {
    const board = q.board.get(params[0]);
    if (!board) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ idea?: unknown; title?: unknown; deck?: unknown; cards?: unknown; from?: unknown; drafted?: unknown }>(64 * 1024);
    const idea = String(b.idea ?? ""), deck = String(b.deck ?? ""), title = String(b.title ?? "").trim().slice(0, 120);
    const drafted = String(b.drafted ?? "agent") as DistilMeta["drafted"];
    if (!IDEA.test(idea)) { sendJson(res, 400, { error: "not an idea of a map" }); return; }
    if (!DRAFTED.has(drafted)) { sendJson(res, 400, { error: "drafted is agent, edited or you" }); return; }
    if (!c.boardDecks.all(board.id).some((p) => p.deck === deck)) { sendJson(res, 400, { error: "not a deck of this board" }); return; }
    const cards = (Array.isArray(b.cards) ? b.cards : []).map((x) => {
      const o = (x && typeof x === "object" ? x : {}) as { front?: unknown; back?: unknown };
      return { front: String(o.front ?? "").trim(), back: String(o.back ?? "").trim() };
    });
    if (!cards.length || cards.length > 4 || cards.some((f: DistilFace) => !f.front || !f.back)) {
      sendJson(res, 400, { error: "Write a question and an answer on each card (one to four cards)." }); return;
    }
    const from = Array.from(new Set((Array.isArray(b.from) ? b.from : []).map(String)));
    const live = new Set(gatherMarks(board.id, null).map((m) => m.ref));
    const { ideas } = distilledOn(board.id);
    const gone = from.filter((r) => !live.has(r));
    if (ideas.has(idea)) { sendJson(res, 409, { error: "That idea is already kept. Undo it first to keep it again." }); return; }
    if (from.length < 2 || gone.length) { sendJson(res, 400, { error: `These marks aren't there to fold in any more: ${gone.join(", ") || "fewer than two"}. Map again.` }); return; }
    try {
      commit(() => {
        if (distilledOn(board.id).ideas.has(idea)) throw ALREADY;
        const t = now();
        const retired = from.filter((r) => r.startsWith("k:")).map((r) => q.keep.get(r.slice(2)) as { id: string; course: string } | undefined)
          .filter((k): k is { id: string; course: string } => !!k)
          .map((k) => ({ id: k.id, course: k.course, deck: q.cardAny.get(k.id)?.deck ?? `${k.course}/yours` }));
        const meta: DistilMeta = { idea, title, from, retired, drafted };
        const made: string[] = [];
        cards.forEach((f, i) => {
          const id = `m-distil-${idea}-${i + 1}`;
          q.insMinted.run(id, board.id, null, "bare", "closed", f.front, f.back,
            `distilled from ${from.length} marks${title ? ` · ${title}` : ""}`, JSON.stringify({ distil: meta }), 0, t, t);
          made.push(enrollQuestion(q.minted.get(board.id, id)!, deck, board.id, ssn));
        });
        for (const k of retired) {
          q.delKeep.run(k.id);
          logEvent(db, APP, "card_unkeep", { deck: k.course, card: k.id, distil: idea }, ssn);
        }
        logEvent(db, APP, "distil_keep", { board: board.id, idea, marks: from.length, cards: cards.length, retired: retired.length, drafted }, ssn);
        return { status: 200, body: { idea, cards: made, retired: retired.map((k) => k.id), state: stateOf(board.id) } };
      });
    } catch (e) {
      if (e !== ALREADY) throw e;
      sendJson(res, 409, { error: "That idea is already kept. Undo it first to keep it again." });
    }
  }, { receipt: "atomic", maxBody: 64 * 1024 }),

  // The idea's cards go, and the cards it retired come back into review.
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/distil\/(i[0-9a-f]{8})\/undo$/, ({ res, ssn, params, commit }) => {
    const board = q.board.get(params[0]);
    if (!board) { sendJson(res, 404, { error: "no such board" }); return; }
    const idea = params[1];
    commit(() => {
      const rows = c.distilledOf.all(board.id).filter((m) => parseJson<{ distil?: DistilMeta }>(m.meta, {}).distil?.idea === idea);
      if (!rows.length) return { status: 200, body: { idea, restored: [], state: stateOf(board.id) } };
      const restored: string[] = [];
      for (const m of rows) {
        const d = parseJson<{ distil?: DistilMeta }>(m.meta, {}).distil!;
        if (m.card_id && q.cardAny.get(m.card_id)) deMaterializeQuestion(m.card_id, board.id, m.id, ssn);
        q.delMinted.run(board.id, m.id);
        for (const k of d.retired) {
          if (restored.includes(k.id) || !q.cardAny.get(k.id) || q.keep.get(k.id)) continue;
          q.insKeep.run(k.id, k.course, k.deck, now());
          logEvent(db, APP, "card_keep", { deck: k.course, card: k.id, distil: idea }, ssn);
          restored.push(k.id);
        }
      }
      logEvent(db, APP, "distil_undo", { board: board.id, idea, cards: rows.length, restored: restored.length }, ssn);
      return { status: 200, body: { idea, restored, state: stateOf(board.id) } };
    });
  }, { receipt: "atomic" }),
];
