import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { stopServer } from "../support/stop-server.ts";
import { freePort } from "../support/free-port.ts";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `strata-plantest-${process.pid}.db`);
const OLD = "b-oldboard";
const EMPTY = { purpose: "", groups: [], milestones: [], places: {} };
const bare = ({ rev: _rev, ...plan }: { rev?: number; [k: string]: unknown }) => plan;
let server: ChildProcess;

const api = async (path: string, opts?: RequestInit) => {
  const r = await fetch(BASE + path, { headers: { "Content-Type": "application/json" }, ...opts });
  return { status: r.status, body: r.status === 204 ? null : await r.json() };
};
const send = (method: string, path: string, body?: unknown) => api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const rmDb = () => { for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true }); };
const rows = (sql: string, ...args: string[]) => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try { return db.prepare(sql).all(...args) as Record<string, unknown>[]; } finally { db.close(); }
};

before(async () => {
  try {
    await fetch(BASE + "/api/health", { signal: AbortSignal.timeout(1000) });
    throw new Error(`something already answers on :${PORT} — an orphaned test server. Kill it first.`);
  } catch (e) {
    if ((e as Error).message.includes("orphaned")) throw e; /* connection refused = the good case */
  }
  rmDb();
  const old = new DatabaseSync(DB);
  old.exec("CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT, created_at INTEGER NOT NULL, goal TEXT)");
  old.prepare("INSERT INTO boards (id,title,type,created_at,goal) VALUES (?,?,?,?,?)").run(OLD, "From before the plan", "blank", 1, "named a goal back then");
  old.close();
  server = spawn(process.execPath, ["server/main.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, STRATA_OPEN: "1", STRATA_PORT: String(PORT), STRATA_DB: DB, GEMINI_API_KEY: "" },
    stdio: "ignore",
  });
  for (const end = Date.now() + 60_000; Date.now() < end;) {
    try { const r = await fetch(BASE + "/api/health"); if (r.ok) return; } catch { /* not up */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error("server did not start");
});

after(async () => { await stopServer(server); rmDb(); });

const newBoard = async (title: string): Promise<string> => (await send("POST", "/api/boards", { title })).body.board.id;
const addSource = async (board: string, filename: string): Promise<string> =>
  (await send("POST", `/api/boards/${board}/resources`, { filename, text: `# ${filename}\n\nbody`, pair: true })).body.resourceId;
const planOf = async (board: string) => (await api(`/api/boards/${board}`)).body.plan;

test("a board from an old DB is migrated and reads with an empty plan", async () => {
  const cols = rows("PRAGMA table_info(boards)").map((c) => c.name);
  assert.ok(cols.includes("purpose") && cols.includes("touched_at") && !cols.includes("goal"));
  const { status, body } = await api(`/api/boards/${OLD}`);
  assert.equal(status, 200);
  assert.equal(body.board.title, "From before the plan");
  assert.deepEqual(bare(body.plan), { ...EMPTY, purpose: "named a goal back then" }, "the old goal carries over as the purpose");
  assert.equal((await send("PUT", `/api/boards/${OLD}/plan/purpose`, { purpose: "still here" })).body.plan.purpose, "still here");
  const fresh = await send("POST", "/api/boards", { title: "Fresh" });
  assert.deepEqual(bare(fresh.body.state.plan), EMPTY);
});

test("the purpose is trimmed, capped at 300 characters, and can be cleared", async () => {
  const id = await newBoard("Purpose");
  const set = await send("PUT", `/api/boards/${id}/plan/purpose`, { purpose: "  pass the macro exam  " });
  assert.equal(set.status, 200);
  assert.equal(set.body.plan.purpose, "pass the macro exam");
  assert.equal(await planOf(id).then((p) => p.purpose), "pass the macro exam");
  assert.equal((await send("PUT", `/api/boards/${id}/plan/purpose`, { purpose: "x".repeat(400) })).body.plan.purpose.length, 300);
  assert.equal((await send("PUT", `/api/boards/${id}/plan/purpose`, {})).body.plan.purpose, "");
});

test("groups: add (defaulted, capped, ordered), rename, and a delete that un-groups its items", async () => {
  const id = await newBoard("Groups");
  const a = await send("POST", `/api/boards/${id}/plan/groups`, { name: "  Week one " });
  assert.equal(a.status, 201);
  assert.match(a.body.id, /^g-/);
  const b = await send("POST", `/api/boards/${id}/plan/groups`, {});
  const c = await send("POST", `/api/boards/${id}/plan/groups`, { name: "n".repeat(200) });
  assert.deepEqual(c.body.plan.groups, [
    { id: a.body.id, name: "Week one", ord: 0 }, { id: b.body.id, name: "New group", ord: 1 }, { id: c.body.id, name: "n".repeat(80), ord: 2 },
  ]);

  const ren = await send("PATCH", `/api/boards/${id}/plan/groups/${a.body.id}`, { name: " Foundations " });
  assert.equal(ren.body.plan.groups[0].name, "Foundations");
  assert.equal((await send("PATCH", `/api/boards/${id}/plan/groups/${a.body.id}`, { name: "   " })).body.plan.groups[0].name, "Foundations");

  const r1 = await addSource(id, "one.md"), r2 = await addSource(id, "two.md");
  await send("PUT", `/api/boards/${id}/plan/order`, { group: a.body.id, items: [r1, r2] });
  await send("PATCH", `/api/boards/${id}/plan/places/${r1}`, { pinned: true });
  const del = await send("DELETE", `/api/boards/${id}/plan/groups/${a.body.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.plan.groups.map((g: { id: string }) => g.id), [b.body.id, c.body.id]);
  assert.deepEqual(del.body.plan.places[r1], { group: null, milestone: null, pinned: true, ord: null });
  assert.deepEqual(del.body.plan.places[r2], { group: null, milestone: null, pinned: false, ord: null });
  assert.equal((await send("POST", `/api/boards/${id}/plan/groups`, { name: "later" })).body.plan.groups.at(-1).ord, 3);
});

test("milestones: add, edit, done and undone, move with dense ords, and a delete that clears places", async () => {
  const id = await newBoard("Milestones");
  const ids: string[] = [];
  for (const name of ["Read part I", "", "Mock exam"]) {
    const r = await send("POST", `/api/boards/${id}/plan/milestones`, { name });
    assert.equal(r.status, 201); assert.match(r.body.id, /^ms-/);
    ids.push(r.body.id);
  }
  const [m1, m2, m3] = ids;
  let plan = await planOf(id);
  assert.deepEqual(plan.milestones.map((m: { name: string }) => m.name), ["Read part I", "New milestone", "Mock exam"]);
  assert.deepEqual(plan.milestones[0], { id: m1, name: "Read part I", due: "", note: "", doneAt: null, ord: 0 });

  const edited = await send("PATCH", `/api/boards/${id}/plan/milestones/${m2}`, { name: " Problem sets ", due: " before reading week ", note: "n".repeat(3000) });
  const e = edited.body.plan.milestones[1];
  assert.equal(e.name, "Problem sets"); assert.equal(e.due, "before reading week"); assert.equal(e.note.length, 2000);
  assert.equal((await send("PATCH", `/api/boards/${id}/plan/milestones/${m2}`, { due: "d".repeat(100) })).body.plan.milestones[1].due.length, 40);
  assert.equal((await send("PATCH", `/api/boards/${id}/plan/milestones/${m2}`, { due: "" })).body.plan.milestones[1].name, "Problem sets");

  const t0 = Date.now();
  const done = (await send("PATCH", `/api/boards/${id}/plan/milestones/${m1}`, { done: true })).body.plan.milestones[0].doneAt;
  assert.ok(done >= t0 && done <= Date.now());
  assert.equal((await send("PATCH", `/api/boards/${id}/plan/milestones/${m1}`, { done: true })).body.plan.milestones[0].doneAt, done);
  assert.equal((await send("PATCH", `/api/boards/${id}/plan/milestones/${m1}`, { done: false })).body.plan.milestones[0].doneAt, null);

  const order = (p: { milestones: { id: string; ord: number }[] }) => p.milestones.map((m) => [m.id, m.ord]);
  plan = (await send("PATCH", `/api/boards/${id}/plan/milestones/${m3}`, { move: -1 })).body.plan;
  assert.deepEqual(order(plan), [[m1, 0], [m3, 1], [m2, 2]]);
  plan = (await send("PATCH", `/api/boards/${id}/plan/milestones/${m1}`, { move: 1 })).body.plan;
  assert.deepEqual(order(plan), [[m3, 0], [m1, 1], [m2, 2]]);
  plan = (await send("PATCH", `/api/boards/${id}/plan/milestones/${m3}`, { move: -1 })).body.plan;
  plan = (await send("PATCH", `/api/boards/${id}/plan/milestones/${m2}`, { move: 1 })).body.plan;
  plan = (await send("PATCH", `/api/boards/${id}/plan/milestones/${m2}`, { move: 5 })).body.plan;
  assert.deepEqual(order(plan), [[m3, 0], [m1, 1], [m2, 2]]);

  const rid = await addSource(id, "chapter.md");
  await send("PATCH", `/api/boards/${id}/plan/places/${rid}`, { milestone: m1, pinned: true });
  const del = await send("DELETE", `/api/boards/${id}/plan/milestones/${m1}`);
  assert.deepEqual(del.body.plan.milestones.map((m: { id: string }) => m.id), [m3, m2]);
  assert.deepEqual(del.body.plan.places[rid], { group: null, milestone: null, pinned: true, ord: null });
  plan = (await send("PATCH", `/api/boards/${id}/plan/milestones/${m2}`, { move: -1 })).body.plan;
  assert.deepEqual(order(plan), [[m2, 0], [m3, 1]]);
});

test("order: moves and reorders in one verb, keeps pin and milestone, refuses foreign groups and bad ids", async () => {
  const id = await newBoard("Order"), other = await newBoard("Elsewhere");
  const g1 = (await send("POST", `/api/boards/${id}/plan/groups`, { name: "A" })).body.id;
  const g2 = (await send("POST", `/api/boards/${id}/plan/groups`, { name: "B" })).body.id;
  const foreign = (await send("POST", `/api/boards/${other}/plan/groups`, { name: "theirs" })).body.id;
  const ms = (await send("POST", `/api/boards/${id}/plan/milestones`, { name: "M" })).body.id;
  const [a, b, c] = [await addSource(id, "a.md"), await addSource(id, "b.md"), await addSource(id, "c.md")];
  const pair = (await send("POST", `/api/boards/${id}/pairs`, { label: "loose deck" })).body.id;

  await send("PATCH", `/api/boards/${id}/plan/places/${b}`, { pinned: true, milestone: ms });
  let plan = (await send("PUT", `/api/boards/${id}/plan/order`, { group: g1, items: [a, b, c, pair] })).body.plan;
  assert.deepEqual([a, b, c, pair].map((k) => [plan.places[k].group, plan.places[k].ord]), [[g1, 0], [g1, 1], [g1, 2], [g1, 3]]);
  assert.deepEqual(plan.places[b], { group: g1, milestone: ms, pinned: true, ord: 1 });

  plan = (await send("PUT", `/api/boards/${id}/plan/order`, { group: g1, items: [c, a, c, pair, b] })).body.plan;
  assert.deepEqual([c, a, pair, b].map((k) => plan.places[k].ord), [0, 1, 2, 3]);
  assert.equal(plan.places[b].pinned, true); assert.equal(plan.places[b].milestone, ms);

  plan = (await send("PUT", `/api/boards/${id}/plan/order`, { group: g2, items: [b] })).body.plan;
  assert.deepEqual(plan.places[b], { group: g2, milestone: ms, pinned: true, ord: 0 });
  assert.equal(plan.places[c].group, g1);
  plan = (await send("PUT", `/api/boards/${id}/plan/order`, { group: null, items: [pair, b] })).body.plan;
  assert.deepEqual([plan.places[pair], plan.places[b]].map((p) => [p.group, p.ord]), [[null, 0], [null, 1]]);

  const before = JSON.stringify(plan);
  for (const bad of [
    { group: foreign, items: [a] }, { group: "g-nope", items: [a] },
    { group: g1, items: [a, "has space"] }, { group: g1, items: [a, "x".repeat(81)] }, { group: g1, items: [a, 7] },
    { group: g1, items: "not-a-list" }, { group: g1 }, { group: g1, items: Array.from({ length: 501 }, (_, i) => `i${i}`) },
  ]) assert.equal((await send("PUT", `/api/boards/${id}/plan/order`, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal(JSON.stringify(await planOf(id)), before);
  assert.equal((await send("PUT", `/api/boards/${id}/plan/order`, { group: null, items: Array.from({ length: 500 }, (_, i) => `i${i}`) })).status, 200);
});

test("places: pin and milestone each leave the other (and the order) alone; a foreign milestone is refused", async () => {
  const id = await newBoard("Places"), other = await newBoard("Elsewhere II");
  const g = (await send("POST", `/api/boards/${id}/plan/groups`, { name: "G" })).body.id;
  const ms = (await send("POST", `/api/boards/${id}/plan/milestones`, { name: "M" })).body.id;
  const foreign = (await send("POST", `/api/boards/${other}/plan/milestones`, { name: "theirs" })).body.id;
  const rid = await addSource(id, "p.md");

  let plan = (await send("PATCH", `/api/boards/${id}/plan/places/${rid}`, { pinned: true })).body.plan;
  assert.deepEqual(plan.places[rid], { group: null, milestone: null, pinned: true, ord: null });
  await send("PUT", `/api/boards/${id}/plan/order`, { group: g, items: [rid] });
  plan = (await send("PATCH", `/api/boards/${id}/plan/places/${rid}`, { milestone: ms })).body.plan;
  assert.deepEqual(plan.places[rid], { group: g, milestone: ms, pinned: true, ord: 0 });
  plan = (await send("PATCH", `/api/boards/${id}/plan/places/${rid}`, { pinned: false })).body.plan;
  assert.deepEqual(plan.places[rid], { group: g, milestone: ms, pinned: false, ord: 0 });
  plan = (await send("PATCH", `/api/boards/${id}/plan/places/${rid}`, { milestone: null })).body.plan;
  assert.deepEqual(plan.places[rid], { group: g, milestone: null, pinned: false, ord: 0 });

  for (const milestone of [foreign, "ms-nope"]) {
    const r = await send("PATCH", `/api/boards/${id}/plan/places/${rid}`, { milestone, pinned: true });
    assert.equal(r.status, 400);
  }
  assert.deepEqual((await planOf(id)).places[rid], { group: g, milestone: null, pinned: false, ord: 0 });
});

test("an item that leaves the board leaves no place behind: deleted source, deleted pair, moved pair", async () => {
  const id = await newBoard("Leaving"), dest = await newBoard("Destination");
  const g = (await send("POST", `/api/boards/${id}/plan/groups`, { name: "G" })).body.id;
  const [gone, full, filed] = [await addSource(id, "gone.md"), await addSource(id, "full.md"), await addSource(id, "filed.md")];
  const loose = (await send("POST", `/api/boards/${id}/pairs`, { label: "loose" })).body.id;
  const mover = (await send("POST", `/api/boards/${id}/pairs`, { label: "mover" })).body.id;
  const stays = await addSource(id, "stays.md");
  await send("PUT", `/api/boards/${id}/plan/order`, { group: g, items: [gone, full, filed, loose, mover, stays] });
  assert.equal(Object.keys(await planOf(id).then((p) => p.places)).length, 6);

  assert.equal((await send("DELETE", `/api/boards/${id}/resources/${gone}`)).status, 200);
  const afterFull = await send("DELETE", `/api/boards/${id}/resources/${full}?pairs=1`);
  assert.deepEqual(Object.keys(afterFull.body.state.plan.places).sort(), [filed, loose, mover, stays].sort());
  assert.equal((await send("DELETE", `/api/boards/${id}/pairs/${loose}`)).status, 200);

  assert.equal((await send("POST", `/api/boards/${id}/pairs/${mover}/move`, { to: dest })).status, 200);
  const filedPair = (await api(`/api/boards/${id}`)).body.pairs.find((p: { resourceId: string }) => p.resourceId === filed).id;
  const moved = await send("POST", `/api/boards/${id}/pairs/${filedPair}/move`, { to: dest });
  assert.equal(moved.status, 200);
  assert.deepEqual(Object.keys(moved.body.state.plan.places), [stays]);
  assert.deepEqual(bare(moved.body.destState.plan), EMPTY);
  assert.deepEqual(rows("SELECT item FROM board_places WHERE board_id IN (?,?)", id, dest).map((r) => r.item), [stays]);
});

test("deleting the board takes every plan row with it", async () => {
  const id = await newBoard("Doomed");
  await send("PUT", `/api/boards/${id}/plan/purpose`, { purpose: "be deleted" });
  const g = (await send("POST", `/api/boards/${id}/plan/groups`, { name: "G" })).body.id;
  const ms = (await send("POST", `/api/boards/${id}/plan/milestones`, { name: "M" })).body.id;
  const rid = await addSource(id, "d.md");
  await send("PUT", `/api/boards/${id}/plan/order`, { group: g, items: [rid] });
  await send("PATCH", `/api/boards/${id}/plan/places/${rid}`, { milestone: ms, pinned: true });
  const count = () => ["board_groups", "board_milestones", "board_places", "boards"].map((t) =>
    rows(`SELECT COUNT(*) n FROM ${t} WHERE ${t === "boards" ? "id" : "board_id"} = ?`, id)[0].n);
  assert.deepEqual(count(), [1, 1, 1, 1]);
  assert.equal((await send("DELETE", `/api/boards/${id}`)).status, 200);
  assert.deepEqual(count(), [0, 0, 0, 0]);
});

test("unknown boards, groups and milestones are 404s — on every route", async () => {
  const id = await newBoard("404s");
  const nope = "b-nosuchboard";
  const calls: [string, string, unknown?][] = [
    ["PUT", "purpose", { purpose: "x" }], ["POST", "groups", { name: "x" }], ["PATCH", "groups/g-x", { name: "x" }], ["DELETE", "groups/g-x"],
    ["POST", "milestones", { name: "x" }], ["PATCH", "milestones/ms-x", { name: "x" }], ["DELETE", "milestones/ms-x"],
    ["PUT", "order", { group: null, items: [] }], ["PATCH", "places/res-x", { pinned: true }],
  ];
  for (const [method, path, body] of calls) {
    const r = await send(method, `/api/boards/${nope}/plan/${path}`, body);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.body, { error: "no such board" });
  }
  for (const [method, path, error] of [
    ["PATCH", "groups/g-nope", "no such group"], ["DELETE", "groups/g-nope", "no such group"],
    ["PATCH", "milestones/ms-nope", "no such milestone"], ["DELETE", "milestones/ms-nope", "no such milestone"],
  ]) {
    const r = await send(method, `/api/boards/${id}/plan/${path}`, method === "PATCH" ? { name: "x" } : undefined);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.body, { error });
  }
  assert.deepEqual(bare(await planOf(id)), EMPTY);
  assert.deepEqual(rows("SELECT COUNT(*) n FROM board_places WHERE board_id = ?", nope)[0].n, 0);
});
