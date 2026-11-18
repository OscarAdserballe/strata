import { httpError, sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { recordRun, wake } from "../dashboard/routine.ts";
import { LIVE_CSP, beforeBodyEnd } from "../sources/live.ts";
import { PRIMER_LINKS, primerPage, requestBoard, requestPrimer } from "./primers.ts";
import { primersRepo as p } from "./repo.ts";

const ID = "([a-zA-Z0-9_-]+)";
const nameOf = (f: string | null | undefined) => String(f ?? "a source").replace(/\.[a-z0-9]+$/i, "");

export const primerRoutes: Route[] = [
  // Asking wakes the routine first (awaited, outside the commit), as Send in Dispatch does; the request and the run commit together.
  route("POST", new RegExp(`^/api/boards/${ID}/resources/${ID}/primer$`), async ({ res, ssn, params, commit }) => {
    const [boardId, rid] = params;
    const r = q.resource.get(boardId, rid);
    if (!r) { sendJson(res, 404, { error: "no such resource" }); return; }
    const w = await wake(`Primer: ${nameOf(r.filename)} on ${q.board.get(boardId)?.title ?? boardId}`);
    commit(() => {
      if (!q.resource.get(boardId, rid)) throw httpError(404, "that source was deleted");
      if (w.ran) recordRun(w.ran);
      const asked = requestPrimer(boardId, rid);
      logEvent(db, APP, "primer_request", { board: boardId, resource: rid, asked, woke: !!w.sessionUrl }, ssn);
      return { status: 200, body: { asked, woke: !!w.sessionUrl, state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("POST", new RegExp(`^/api/boards/${ID}/primers$`), async ({ res, ssn, params, commit }) => {
    const [boardId] = params;
    const b = q.board.get(boardId);
    if (!b) { sendJson(res, 404, { error: "no such board" }); return; }
    if (!p.unprimedCount.get(boardId)?.n) { sendJson(res, 200, { asked: 0, left: 0, woke: false, state: stateOf(boardId) }); return; }
    const w = await wake(`Primers for this board: ${b.title}`);
    commit(() => {
      if (w.ran) recordRun(w.ran);
      const { asked, left } = requestBoard(boardId);
      logEvent(db, APP, "primer_request_board", { board: boardId, asked, left, woke: !!w.sessionUrl }, ssn);
      return { status: 200, body: { asked, left, woke: !!w.sessionUrl, state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  // The page runs where a live source does: an opaque origin, the same sandbox in the header as on the frame.
  route("GET", new RegExp(`^/api/boards/${ID}/resources/${ID}/primer$`), ({ res, params }) => {
    const [boardId, rid] = params;
    const html = primerPage(boardId, rid);
    if (!html) { sendJson(res, 404, { error: "no primer for this source" }); return; }
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": LIVE_CSP });
    res.end(beforeBodyEnd(html, PRIMER_LINKS));
  }),
];
