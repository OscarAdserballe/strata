// A primer is asked for from the reader, which wakes the routine to write it, and is served to its frame sandboxed.
import { q } from "../repo.ts";
import { db } from "../../platform/db/db.ts";
import { APP } from "../../platform/config.ts";
import { now } from "../../platform/db/sql.ts";
import { logEvent } from "../../platform/events/events.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { LIVE_CSP } from "../sources/live.ts";
import { recordRun, wake } from "../dashboard/routine.ts";

const AT = /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/primer$/;
const PAGE = /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/primer\/page$/;

export interface PrimerView { status: "none" | "asked" | "ready" | "stale"; askedAt: number | null; builtAt: number | null; page: boolean }

export function primerView(board: string, rid: string): PrimerView {
  const p = q.primer.get(board, rid);
  return p ? { status: p.status as PrimerView["status"], askedAt: p.asked_at, builtAt: p.built_at, page: !!p.has_page } : { status: "none", askedAt: null, builtAt: null, page: false };
}

export const primerRoutes: Route[] = [
  route("GET", AT, ({ res, params }) => {
    const [board, rid] = params;
    if (!q.primerSource.get(board, rid)) { sendJson(res, 404, { error: "no such resource" }); return; }
    sendJson(res, 200, primerView(board, rid));
  }),

  // no html bridge: its save would write the source's own page state
  route("GET", PAGE, ({ res, params }) => {
    const html = q.primerPage.get(params[0], params[1])?.html;
    if (!html) { sendJson(res, 404, { error: "this source has no primer yet" }); return; }
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": LIVE_CSP });
    res.end(html);
  }),

  route("POST", AT, async ({ res, ssn, params, commit }) => {
    const [board, rid] = params;
    const src = q.primerSource.get(board, rid);
    if (!src) { sendJson(res, 404, { error: "no such resource" }); return; }
    if (q.primer.get(board, rid)?.status === "asked") { commit(() => ({ status: 200, body: primerView(board, rid) })); return; }
    const title = String(src.filename ?? "untitled").replace(/\.(pdf|md|markdown|txt|html?)$/i, "");
    const w = await wake(`Primer: ${title} (src_${rid} on board ${src.handle ?? board})`);
    commit(() => {
      if (w.ran) recordRun(w.ran);
      q.askPrimer.run(board, rid, now());
      logEvent(db, APP, "primer_ask", { board, resource: rid, woke: !!w.sessionUrl }, ssn);
      return { status: 200, body: primerView(board, rid) };
    });
  }, { receipt: "atomic" }),
];
