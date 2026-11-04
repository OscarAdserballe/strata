import { q } from "../repo.ts";
import { touchedFor, seenFor } from "./touched.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";

export const progressRoutes: Route[] = [
  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/touched$/, ({ res, params }) => {
    if (!q.board.get(params[0])) { sendJson(res, 404, { error: "no such board" }); return; }
    sendJson(res, 200, { touched: touchedFor(params[0]) });
  }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/seen$/, ({ res, params }) => {
    if (!q.board.get(params[0])) { sendJson(res, 404, { error: "no such board" }); return; }
    sendJson(res, 200, seenFor(params[0]));
  }),
];
