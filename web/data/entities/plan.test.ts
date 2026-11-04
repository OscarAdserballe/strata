import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoardPlan } from "../../../shared/types/index.ts";
import { Store } from "../store.ts";
import { ATTEMPT_DEADLINE_MS, Mutator, RETRY_DELAYS_MS, type SendAnswer, type SendRequest } from "../mutate.ts";
import { plan as planCalls, planGestures, planOps, planOrder } from "./plan.ts";
import type { PlanEntity } from "./boards.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const ms = (...names: string[]) => names.map((name, ord) => ({ id: name, name, ord, due: null, note: "", doneAt: null }));
const plan = (rev: number, ...names: string[]): PlanEntity => ({ purpose: "", groups: [], milestones: ms(...names), places: {}, rev } as unknown as PlanEntity);
const order = (p: BoardPlan | undefined) => (p?.milestones ?? []).map((m) => m.id).join("");
/** The page's guess for "one later". */
const later = (id: string) => (p: BoardPlan): BoardPlan => {
  const list = p.milestones.slice(), i = list.findIndex((m) => m.id === id);
  if (i >= 0 && i + 1 < list.length) [list[i], list[i + 1]] = [list[i + 1], list[i]];
  return { ...p, milestones: list };
};

function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({ store, transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })), setTimer: () => 0, clearTimer: () => {} });
  store.apply<PlanEntity>("plan:b1", 10, plan(3, "A", "B", "C"), "wire");
  return { store, sent, m };
}

test("two quick moves: both guessed at once, sent in order, and the page ends on the server's plan", async () => {
  const { store, sent, m } = room();
  const move = () => m.mutate(planOps.write("b1", { method: "PATCH", path: "/milestones/A", body: { move: 1 }, guess: later("A") }, store));
  const one = move();
  const two = move();
  assert.equal(order(store.get("plan:b1")), "BCA", "both gestures on screen before any answer");
  assert.equal(sent.length, 1, "the second waits in the plan lane");
  assert.equal(sent[0].req.path, "/api/boards/b1/plan/milestones/A");
  sent[0].reply({ status: 200, body: { plan: plan(4, "B", "A", "C"), rev: 11 }, rev: 11, epoch: "" });
  await one; await tick();
  assert.equal(order(store.get("plan:b1")), "BCA", "the second guess, rebased onto the first answer");
  assert.equal(sent.length, 2);
  sent[1].reply({ status: 200, body: { plan: plan(5, "B", "C", "A"), rev: 12 }, rev: 12, epoch: "" });
  await two;
  assert.equal(order(store.entry<PlanEntity>("plan:b1")?.base), "BCA");
  assert.equal(store.entry("plan:b1")?.layers.length, 0);
  // a board read that left before both moves lands now: older than what is held, dropped
  assert.equal(store.apply<PlanEntity>("plan:b1", 10, plan(3, "A", "B", "C"), "wire"), false);
  assert.equal(order(store.get("plan:b1")), "BCA");
});

test("a whole-plan write says which plan it was made over; a refused one takes its guess back", async () => {
  const { store, sent, m } = room();
  const saving = m.mutate(planOps.write("b1", { method: "PUT", path: "/order", body: { group: null, items: ["x"] }, whole: true, guess: (p) => ({ ...p, purpose: "guessed" }) }, store)).catch((e) => e);
  assert.equal(sent[0].req.headers["If-Match"], '"3"');
  assert.equal(store.get<PlanEntity>("plan:b1")?.purpose, "guessed");
  sent[0].reply({ status: 400, body: { error: "no such item" }, rev: 0, epoch: "" });
  assert.equal((await saving).status, 400);
  assert.equal(store.get<PlanEntity>("plan:b1")?.purpose, "", "rolled back");
  const del = planOps.write("b1", { method: "DELETE", path: "/groups/g1" }, store);
  assert.equal(del.body, undefined, "a delete carries no body");
  assert.equal(del.base, undefined, "a row write takes no If-Match");
});

