import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { DASH_KEY, dashOps, type DashBoard } from "./dashboard.ts";

const BOARD: DashBoard = { rev: 3, tasks: [], inbox: [], archived: 0, links: [] };

test("a thread written with its context sends the context and shows it at once", () => {
  const s = new Store();
  s.apply(DASH_KEY, 3, BOARD, "wire", { epoch: "e", stamp: 1 });
  const op = dashOps.create({ id: "t_new1", title: "Ship it", body: "Why and how.", area: "personal" }, 5, s);
  assert.deepEqual(op.body, { id: "t_new1", title: "Ship it", body: "Why and how.", area: "personal", stage: "todo" });
  s.apply(DASH_KEY, null, op.optimistic![0].apply, "optimistic", { op: "x" });
  const t = s.get<DashBoard>(DASH_KEY)!.tasks[0];
  assert.deepEqual([t.id, t.title, t.body, t.area, t.stage], ["t_new1", "Ship it", "Why and how.", "personal", "todo"]);
});

test("a thread written with a title alone has empty notes", () => {
  const op = dashOps.create({ id: "t_new2", title: "Only a title", area: "work" }, 5, new Store());
  const t = op.optimistic![0].apply({ ...BOARD })!.tasks[0];
  assert.equal(t.body, "");
});
