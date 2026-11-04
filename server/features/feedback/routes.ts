import { feedbackRepo as q } from "./repo.ts";
import { genId, now, parseJson } from "../../platform/db/sql.ts";
import type { FeedbackRow } from "../../platform/db/rows.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";

const shape = (r: FeedbackRow): Record<string, unknown> => ({
  id: r.id, board: r.board_id, kind: r.kind, card: r.card_id, deck: r.deck,
  messageIdx: r.message_idx, context: parseJson<unknown>(r.context, null),
  comment: r.comment, resolved: !!r.resolved, createdAt: r.created_at,
});

export const feedbackRoutes: Route[] = [
  route("POST", "/api/feedback", async ({ res, body, commit }) => {
    const b = await body<{ board?: string; kind?: string; card?: string; deck?: string; messageIdx?: number; context?: unknown; comment?: string }>();
    const comment = typeof b.comment === "string" ? b.comment.trim() : "";
    if (!comment) { sendJson(res, 400, { error: "an empty note says nothing" }); return; }
    const kind = b.kind;
    if (kind !== "chat" && kind !== "card" && kind !== "general") { sendJson(res, 400, { error: "kind must be chat, card or general" }); return; }
    const id = genId("f");
    commit(() => {
      q.insFeedback.run(id,
        typeof b.board === "string" ? b.board : null, kind,
        typeof b.card === "string" ? b.card : null,
        typeof b.deck === "string" ? b.deck : null,
        typeof b.messageIdx === "number" ? b.messageIdx : null,
        b.context !== undefined ? JSON.stringify(b.context) : null,
        comment.slice(0, 4000), now());
      return { status: 200, body: { id } };
    });
  }, { receipt: "atomic" }),

  route("GET", "/api/feedback", ({ res, url }) => {
    const rows = url.searchParams.get("all") ? q.feedbackAll.all() : q.feedbackOpen.all();
    sendJson(res, 200, { feedback: rows.map(shape) });
  }),

  route("PATCH", /^\/api\/feedback\/([^/]+)$/, async ({ params, body, commit }) => {
    const b = await body<{ resolved?: boolean }>();
    commit(() => {
      q.setFeedbackResolved.run(b.resolved === false ? 0 : 1, params[0]);
      return { status: 200, body: { ok: true } };
    });
  }, { receipt: "atomic" }),
];
