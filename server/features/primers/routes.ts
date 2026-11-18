import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { LIVE_CSP, withBridge } from "../sources/live.ts";
import { primersRepo as p } from "./repo.ts";
import { isDispatch, nudgeRoutine, primerHtml, primerView, requestBoardPrimers, requestPrimer } from "./primers.ts";

const ID = "([a-zA-Z0-9_-]+)";

export const primerRoutes: Route[] = [
  route("GET", new RegExp(`^/api/boards/${ID}/resources/${ID}/primer$`), ({ res, params }) => {
    const [boardId, rid] = params;
    if (!p.sourceOn.get(boardId, rid)) { sendJson(res, 404, { error: "no such resource" }); return; }
    sendJson(res, 200, { primer: primerView(rid), dispatch: isDispatch(boardId) });
  }),

  // A press is answered at once: the routine is woken after the commit, never awaited.
  route("POST", new RegExp(`^/api/boards/${ID}/resources/${ID}/primer$`), ({ res, ssn, params, commit }) => {
    const [boardId, rid] = params;
    const src = p.sourceOn.get(boardId, rid);
    if (!src) { sendJson(res, 404, { error: "no such resource" }); return; }
    commit(() => {
      const asked = requestPrimer(boardId, rid);
      if (asked) logEvent(db, APP, "primer_request", { board: boardId, resource: rid, via: "reader" }, ssn);
      if (asked) nudgeRoutine(`Primer: ${src.filename ?? rid}`);
      return { status: 200, body: { primer: primerView(rid) } };
    });
  }, { receipt: "atomic" }),

  route("POST", new RegExp(`^/api/boards/${ID}/primers$`), ({ res, ssn, params, commit }) => {
    const boardId = params[0];
    if (!p.boardHandle.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    commit(() => {
      const queued = requestBoardPrimers(boardId);
      if (queued.length) logEvent(db, APP, "primer_request", { board: boardId, n: queued.length, via: "board" }, ssn);
      if (queued.length) nudgeRoutine(`Primers: ${queued.length} on a board`);
      return { status: 200, body: { queued } };
    });
  }, { receipt: "atomic" }),

  // the same opaque origin and sandbox as a live HTML source: the page draws, never reads the room
  route("GET", new RegExp(`^/api/boards/${ID}/resources/${ID}/primer/live$`), ({ res, params }) => {
    const html = primerHtml(params[0], params[1]);
    if (!html) { sendJson(res, 404, { error: "no primer for this source" }); return; }
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": LIVE_CSP });
    res.end(withBridge(html));
  }),
];
