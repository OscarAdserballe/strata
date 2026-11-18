import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { q } from "../repo.ts";
import { LIVE_CSP, withBridge } from "../sources/live.ts";
import { recordRun, wake } from "../dashboard/routine.ts";
import { primerHtml, primerView, requestPrimer } from "./primers.ts";

const SRC = String.raw`^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/primer`;

export const primerRoutes: Route[] = [
  route("GET", new RegExp(`${SRC}$`), ({ res, params }) => {
    const [boardId, rid] = params;
    if (!q.liveKindOf.get(boardId, rid)) { sendJson(res, 404, { error: "no such resource" }); return; }
    sendJson(res, 200, primerView(rid));
  }),

  // Asking wakes the reader's routine the way a Dispatch send does; the routine finds the request on the board.
  route("POST", new RegExp(`${SRC}$`), async ({ res, ssn, params, commit }) => {
    const [boardId, rid] = params;
    const src = q.liveKindOf.get(boardId, rid);
    if (!src) { sendJson(res, 404, { error: "no such resource" }); return; }
    const w = await wake(`Primer asked for: ${src.filename ?? rid} on ${q.board.get(boardId)?.title ?? boardId}`);
    commit(() => {
      if (!q.liveKindOf.get(boardId, rid)) return { status: 404, body: { error: "no such resource" } };
      if (w.ran) recordRun(w.ran);
      requestPrimer(boardId, rid);
      logEvent(db, APP, "primer_request", { board: boardId, resource: rid }, ssn);
      return { status: 200, body: primerView(rid) };
    });
  }, { receipt: "atomic" }),

  // the same sandbox as a live source: the page can draw and compute, never reach the room
  route("GET", new RegExp(`${SRC}\\/page$`), ({ res, params }) => {
    const [boardId, rid] = params;
    const html = primerHtml(boardId, rid);
    if (html == null) { sendJson(res, 404, { error: "no primer for this source" }); return; }
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": LIVE_CSP });
    res.end(withBridge(html));
  }),
];
