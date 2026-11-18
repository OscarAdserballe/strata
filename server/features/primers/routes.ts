import { db } from "../../platform/db/db.ts";
import { APP } from "../../platform/config.ts";
import { logEvent } from "../../platform/events/events.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { LIVE_CSP, withBridge } from "../sources/live.ts";
import { recordRun } from "../dashboard/routine.ts";
import { primersRepo as p } from "./repo.ts";
import { isDispatchBoard, primerView, requestPrimer, wakeFor } from "./primers.ts";

const AT = "^/api/boards/([a-zA-Z0-9_-]+)/resources/([a-zA-Z0-9_-]+)/primer";

export const primerRoutes: Route[] = [
  route("GET", new RegExp(`${AT}$`), ({ res, params }) => {
    const [boardId, rid] = params;
    if (!p.primerSource.get(boardId, rid)) { sendJson(res, 404, { error: "no such source" }); return; }
    sendJson(res, 200, primerView(rid));
  }),

  // the wake goes before the commit, as a Dispatch press's does; a press while one is asked for wakes nothing
  route("POST", new RegExp(`${AT}$`), async ({ res, ssn, params, commit }) => {
    const [boardId, rid] = params;
    const src = p.primerSource.get(boardId, rid);
    if (!src) { sendJson(res, 404, { error: "no such source" }); return; }
    if (isDispatchBoard(boardId)) { sendJson(res, 400, { error: "a Dispatch page is read as it is, without a primer" }); return; }
    const w = primerView(rid).status === "requested" ? null : await wakeFor(boardId, rid, src.filename);
    commit(() => {
      if (!p.primerSource.get(boardId, rid)) return { status: 404, body: { error: "the source was removed" } };
      if (w?.ran) recordRun(w.ran);
      if (requestPrimer(boardId, rid)) {
        logEvent(db, APP, "primer_request", { board: boardId, resource: rid, woke: !!w?.sessionUrl }, ssn);
      }
      return { status: 200, body: primerView(rid) };
    });
  }, { receipt: "atomic" }),

  // the page runs on an opaque origin, exactly as a live source does
  route("GET", new RegExp(`${AT}/live$`), ({ res, params }) => {
    const [boardId, rid] = params;
    const row = p.primerHtml.get(boardId, rid);
    if (!row?.html) { sendJson(res, 404, { error: "no primer for this source yet" }); return; }
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": LIVE_CSP });
    res.end(withBridge(row.html));
  }),
];
