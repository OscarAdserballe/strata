import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { genId, now } from "../../platform/db/sql.ts";
import { boardRev } from "../boards/repo.ts";
import type { MarkReplyRow, MarkRow, ResourceRow } from "../../platform/db/rows.ts";
import { isPdf } from "../sources/blobs.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";

const MARK_ID = /^mk-[0-9a-f]{8,32}$/;
const REPLY_ID = /^mr-[0-9a-f]{8,32}$/;
// a page's own label for a box it lets the reader point at: data-strata-id="…"
const BOX = /^[A-Za-z0-9_.:-]{1,80}$/;
const replyOut = (r: MarkReplyRow) => ({ id: r.id, author: r.author === "agent" ? "agent" as const : "you" as const, text: r.text, at: r.created_at });
function markOut(m: MarkRow) {
  let rects: number[][] = [];
  try { rects = JSON.parse(m.rects || "[]"); } catch { /* a bad old row paints nothing */ }
  return {
    id: m.id, resourceId: m.resource_id, page: m.page,
    start: m.start_off, end: m.end_off, quote: m.quote, note: m.note,
    rects, box: m.box ?? null, createdAt: m.created_at,
  };
}

export const markRoutes: Route[] = [
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/marks$/, async ({ res, ssn, params, body, commit }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{
      id?: string; resourceId?: string; page?: number | null; start?: number; end?: number;
      quote?: string; note?: string | null; rects?: number[][]; box?: string | null;
    }>();
    const box = typeof b.box === "string" && BOX.test(b.box) ? b.box : null;
    const onRes = q.resource.get(boardId, b.resourceId ?? "") as ResourceRow | undefined;
    if (!b.resourceId || !onRes) { sendJson(res, 404, { error: "no such resource" }); return; }
    const quote = String(b.quote ?? "").trim();
    if (!quote) { sendJson(res, 400, { error: "a mark needs the words it took" }); return; }
    const start = Math.max(0, Math.floor(Number(b.start ?? 0)));
    const end = Math.max(start, Math.floor(Number(b.end ?? start)));
    const page = b.page == null ? null : Math.max(1, Math.floor(Number(b.page)));
    // Clamp to page fractions so a bad rect paints wrong rather than over the whole reader.
    const rects = Array.isArray(b.rects)
      ? b.rects.filter((r) => Array.isArray(r) && r.length === 4).map((r) => r.map((v) => Math.min(1, Math.max(0, Number(v) || 0)))).slice(0, 200)
      : [];
    // The client names its mark so it can use it before the server answers; a taken id is a retry or a clash.
    const named = typeof b.id === "string" && MARK_ID.test(b.id) ? b.id : null;
    if (named) {
      const had = q.mark.get(boardId, named) as MarkRow | undefined;
      if (had) {
        if (had.resource_id === b.resourceId && had.start_off === start && had.end_off === end) { sendJson(res, 200, { id: named, mark: markOut(had), rev: boardRev(boardId) }); return; }
        sendJson(res, 409, { error: "that mark id is taken" }); return;
      }
    }
    const id = named ?? genId("mk-");
    const t = now();
    const resourceId = b.resourceId;
    commit(() => {
      q.insMark.run(id, boardId, resourceId, page, start, end, quote.slice(0, 4000),
        b.note ? String(b.note).slice(0, 4000) : null, rects.length ? JSON.stringify(rects) : null, box, t, t);
      logEvent(db, APP, "mark_add", { board: boardId, page, said: !!b.note, len: quote.length, format: isPdf(onRes) ? "pdf" : (onRes.kind ?? "text") }, ssn);
      return { status: 201, body: { id, mark: markOut({
        id, resource_id: resourceId, page, start_off: start, end_off: end,
        quote: quote.slice(0, 4000), note: b.note ? String(b.note).slice(0, 4000) : null,
        rects: rects.length ? JSON.stringify(rects) : null, box, created_at: t,
      }), rev: boardRev(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("PATCH", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/marks\/([a-zA-Z0-9_-]+)$/, async ({ res, ssn, params, body, commit }) => {
    const [boardId, mid] = params;
    const cur = q.mark.get(boardId, mid) as MarkRow | undefined;
    if (!cur) { sendJson(res, 404, { error: "no such mark" }); return; }
    const b = await body<{ note?: string | null }>();
    const note = b.note == null || !String(b.note).trim() ? null : String(b.note).slice(0, 4000);
    commit(() => {
      q.setMarkNote.run(note, now(), boardId, mid);
      logEvent(db, APP, "mark_note", { board: boardId, said: !!note }, ssn);
      return { status: 200, body: { mark: markOut({ ...cur, note }), rev: boardRev(boardId) } };
    });
  }, { receipt: "atomic" }),

  // Said under a note: sent the moment it is written, and an agent sees it at once.
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/marks\/([a-zA-Z0-9_-]+)\/replies$/, async ({ res, ssn, params, body, commit }) => {
    const [boardId, mid] = params;
    const mark = q.mark.get(boardId, mid) as MarkRow | undefined;
    if (!mark) { sendJson(res, 404, { error: "no such mark" }); return; }
    const b = await body<{ id?: string; text?: string }>();
    const text = String(b.text ?? "").trim().slice(0, 4000);
    if (!text) { sendJson(res, 400, { error: "a reply needs words" }); return; }
    const named = typeof b.id === "string" && REPLY_ID.test(b.id) ? b.id : null;
    const had = named ? q.markReply.get(boardId, named) : undefined;
    if (had) {
      if (had.mark_id === mid && had.text === text) { sendJson(res, 200, { reply: replyOut(had), rev: boardRev(boardId) }); return; }
      sendJson(res, 409, { error: "that reply id is taken" }); return;
    }
    const id = named ?? genId("mr-"), t = now();
    commit(() => {
      q.insMarkReply.run(id, boardId, mid, mark.resource_id, "you", text, t, t);
      logEvent(db, APP, "note_reply", { board: boardId, author: "you", len: text.length }, ssn);
      return { status: 201, body: { reply: { id, author: "you", text, at: t }, rev: boardRev(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("DELETE", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/marks\/([a-zA-Z0-9_-]+)$/, ({ res, url, ssn, params, commit }) => {
    const [boardId, mid] = params;
    if (!q.mark.get(boardId, mid)) { sendJson(res, 404, { error: "no such mark" }); return; }
    commit(() => {
      q.delMark.run(boardId, mid);
      q.delRepliesOfMark.run(boardId, mid);
      logEvent(db, APP, "mark_remove", { board: boardId, undo: url.searchParams.get("undo") === "1" }, ssn);
      return { status: 200, body: { ok: true, id: mid, rev: boardRev(boardId) } };
    });
  }, { receipt: "atomic" }),
];
