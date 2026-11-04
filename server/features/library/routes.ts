import { q } from "../repo.ts";
import { now, parseJson } from "../../platform/db/sql.ts";
import { enrollQuestion } from "../author/lifecycle.ts";
import { ensureInbox, INBOX_ID } from "../boards/unfiled.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { mintedOut } from "../author/authored.ts";

const PERSONAL = "strata-personal-cards";
// thrown inside the save's transaction so it rolls back, and answered as a 409 outside it
const DIFFERENT_CARD = new Error("this save already created a different card");
export const libraryRoutes: Route[] = [
  route("GET", "/api/library/questions", ({ res }) => {
    sendJson(res,200,{ questions:q.mintedAll.all().map(m=>({...mintedOut(m),boardId:m.board_id!,boardTitle:m.board_title!})) });
  }),
  route("GET", "/api/library", ({ res }) => {
    const rows = q.threadPage.all(INBOX_ID,null,null,Number.MAX_SAFE_INTEGER,101);
    const more = rows.length > 100; if (more) rows.pop();
    const messages = rows.reverse()
      .map(m => ({ role: m.role, text: m.text, idx: m.idx }));
    const cards = q.cardsOf.all(PERSONAL).map(c => ({
      ...parseJson<Record<string, unknown>>(c.payload, {}), id: c.id,
    }));
    sendJson(res, 200, { messages, cards, before:more ? messages[0].idx : null });
  }),
  route("POST", "/api/library/cards", async ({ res, ssn, body, commit }) => {
    const b = await body<{ front?: string; back?: string; source?: string; requestId?: string }>(64 * 1024);
    if (typeof b.front !== "string" || typeof b.back !== "string" || (b.source !== undefined && typeof b.source !== "string")) {
      sendJson(res, 400, { error: "The card's front, back and source must be text." }); return;
    }
    const front = String(b.front ?? "").trim(), back = String(b.back ?? "").trim();
    const source = String(b.source ?? "").trim() || "Personal card";
    if (!front || !back) { sendJson(res, 400, { error: "Write both the front and the back." }); return; }
    if (typeof b.requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(b.requestId)) {
      sendJson(res, 400, { error: "A card needs a valid save identifier." }); return;
    }
    const id = `m-personal-${b.requestId}`;
    // The requestId is the card's identity; the client also sends it as the Idempotency-Key.
    try {
      commit(() => {
        const boardId = ensureInbox();
        const existing = q.minted.get(boardId, id);
        if (existing) {
          if (existing.front !== front || existing.back !== back || existing.source !== source || !existing.card_id || !q.cardAny.get(existing.card_id)) throw DIFFERENT_CARD;
          return { status: 201, body: { id: existing.card_id!, mintId: id } };
        }
        const t = now();
        q.upsertCourse.run(PERSONAL, "Unfiled cards", JSON.stringify({ authored: true }), t);
        q.insMinted.run(id, boardId, null, "bare", "closed", front, back,
          source, "{}", 0, t, t);
        return { status: 201, body: { id: enrollQuestion(q.minted.get(boardId, id)!, PERSONAL, boardId, ssn), mintId: id } };
      });
    } catch (e) {
      if (e !== DIFFERENT_CARD) throw e;
      sendJson(res, 409, { error: "This save already created a different card. Start a new card." });
    }
  }, { receipt: "atomic", maxBody: 64 * 1024 }),
];
