import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { DASH_KEY, DISPATCH_KEY, dashOps as dispatchOps, type DashBoard, type DispatchPane, type DispatchThread } from "./dashboard.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const thread = (id: string, stage: string): DispatchThread => ({ id, title: id, stage, links: [], updatedAt: 1, versions: [{ n: 1, resourceId: `res-${id}`, at: 1, landed: stage, notes: 0 }], press: null, lands: null });
const PANE: DispatchPane = { rev: 10, board: "b-1", inbox: 0, threads: [thread("t_d", "decide"), thread("t_r", "review")] };

test("a press moves the card to Implementing at once, landing where the server will put the next page", () => {
  const land = (id: string, kind: "send" | "go" | "back") => {
    const s = new Store();
    s.apply(DISPATCH_KEY, 1, PANE, "wire", { epoch: "e", stamp: 1 });
    const op = dispatchOps.press(id, kind, () => 5, s);
    s.apply(DISPATCH_KEY, null, op.optimistic![0].apply, "optimistic", { op: "x" });
    const t = s.get<DispatchPane>(DISPATCH_KEY)!.threads.find((x) => x.id === id)!;
    return [t.stage, t.lands, t.press?.kind, t.press?.stage];
  };
  assert.deepEqual(land("t_d", "back"), ["implementing", "decide", "back", "decide"]);
  assert.deepEqual(land("t_d", "go"), ["implementing", "review", "go", "decide"]);
  assert.deepEqual(land("t_r", "back"), ["implementing", "review", "back", "review"]);
  assert.deepEqual(land("t_r", "go"), ["implementing", "finish", "go", "review"]);
  assert.deepEqual(land("t_d", "send"), ["implementing", "decide", "send", "decide"]);
  assert.deepEqual(land("t_r", "send"), ["implementing", "review", "send", "review"]);
});

test("the press's answer carries the pane, since a dashboard write leaves the room's revision where it was", async () => {
  const store = new Store();
  store.apply(DISPATCH_KEY, 10, PANE, "wire", { epoch: "e", stamp: 7 });
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({ store, transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })), setTimer: () => 0, clearTimer: () => {} });
  const done = m.mutate(dispatchOps.press("t_d", "go", Date.now, store));
  await tick();
  assert.deepEqual([sent[0].req.method, sent[0].req.path, sent[0].req.body], ["POST", "/api/dashboard/tasks/t_d/press", JSON.stringify({ kind: "go" })]);
  const after: DispatchPane = { ...PANE, rev: 11, threads: [{ ...thread("t_d", "implementing"), lands: "review" }, PANE.threads[1]] };
  sent[0].reply({ status: 200, body: { press: {}, pane: after }, rev: 7, epoch: "e" });
  await done;
  assert.equal(store.get<DispatchPane>(DISPATCH_KEY)!.threads[0].stage, "implementing", "the card stays moved once the layer is gone");
});

test("a replayed answer to a resent press can't put back a thread a later press moved", () => {
  const store = new Store();
  const later: DispatchPane = { ...PANE, rev: 12, threads: PANE.threads.map((t) => ({ ...t, stage: "implementing" })) };
  store.apply(DISPATCH_KEY, 12, later, "wire", { epoch: "e", stamp: 7 });
  const replayed: DispatchPane = { ...PANE, rev: 11, threads: [{ ...PANE.threads[0], stage: "implementing" }, PANE.threads[1]] };
  dispatchOps.press("t_d", "back", Date.now, store).confirm!({ press: {}, pane: replayed }, { rev: 7, epoch: "e" });
  assert.deepEqual(store.get<DispatchPane>(DISPATCH_KEY)!.threads.map((t) => t.stage), ["implementing", "implementing"]);
});

test("a thread made in Dispatch shows at once with its context, and Send to Dispatch waits behind its create", async () => {
  const store = new Store();
  const board: DashBoard = { rev: 3, tasks: [], inbox: [], archived: 0, links: [] };
  store.apply(DASH_KEY, 3, board, "wire", { epoch: "e", stamp: 3 });
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({ store, transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })), setTimer: () => 0, clearTimer: () => {} });
  const made = m.mutate(dispatchOps.create({ id: "t_new1", title: "New", body: "Why it matters", area: "work" }, 5, store));
  const send = m.mutate(dispatchOps.send("t_new1", store));
  await tick();
  const t = store.get<DashBoard>(DASH_KEY)!.tasks.find((x) => x.id === "t_new1")!;
  assert.deepEqual([t.title, t.body, t.stage, t.dispatched], ["New", "Why it matters", "implementing", true]);
  assert.equal(sent.length, 1, "the send waits for the create's answer");
  assert.equal(JSON.parse(String(sent[0].req.body)).body, "Why it matters");
  sent[0].reply({ status: 201, body: { id: "t_new1" }, rev: 4, epoch: "e" });
  await made; await tick();
  assert.deepEqual([sent.length, sent[1].req.path], [2, "/api/dashboard/tasks/t_new1/send"]);
  sent[1].reply({ status: 200, body: { press: {} }, rev: 5, epoch: "e" });
  await send;
});
