import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { now } from "../../platform/db/sql.ts";
import { boardRev } from "./repo.ts";
import { boardState } from "./state.ts";
import { insertBoard } from "./create.ts";
import { kindOf } from "../sources/blobs.ts";
import { genSlug } from "../decks/decks.ts";
import { deMaterializeQuestion } from "../author/lifecycle.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";

export const boardRoutes: Route[] = [
  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/status$/, ({ res, params }) => {
    if (!q.board.get(params[0])) { sendJson(res,404,{error:"no such board"}); return; }
    const trees = q.treesOf.all(params[0]);
    sendJson(res,200,{ rev: boardRev(params[0]),
      busy: trees.some(t=>["preparing","queued","running","carding"].includes(t.status)),
      version: JSON.stringify(trees.map(t=>[t.section_id,t.status,t.cards,t.updated_at])) });
  }),
  route("GET", "/api/boards", ({ res }) => {
    const boards = (q.boards.all() as { id: string; title: string; type: string; touched_at: number | null }[]).map((b, i) => {
      const names = q.resourceNamesOf.all(b.id) as { id: string; filename: string | null; mime: string | null; kind: string | null }[];
      const msgCount = q.messageCount.get(b.id)?.n ?? 0;
      // Only the front board gets this query, to keep the route cheap.
      let lastRead: { resourceId: string; filename: string; deepest: number } | null = null;
      if (i === 0) {
        const lr = q.lastReadOf.get(b.id);
        const src = lr?.resource ? names.find((r) => r.id === lr.resource) : null;
        if (lr && src) lastRead = { resourceId: src.id, filename: src.filename ?? "resource", deepest: Number(lr.deepest ?? 0) };
      }
      return {
        id: b.id, title: b.title, type: b.type,
        touchedAt: b.touched_at ?? null,
        ...(i === 0 ? { lastRead } : {}),
        resources: names.map((r) => ({ id: r.id, filename: r.filename ?? "resource", kind: kindOf(r) })),
        msgCount,
      };
    });
    sendJson(res, 200, { boards });
  }),

  route("POST", "/api/boards", async ({ ssn, body, commit }) => {
    const b = await body<{ title?: string; question?: string }>();
    const question = String(b.question ?? "").trim();
    const title = (question || b.title || "Untitled board").trim().slice(0, 200) || "Untitled board";
    commit(() => {
      const id = insertBoard(title, question);
      logEvent(db, APP, "board_create", { type: question ? "question" : "blank" }, ssn);
      return { status: 201, body: { board: q.board.get(id), state: stateOf(id) } };
    });
  }, { receipt: "atomic" }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)$/, ({ res, ssn, params }) => {
    const s = boardState(params[0]);
    if (!s) { sendJson(res, 404, { error: "no such board" }); return; }
    logEvent(db, APP, "board_view", { id: params[0] }, ssn);
    sendJson(res, 200, s);
  }),

  route("PATCH", /^\/api\/boards\/([a-zA-Z0-9_-]+)$/, async ({ res, ssn, params, body, commit }) => {
    const b = await body<{ title?: string; deck?: string | null }>();
    if (!q.board.get(params[0])) { sendJson(res, 404, { error: "no such board" }); return; }
    commit(() => {
      if (b.title) q.renBoard.run(b.title.trim(), params[0]);
      if (b.deck !== undefined) { q.setPrefs.run(params[0], b.deck ? String(b.deck).slice(0, 120) : null); logEvent(db, APP, "deck_bind", { board: params[0], deck: b.deck ?? null }, ssn); }
      return { status: 200, body: { board: q.board.get(params[0]), state: stateOf(params[0]) } };
    });
  }, { receipt: "atomic" }),

  route("DELETE", /^\/api\/boards\/([a-zA-Z0-9_-]+)$/, ({ ssn, params, commit }) => {
    const id = params[0];
    commit(() => {
      // Blobs first: they are found through the resources rows, which are about to go.
      q.delBoardBlobs.run(id);
      q.delBoardMessages.run(id); q.delBoardResources.run(id); q.delPrefs.run(id); q.delBoardPairs.run(id); q.delNotes.run(id);
      for (const t of q.treesOf.all(id) as { section_id: string }[]) { q.delCourseCards.run(genSlug(t.section_id)); q.delCourse.run(genSlug(t.section_id)); }
      q.delBoardTrees.run(id); q.delBoardSections.run(id); q.delBoardSourceTrees.run(id); q.delBoardMarks.run(id); q.delBoardReplies.run(id); q.delBoardAsks.run(id); q.delBoardPageStates.run(id);

      q.delBoardGroups.run(id); q.delBoardMilestones.run(id); q.delBoardPlaces.run(id);
      // A materialized question must take its card with it, or the kept card is left with no owner.
      for (const m of q.mintedOf.all(id)) if (m.card_id) deMaterializeQuestion(m.card_id, id, m.id, ssn);
      q.delBoardMinted.run(id); q.delBoard.run(id);
      // Old DBs may still have retired tables; sweep this board's rows from them where they exist.
      for (const t of ["nodes", "edges", "collapsed", "board_docs", "quiz_history", "question_targets", "question_attempts"]) {
        try { db.prepare(`DELETE FROM ${t} WHERE board_id = ?`).run(id); } catch { /* table absent on fresh DBs */ }
      }
      logEvent(db, APP, "board_delete", { id }, ssn);
      return { status: 200, body: { ok: true } };
    });
  }, { receipt: "atomic" }),

  route("PUT", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/notes$/, async ({ res, ssn, params, body, commit, ifMatch }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ text?: string }>();
    const text = String(b.text ?? "");
    commit(() => {
      ifMatch(q.notesRev.get(boardId)?.rev ?? 0, () => ({ text: q.notes.get(boardId)?.text ?? "" }));
      q.setNotes.run(boardId, text, now());
      logEvent(db, APP, "notes_write", { board: boardId, len: text.length }, ssn);
      // Only the stamps: reading the log back would copy the whole text on every save.
      return { status: 200, body: { rev: boardRev(boardId), notesRev: q.notesRev.get(boardId)?.rev ?? 0 } };
    });
  }, { receipt: "atomic" }),
];
