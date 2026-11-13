import { sendJson } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { addItems, archive, checkItem, createTask, dropItem, editItem, keepItem, patchTask, snapshot, taskView } from "./dashboard.ts";
import { dashboardRepo as q } from "./repo.ts";
import { fireRoutine, recordRun, routineView, setRoutine, wake } from "./routine.ts";
import { checkPress, checkSend, pane, pressThread, sendThread } from "./dispatch.ts";

const ID = "([A-Za-z0-9_]{3,60})";

export const dashboardRoutes: Route[] = [
  route("GET", "/api/dashboard", ({ res }) => { sendJson(res, 200, snapshot()); }),

  // Loaded only when the Done fold opens: the board never pays for what you cleared.
  route("GET", "/api/dashboard/archive", ({ res }) => { sendJson(res, 200, archive()); }),

  // An item you add yourself goes through the same inbox as an agent's.
  route("POST", "/api/dashboard/inbox", async ({ body, commit }) => {
    const b = await body();
    const item = checkItem({ from: { source: "You" }, ...b }, "item");
    commit(() => ({ status: 201, body: { id: addItems([item])[0] } }));
  }, { receipt: "atomic" }),

  route("PATCH", new RegExp(`^/api/dashboard/inbox/${ID}$`), async ({ params, body, commit }) => {
    const b = await body();
    commit(() => ({ status: 200, body: editItem(params[0], b) }));
  }, { receipt: "atomic" }),

  route("POST", new RegExp(`^/api/dashboard/inbox/${ID}/keep$`), async ({ params, body, commit }) => {
    const edits = await body();
    commit(() => ({ status: 200, body: keepItem(params[0], edits) }));
  }, { receipt: "atomic" }),

  route("POST", new RegExp(`^/api/dashboard/inbox/${ID}/drop$`), ({ params, commit }) => {
    commit(() => { dropItem(params[0]); return { status: 200, body: { outcome: "dropped" } }; });
  }, { receipt: "atomic" }),

  route("POST", "/api/dashboard/tasks", async ({ body, commit }) => {
    const b = await body();
    commit(() => ({ status: 201, body: { id: createTask(b) } }));
  }, { receipt: "atomic" }),

  route("PATCH", new RegExp(`^/api/dashboard/tasks/${ID}$`), async ({ params, body, commit }) => {
    const b = await body();
    commit(() => {
      const t = patchTask(params[0], b);
      return { status: 200, body: taskView(t, q.updatesOf.all(t.id)) };
    });
  }, { receipt: "atomic" }),

  // Dispatch: the left pane's threads, and the presses that hand a thread to Claude.
  route("GET", "/api/dashboard/dispatch", ({ res }) => { sendJson(res, 200, pane(q.inboxOpen.all().length)); }),

  route("POST", new RegExp(`^/api/dashboard/tasks/${ID}/send$`), async ({ params, commit }) => {
    checkSend(params[0]);
    const w = await wake(`Sent to Dispatch: ${q.task.get(params[0])?.title ?? params[0]}`);
    commit(() => {
      if (w.ran) recordRun(w.ran);
      return { status: 200, body: { press: sendThread(params[0], w.sessionUrl), pane: pane(q.inboxOpen.all().length) } };
    });
  }, { receipt: "atomic" }),

  route("POST", new RegExp(`^/api/dashboard/tasks/${ID}/press$`), async ({ params, body, commit }) => {
    const b = await body();
    checkPress(params[0], b.kind);
    const w = await wake(`${b.kind === "go" ? "Go" : "Send back"}: ${q.task.get(params[0])?.title ?? params[0]}`);
    commit(() => {
      if (w.ran) recordRun(w.ran);
      return { status: 200, body: { press: pressThread(params[0], b.kind, w.sessionUrl), pane: pane(q.inboxOpen.all().length) } };
    });
  }, { receipt: "atomic" }),

  // The token is write-only: the page learns only whether a routine is connected and how its last run went.
  route("GET", "/api/dashboard/routine", ({ res }) => { sendJson(res, 200, routineView()); }),
  route("PUT", "/api/dashboard/routine", async ({ body, commit }) => {
    const b = await body();
    commit(() => ({ status: 200, body: setRoutine(b) }));
  }, { receipt: "atomic" }),
  route("POST", "/api/dashboard/routine/run", async ({ commit }) => {
    const ran = await fireRoutine();
    commit(() => ({ status: 200, body: recordRun(ran) }));
  }, { receipt: "atomic" }),
];
