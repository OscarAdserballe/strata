import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { registerOf } from "./register.ts";
import { ensureInbox, INBOX_ID } from "../boards/unfiled.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";

export const registerRoutes: Route[] = [
  route("GET", "/api/register", ({ res }) => {
    sendJson(res, 200, registerOf());
  }),

  route("POST", "/api/register/inbox", ({ ssn, commit }) => {
    commit(() => {
      const existed = !!q.board.get(INBOX_ID);
      const id = ensureInbox();
      if (!existed) logEvent(db, APP, "inbox_create", {}, ssn);
      return { status: 200, body: { id } };
    });
  }, { receipt: "atomic" }),
];
