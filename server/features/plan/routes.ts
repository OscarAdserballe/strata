import { logEvent } from "../../platform/events/events.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { now, genId } from "../../platform/db/sql.ts";
import { boardRev } from "../boards/repo.ts";
import { planOf } from "./plan.ts";
import { httpError, sendJson } from "../../platform/http/http.ts";
import { route, type Route, type Ctx } from "../../platform/router/router.ts";

const B = "\\/api\\/boards\\/([a-zA-Z0-9_-]+)\\/plan";
const ID = "([a-zA-Z0-9_-]+)";
const ITEM = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_ITEMS = 500;

const clip = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);
const answer = (boardId: string) => ({ plan: planOf(boardId), rev: boardRev(boardId) });

const planMatches = ({ params, ifMatch }: Ctx): void =>
  ifMatch(q.boardPurpose.get(params[0])?.plan_rev ?? 0, () => planOf(params[0]));

function boardOr404({ res, params }: Ctx): boolean {
  if (q.board.get(params[0])) return true;
  sendJson(res, 404, { error: "no such board" });
  return false;
}

export const planRoutes: Route[] = [
  route("PUT", new RegExp(`^${B}\\/purpose$`), async (ctx) => {
    if (!boardOr404(ctx)) return;
    const { ssn, params, body, commit } = ctx;
    const purpose = clip((await body<{ purpose?: string }>()).purpose, 300);
    commit(() => {
      planMatches(ctx);
      q.setBoardPurpose.run(purpose, params[0]);
      logEvent(db, APP, "plan_purpose", { board: params[0], len: purpose.length }, ssn);
      return { status: 200, body: answer(params[0]) };
    });
  }, { receipt: "atomic" }),

  route("POST", new RegExp(`^${B}\\/groups$`), async (ctx) => {
    if (!boardOr404(ctx)) return;
    const { ssn, params, body, commit } = ctx; const boardId = params[0];
    const name = clip((await body<{ name?: string }>()).name, 80) || "New group";
    const id = genId("g-");
    commit(() => {
      q.insGroup.run(id, boardId, name, q.nextGroupOrd.get(boardId)!.n, now());
      logEvent(db, APP, "plan_group_add", { board: boardId, len: name.length }, ssn);
      return { status: 201, body: { id, ...answer(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("PATCH", new RegExp(`^${B}\\/groups\\/${ID}$`), async (ctx) => {
    if (!boardOr404(ctx)) return;
    const { res, ssn, params, body, commit } = ctx; const [boardId, gid] = params;
    const cur = q.group.get(boardId, gid);
    if (!cur) { sendJson(res, 404, { error: "no such group" }); return; }
    const b = await body<{ name?: string }>();
    const name = b.name !== undefined ? clip(b.name, 80) || cur.name : cur.name;
    commit(() => {
      q.renGroup.run(name, boardId, gid);
      logEvent(db, APP, "plan_group_edit", { board: boardId, renamed: name !== cur.name, len: name.length }, ssn);
      return { status: 200, body: answer(boardId) };
    });
  }, { receipt: "atomic" }),

  route("DELETE", new RegExp(`^${B}\\/groups\\/${ID}$`), (ctx) => {
    if (!boardOr404(ctx)) return;
    const { res, ssn, params, commit } = ctx; const [boardId, gid] = params;
    if (!q.group.get(boardId, gid)) { sendJson(res, 404, { error: "no such group" }); return; }
    commit(() => {
      const items = Number(q.ungroupPlaces.run(boardId, gid).changes);
      q.delGroup.run(boardId, gid);
      logEvent(db, APP, "plan_group_remove", { board: boardId, items }, ssn);
      return { status: 200, body: answer(boardId) };
    });
  }, { receipt: "atomic" }),

  route("POST", new RegExp(`^${B}\\/milestones$`), async (ctx) => {
    if (!boardOr404(ctx)) return;
    const { ssn, params, body, commit } = ctx; const boardId = params[0];
    const name = clip((await body<{ name?: string }>()).name, 160) || "New milestone";
    const id = genId("ms-");
    commit(() => {
      q.insMilestone.run(id, boardId, name, q.nextMilestoneOrd.get(boardId)!.n, now());
      logEvent(db, APP, "plan_milestone_add", { board: boardId, len: name.length }, ssn);
      return { status: 201, body: { id, ...answer(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("PATCH", new RegExp(`^${B}\\/milestones\\/${ID}$`), async (ctx) => {
    if (!boardOr404(ctx)) return;
    const { res, ssn, params, body, commit } = ctx; const [boardId, mid] = params;
    const cur = q.milestone.get(boardId, mid);
    if (!cur) { sendJson(res, 404, { error: "no such milestone" }); return; }
    const b = await body<{ name?: string; due?: string; note?: string; done?: boolean; move?: number }>();
    const name = b.name !== undefined ? clip(b.name, 160) || cur.name : cur.name;
    const due = b.due !== undefined ? clip(b.due, 40) : cur.due;
    const note = b.note !== undefined ? clip(b.note, 2000) : cur.note;
    const doneAt = b.done === undefined ? cur.done_at : b.done ? (cur.done_at ?? now()) : null;
    const move = b.move === -1 || b.move === 1 ? b.move : 0;
    commit(() => {
      q.updMilestone.run(name, due, note, doneAt, boardId, mid);
      if (move) {
        // Renumber after the swap: ords drift (holes, ties), and swapping equal ords moves nothing.
        const ids = q.milestonesOf.all(boardId).map((m) => m.id);
        const i = ids.indexOf(mid), j = i + move;
        if (j >= 0 && j < ids.length) [ids[i], ids[j]] = [ids[j], ids[i]];
        ids.forEach((id, ord) => q.setMilestoneOrd.run(ord, boardId, id));
      }
      logEvent(db, APP, "plan_milestone_edit", {
        board: boardId, renamed: name !== cur.name, due: b.due !== undefined, noteLen: note.length,
        ...(b.done !== undefined ? { done: !!b.done } : {}), ...(move ? { move } : {}),
      }, ssn);
      return { status: 200, body: answer(boardId) };
    });
  }, { receipt: "atomic" }),

  route("DELETE", new RegExp(`^${B}\\/milestones\\/${ID}$`), (ctx) => {
    if (!boardOr404(ctx)) return;
    const { res, ssn, params, commit } = ctx; const [boardId, mid] = params;
    if (!q.milestone.get(boardId, mid)) { sendJson(res, 404, { error: "no such milestone" }); return; }
    commit(() => {
      const items = Number(q.clearPlacesMilestone.run(boardId, mid).changes);
      q.delMilestone.run(boardId, mid);
      logEvent(db, APP, "plan_milestone_remove", { board: boardId, items }, ssn);
      return { status: 200, body: answer(boardId) };
    });
  }, { receipt: "atomic" }),

  route("PUT", new RegExp(`^${B}\\/order$`), async (ctx) => {
    if (!boardOr404(ctx)) return;
    const { res, ssn, params, body, commit } = ctx; const boardId = params[0];
    const b = await body<{ group?: string | null; items?: unknown }>();
    const group = b.group == null ? null : String(b.group);
    if (!Array.isArray(b.items) || b.items.length > MAX_ITEMS) { sendJson(res, 400, { error: `items must be a list of at most ${MAX_ITEMS} ids` }); return; }
    if (!b.items.every((it) => typeof it === "string" && ITEM.test(it))) { sendJson(res, 400, { error: "that is not an item id" }); return; }
    const items = [...new Set(b.items as string[])];   // named twice = placed once, where it first stood
    commit(() => {
      planMatches(ctx);
      // Group checked after the base: a group deleted on another device is a stale plan (409), not a 400.
      if (group !== null && !q.group.get(boardId, group)) throw httpError(400, "no such group on this board");
      items.forEach((item, ord) => q.putPlaceOrder.run(boardId, item, group, ord));
      logEvent(db, APP, "plan_order", { board: boardId, grouped: group !== null, n: items.length }, ssn);
      return { status: 200, body: answer(boardId) };
    });
  }, { receipt: "atomic" }),

  route("PATCH", new RegExp(`^${B}\\/places\\/${ID}$`), async (ctx) => {
    if (!boardOr404(ctx)) return;
    const { res, ssn, params, body, commit } = ctx; const [boardId, item] = params;
    if (!ITEM.test(item)) { sendJson(res, 400, { error: "that is not an item id" }); return; }
    const b = await body<{ milestone?: string | null; pinned?: boolean }>();
    const cur = q.place.get(boardId, item);
    const milestone = b.milestone === undefined ? (cur?.milestone_id ?? null) : b.milestone === null ? null : String(b.milestone);
    if (b.milestone != null && !q.milestone.get(boardId, milestone)) { sendJson(res, 400, { error: "no such milestone on this board" }); return; }
    const pinned = b.pinned === undefined ? (cur?.pinned ?? 0) : b.pinned ? 1 : 0;
    commit(() => {
      q.putPlaceMark.run(boardId, item, milestone, pinned);
      logEvent(db, APP, "plan_place", {
        board: boardId, ...(b.pinned !== undefined ? { pinned: !!pinned } : {}),
        ...(b.milestone !== undefined ? { milestone: milestone !== null } : {}),
      }, ssn);
      return { status: 200, body: answer(boardId) };
    });
  }, { receipt: "atomic" }),
];