test("a write out of retries, given up, takes its guess back and lets the next write go", async () => {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const retries: (() => void)[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: (fn, wait) => { if (wait !== ATTEMPT_DEADLINE_MS) retries.push(fn); return 0; }, clearTimer: () => {},
  });
  store.apply<PlanEntity>("plan:b1", 10, plan(3, "A", "B", "C"), "wire");
  const purpose = m.mutate(planOps.write("b1", { method: "PUT", path: "/purpose", body: { purpose: "g1" }, whole: true, guess: (p) => ({ ...p, purpose: "g1" }) }, store)).catch((e) => e);
  const move = m.mutate(planOps.write("b1", { method: "PATCH", path: "/milestones/A", body: { move: 1 }, guess: later("A") }, store));
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    sent.at(-1)!.reply({ status: 500, body: { error: "boom" }, rev: 0, epoch: "" });
    await tick();
    if (i < RETRY_DELAYS_MS.length) retries.shift()!();
  }
  const e = await purpose;
  assert.equal(e.retryable, true, "out of retries");
  assert.equal(sent.length, RETRY_DELAYS_MS.length + 1);
  assert.equal(store.get<PlanEntity>("plan:b1")?.purpose, "g1", "still painted, still holding the lane");
  planCalls.abandon("b1", m);
  await tick();
  assert.equal(store.get<PlanEntity>("plan:b1")?.purpose, "", "the guess is taken back");
  assert.equal(order(store.get("plan:b1")), "BAC", "the move's own guess stays");
  assert.equal(sent.length, RETRY_DELAYS_MS.length + 2, "the move behind it is sent");
  assert.equal(sent.at(-1)!.req.path, "/api/boards/b1/plan/milestones/A");
  sent.at(-1)!.reply({ status: 200, body: { plan: plan(4, "B", "A", "C"), rev: 11 }, rev: 11, epoch: "" });
  await move;
  assert.deepEqual(m.pending(), []);
  assert.equal(store.entry("plan:b1")?.layers.length, 0);
});

test("a whole write refused over a moved plan takes theirs and makes the gesture again over it, once", async () => {
  const { store, sent, m } = room();
  // their write came after the board read the room holds (rev 10): every rev is a stamp of one counter
  const theirs = { ...plan(11, "A", "B", "C", "D"), places: { D: { group: "g", milestone: null, pinned: false, ord: 0 } } };
  const order = (items: string[]): Parameters<typeof planOps.write>[1] => ({
    method: "PUT", path: "/order", body: { group: "g", items }, whole: true,
    rebuild: (p) => order([...items, ...Object.keys(p.places).filter((it) => p.places[it].group === "g" && !items.includes(it))]),
  });
  const saving = m.mutate(planOps.write("b1", order(["x", "y"]), store));
  assert.equal(sent[0].req.headers["If-Match"], '"3"');
  sent[0].reply({ status: 409, body: { error: "the plan changed", conflict: { rev: 11, value: theirs } }, rev: 0, epoch: "" });
  await tick();
  assert.equal(store.entry<PlanEntity>("plan:b1")?.base?.rev, 11, "the store holds their plan");
  assert.equal(sent.length, 2, "made again");
  assert.equal(sent[1].req.headers["If-Match"], '"11"', "over their revision");
  assert.deepEqual(JSON.parse(sent[1].req.body!).items, ["x", "y", "D"], "what they put in the group is kept");
  assert.notEqual(sent[1].req.headers["Idempotency-Key"], sent[0].req.headers["Idempotency-Key"], "a new request, a new key");
  sent[1].reply({ status: 409, body: { error: "the plan changed", conflict: { rev: 12, value: theirs } }, rev: 0, epoch: "" });
  const e = await saving.catch((err) => err);
  assert.equal(e.status, 409, "once: a second refusal is said, not chased");
  assert.equal(sent.length, 2);
});

