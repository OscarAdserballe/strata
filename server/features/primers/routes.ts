import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { now } from "../../platform/db/sql.ts";
import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { LIVE_CSP } from "../sources/live.ts";
import { recordRun, wake } from "../dashboard/routine.ts";
import { idOf } from "../../../shared/agent/ids.ts";
import { q } from "../repo.ts";
import { primersRepo as p } from "./repo.ts";
import { primerView } from "./primers.ts";

const PATH = /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/primer$/;
const PAGE = /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/primer\/page$/;
const sourceOf = (board: string, rid: string) => q.liveKindOf.get(board, rid);

export const primerRoutes: Route[] = [
  route("GET", PATH, ({ res, params }) => {
    if (!sourceOf(params[0], params[1])) { sendJson(res, 404, { error: "no such source" }); return; }
    sendJson(res, 200, primerView(params[0], params[1]));
  }),

  // the same sandbox as a live source, without the save bridge: a primer keeps no state
  route("GET", PAGE, ({ res, params }) => {
    const html = p.primerHtml.get(params[0], params[1])?.html;
    if (!html) { sendJson(res, 404, { error: "no primer for this source yet" }); return; }
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": LIVE_CSP });
    res.end(html);
  }),

  // Asking wakes the routine first, then records the ask; a wake within the cooldown is picked up by the run already going.
  route("POST", PATH, async ({ res, ssn, params, commit }) => {
    const [board, rid] = params;
    const src = sourceOf(board, rid);
    if (!src) { sendJson(res, 404, { error: "no such source" }); return; }
    const w = await wake(`Primer: ${idOf("source", rid)} on ${p.boardHandle.get(board)?.handle ?? board} (${src.filename ?? "untitled"})`);
    commit(() => {
      p.askPrimer.run(rid, board, now());
      if (w.ran) recordRun(w.ran);
      logEvent(db, APP, "primer_ask", { board, resource: rid, woke: !!(w.ran || w.sessionUrl) }, ssn);
      return { status: 200, body: primerView(board, rid) };
    });
  }, { receipt: "atomic" }),
];
