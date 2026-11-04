import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { genId } from "../../platform/db/sql.ts";
import type { PairRow, SectionRow } from "../../platform/db/rows.ts";
import { boardState } from "./state.ts";
import { attachGeneratedDeck } from "../decks/decks.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
import { fileSource } from "../sources/ownership.ts";

export const pairRoutes: Route[] = [
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/pairs$/, async ({ res, ssn, params, body, commit }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ label?: string; resourceId?: string | null; deck?: string | null; sectionId?: string | null }>();
    const id = genId("pr-");
    const sid = b.sectionId ?? (b.resourceId ? ((q.sectionsOf.all(b.resourceId) as SectionRow[])[0]?.id ?? null) : null);
    if (b.resourceId && !q.resource.get(boardId, b.resourceId)) { sendJson(res, 404, { error: "no such resource on this board" }); return; }
    if (sid && q.section.get(sid)?.board_id !== boardId) { sendJson(res, 400, { error: "section belongs to another board" }); return; }
    if (sid && q.section.get(sid)?.resource_id !== b.resourceId) { sendJson(res,400,{error:"section belongs to another source"}); return; }
    // Pair, deck and event in one commit, so a retried add makes one pair.
    commit(() => {
      const ord = (q.nextOrd.get(boardId) as { n: number }).n;
      q.insPair.run(id, boardId, (b.label ?? "").slice(0, 160) || "untitled", b.resourceId ?? null, b.deck ?? null, ord, sid);
      if (sid && !b.deck) attachGeneratedDeck(boardId, id, sid);
      logEvent(db, APP, "pair_add", { board: boardId, deck: b.deck ?? null, hasSource: !!b.resourceId }, ssn);
      return { status: 201, body: { id, state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("PATCH", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/pairs\/([a-zA-Z0-9_-]+)$/, async ({ res, ssn, params, body, commit }) => {
    const [boardId, pid] = params;
    const cur = q.pair.get(boardId, pid) as PairRow | undefined;
    if (!cur) { sendJson(res, 404, { error: "no such pair" }); return; }
    const b = await body<{ label?: string; resourceId?: string | null; deck?: string | null }>();
    commit(() => {
      q.updPair.run(
        b.label !== undefined ? String(b.label).slice(0, 160) : cur.label,
        b.resourceId !== undefined ? b.resourceId : cur.resource_id,
        b.deck !== undefined ? b.deck : cur.deck,
        boardId, pid,
      );
      logEvent(db, APP, "pair_edit", {
        board: boardId, renamed: b.label !== undefined && b.label !== cur.label,
        rebound: b.deck !== undefined && b.deck !== cur.deck,
      }, ssn);
      return { status: 200, body: { state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("DELETE", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/pairs\/([a-zA-Z0-9_-]+)$/, ({ res, ssn, url, params, commit }) => {
    const [boardId, pid] = params;
    const cur = q.pair.get(boardId, pid) as PairRow | undefined;
    if (!cur) { sendJson(res, 404, { error: "no such pair" }); return; }
    commit(() => {
      let deckGone = false;
      q.delPair.run(boardId, pid);
      q.delPlace.run(boardId, pid);
      // Delete the deck only if this was its last pair: a deck paired elsewhere is not ours to remove.
      if (url.searchParams.get("deck") === "1" && cur.deck) {
        const used = (q.pairsUsingDeck.get(cur.deck) as { n: number }).n;
        if (!used) { q.delCourseCards.run(cur.deck); q.delCourse.run(cur.deck); deckGone = true; }
      }
      logEvent(db, APP, "pair_remove", { board: boardId, hasSource: !!cur.resource_id, deckGone }, ssn);
      return { status: 200, body: { state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/pairs\/([a-zA-Z0-9_-]+)\/move$/, async ({ res, ssn, params, body, commit }) => {
    const [boardId, pid] = params;
    const cur = q.pair.get(boardId, pid) as PairRow | undefined;
    if (!cur) { sendJson(res, 404, { error: "no such pair" }); return; }
    const b = await body<{ to?: string }>();
    const to = String(b.to ?? "");
    if (!to || !q.board.get(to)) { sendJson(res, 400, { error: "no such destination board" }); return; }
    if (to === boardId) { sendJson(res, 200, { state: boardState(boardId) }); return; }
    // Under a key, a retried move replays the first answer instead of a 404.
    commit(() => {
      if (cur.resource_id) fileSource(db, cur.resource_id, to);
      else {
        q.movePair.run(to, (q.nextOrd.get(to) as { n: number }).n, boardId, pid);
        q.delPlace.run(boardId, pid);
      }
      logEvent(db, APP, "pair_move", { from: boardId, to, hasSource: !!cur.resource_id }, ssn);
      return { status: 200, body: { to, state: stateOf(boardId), destState: stateOf(to) } };
    });
  }, { receipt: "atomic" }),
];
