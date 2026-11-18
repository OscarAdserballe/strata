// Asking for a primer: the reader presses Primer on a source, and the routine is woken to draw it.
import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { now } from "../../platform/db/sql.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
import { recordRun, wake } from "../dashboard/routine.ts";
import { idOf } from "../../../shared/agent/ids.ts";
import { q } from "../repo.ts";

export const primerRoutes: Route[] = [
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/primer$/, async ({ res, ssn, params, commit }) => {
    const [boardId, rid] = params;
    const r = q.resource.get(boardId, rid);
    if (!r) { sendJson(res, 404, { error: "no such source" }); return; }
    if (q.primerFor.get(rid)) { sendJson(res, 422, { error: "this page is itself a primer" }); return; }
    const board = q.board.get(boardId);
    const w = await wake(`Primer: ${idOf("source", rid)} "${r.filename ?? "source"}" on board ${boardId}${board?.title ? ` "${board.title}"` : ""}`);
    commit(() => {
      if (w.ran) recordRun(w.ran);
      q.askPrimer.run(rid, boardId, now());
      logEvent(db, APP, "primer_ask", { board: boardId, woke: !!w.sessionUrl }, ssn);
      return { status: 200, body: { woke: !!w.sessionUrl, state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),
];