test("late409: a refusal heard after a newer board read leaves that plan on screen and makes the gesture over it", async () => {
  const { store, sent, m } = room();
  const place = (ord: number) => ({ group: "g", milestone: null, pinned: false, ord });
  const saving = m.mutate(planOps.write("b1", planOrder("g", ["x", "y"]), store));
  assert.equal(sent[0].req.headers["If-Match"], '"3"');
  const refused = { ...plan(11, "A", "B"), places: { D: place(0) } } as PlanEntity;
  const newer = { ...plan(12, "A", "B"), places: { D: place(0), E: place(1) } } as PlanEntity;
  store.apply<PlanEntity>("plan:b1", 13, newer, "wire");
  sent[0].reply({ status: 409, body: { error: "the plan changed", conflict: { rev: 11, value: refused } }, rev: 11, epoch: "" });
  await tick();
  assert.equal(store.entry<PlanEntity>("plan:b1")?.base?.rev, 12, "the newer plan stays, not the refused one");
  assert.deepEqual(Object.keys(store.entry<PlanEntity>("plan:b1")!.base!.places), ["D", "E"]);
  assert.equal(sent.length, 2, "made again");
  assert.equal(sent[1].req.headers["If-Match"], '"12"', "over the plan the room holds");
  assert.deepEqual(JSON.parse(sent[1].req.body!).items, ["x", "y", "D", "E"], "keeping all the other device put in the group");
  sent[1].reply({ status: 200, body: { plan: { ...newer, rev: 14 }, rev: 14 }, rev: 14, epoch: "" });
  await saving;
});

test("after a restore onto a backup, a refusal is taken at its lower rev and the gesture made over it", async () => {
  const { store, sent, m } = room();   // the plan as read before the restore: board rev 10, its own 3
  const saving = m.mutate(planOps.write("b1", planGestures.purpose("mine"), store));
  sent[0].reply({ status: 409, body: { error: "the plan changed", conflict: { rev: 2, value: { ...plan(2, "R"), purpose: "restored" } } }, rev: 5, epoch: "boot-2" });
  await tick();
  const held = store.entry<PlanEntity>("plan:b1");
  assert.deepEqual([held?.base?.rev, held?.base?.purpose, held?.epoch], [2, "restored", "boot-2"], "what the server holds now");
  assert.equal(sent[1].req.headers["If-Match"], '"2"');
  assert.equal(JSON.parse(sent[1].req.body!).purpose, "mine", "the same sentence, over it");
  sent[1].reply({ status: 200, body: { plan: { ...plan(6, "R"), purpose: "mine" }, rev: 6 }, rev: 6, epoch: "boot-2" });
  await saving;
  assert.equal(store.get<PlanEntity>("plan:b1")?.purpose, "mine");
});

test("the plan rail's gestures: a reorder rebuilt over theirs keeps what the other device added, a deleted group lets go of its places", () => {
  const p = { purpose: "", groups: [{ id: "g", name: "G", ord: 0 }], milestones: [], places: { a: { group: "g", milestone: null, pinned: false, ord: 1 } } } as BoardPlan;
  const w = planOrder("g", ["b", "a"]);
  assert.deepEqual(Object.entries(w.guess!(p).places).map(([k, v]) => [k, v.group, v.ord]), [["a", "g", 1], ["b", "g", 0]]);
  const theirs = { ...p, places: { ...p.places, c: { group: "g", milestone: null, pinned: false, ord: 0 } } } as BoardPlan;
  assert.deepEqual(w.rebuild!(theirs)!.body, { group: "g", items: ["b", "a", "c"] });
  const gone = planGestures.delGroup("g").guess!(p);
  assert.deepEqual(gone.groups, []);
  assert.deepEqual(gone.places.a, { group: null, milestone: null, pinned: false, ord: null });
  assert.equal(planGestures.purpose("  read it  ").guess!(p).purpose, "read it");
});
