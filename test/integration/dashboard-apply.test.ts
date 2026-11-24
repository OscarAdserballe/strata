// dashboard_apply: an agent does what the reader does on the dashboard, and each op leaves the board as the reader's own route would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const server = useServer({ env: { STRATA_ROUTINE_STUB: "1" } });
let token = "", n = 0, k = 0;

const send = (path: string, method: string, body?: unknown) => server.api(path, {
  method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json", "Idempotency-Key": `dapply-${++k}-${Date.now()}` },
});
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return { text: res.content[0].text as string, isError: !!res.isError };
}
const apply = (ops: unknown[]) => call("dashboard_apply", { key: `apply-${++k}-${Date.now()}`, ops });
const dash = async () => (await server.api("/api/dashboard")).body as { tasks: any[]; inbox: any[] };
const archived = async () => ((await server.api("/api/dashboard/archive")).body as { tasks: any[] }).tasks;
const FROM = { source: "Slack · #beds · Mara", quote: "nobody reset the timer" };
const idsIn = (text: string, prefix: string) => [...text.matchAll(new RegExp(`\\b${prefix}[A-Za-z0-9]+`, "g"))].map((m) => m[0]);
// What a route and its op must agree on: everything but ids, times and the line saying Claude did it.
const same = (x: any) => { const { id: _i, at: _a, createdAt: _c, updatedAt: _u, clearedAt, updates: _up, ...rest } = x; return { ...rest, cleared: clearedAt !== null && clearedAt !== undefined }; };

test("setup", async () => {
  token = ((await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "apply", write: true }) })).body as { token: string }).token;
});

test("an agent drops what it filed, and keeps the rest in to-do or thinking, in one call", async () => {
  const added = await apply([
    { op: "add", title: "Duplicate podcast episode", from: FROM },
    { op: "add", title: "Reset the timer", from: FROM },
    { op: "add", title: "Measure the shelf", from: { source: "You" }, to: "thinking" },
  ]);
  assert.equal(added.isError, false, added.text);
  const [dup, timer] = idsIn(added.text, "in_");
  const moved = await apply([{ op: "move", id: dup, to: "dropped", because: "already on the board" }, { op: "move", id: timer, to: "todo" }]);
  assert.equal(moved.isError, false, moved.text);
  const d = await dash();
  assert.equal(d.inbox.some((i) => i.id === dup || i.id === timer), false, "both left the inbox");
  const kept = d.tasks.find((t) => t.title === "Reset the timer");
  assert.equal(kept.stage, "todo");
  assert.match(kept.updates.at(-1).text, /^Kept in todo by Claude$/);
  assert.equal(kept.updates.at(-1).from.source, "Claude");
  assert.equal(d.tasks.find((t) => t.title === "Measure the shelf").stage, "thinking", "add with to makes a thread directly");
});

test("move to dropped is delete: off the board, in the archive, and the reader brings it back", async () => {
  const [id] = idsIn((await apply([{ op: "add", title: "Old idea", from: FROM, to: "todo" }])).text, "t_");
  const r = await apply([{ op: "move", id, to: "dropped", because: "superseded" }]);
  assert.equal(r.isError, false, r.text);
  assert.equal((await dash()).tasks.some((t) => t.id === id), false);
  const gone = (await archived()).find((t) => t.id === id);
  assert.equal(gone.stage, "dropped");
  assert.match(gone.updates.at(-1).text, /todo → dropped by Claude: superseded/);
  assert.equal((await send(`/api/dashboard/tasks/${id}`, "PATCH", { stage: "todo", cleared: false })).status, 200);
  assert.equal((await dash()).tasks.find((t) => t.id === id).stage, "todo");
});

test("send dispatches a thread at once, with the brief in its notes; Dispatch-only stages stay out of reach", async () => {
  const [id] = idsIn((await apply([{ op: "add", title: "Research the cheapest x-ray", from: FROM, to: "todo" }])).text, "t_");
  const r = await apply([{ op: "send", id, brief: "Find three clinics near Nørrebro and their prices." }]);
  assert.equal(r.isError, false, r.text);
  const t = (await dash()).tasks.find((x) => x.id === id);
  assert.equal(t.stage, "implementing");
  assert.match(t.body, /Brief from Claude: Find three clinics/);
  const opened = JSON.parse((await call("dashboard_read", { task: id, as: "json" })).text);
  assert.equal(opened.stage, "implementing", "dashboard_read as json opens the thread, as dashboard_open did");

  for (const to of ["implementing", "decide", "finish"]) {
    const no = await apply([{ op: "move", id, to }]);
    assert.equal(no.isError, true, `move to ${to} is refused`);
  }
  assert.match((await apply([{ op: "move", id, to: "todo" }])).text, /implementing, with a run/);
});

test("all or nothing: one bad op writes none, and a resent key replays", async () => {
  const before = (await dash()).inbox.length;
  const bad = await apply([{ op: "add", title: "Should not land", from: FROM }, { op: "move", id: "t_nothere", to: "todo" }]);
  assert.equal(bad.isError, true);
  assert.match(bad.text, /ops\[1\] \(move\): No thread t_nothere\. Nothing was applied\./);
  assert.equal((await dash()).inbox.length, before, "the add before it rolled back");

  const args = { key: "apply-replay-000001", ops: [{ op: "pad", text: "Remember the measurements." }] };
  const once = await call("dashboard_apply", args);
  assert.equal((await call("dashboard_apply", args)).text, once.text);
  const pad = (await server.api("/api/dashboard/pad")).body as { text: string };
  assert.equal(pad.text.split("Remember the measurements.").length - 1, 1, "the pad got one line, not two");

  const four = await apply(["a", "b", "c", "d"].map((x) => ({ op: "send", id: `t_${x}aaaa` })));
  assert.match(four.text, /At most 3 sends/);
});

test("each op leaves the board as the reader's own route does", async () => {
  const pair = async (title: string) => {
    const r = await apply([{ op: "add", title, from: FROM }, { op: "add", title, from: FROM }]);
    return idsIn(r.text, "in_") as [string, string];
  };
  const item = async (id: string) => (await dash()).inbox.find((i) => i.id === id);
  const task = async (title: string) => (await dash()).tasks.filter((t) => t.title === title);

  // edit an inbox item
  const [a, b] = await pair("Edit me");
  await send(`/api/dashboard/inbox/${a}`, "PATCH", { title: "Edited", context: "Now with context" });
  await apply([{ op: "edit", id: b, title: "Edited", context: "Now with context" }]);
  assert.deepEqual(same(await item(b)), same(await item(a)), "edit = PATCH inbox/:id");

  // keep in thinking
  const [c, d] = await pair("Keep me");
  await send(`/api/dashboard/inbox/${c}/keep`, "POST", { stage: "thinking" });
  await apply([{ op: "move", id: d, to: "thinking" }]);
  const [byYou, byAgent] = await task("Keep me");
  assert.deepEqual(same(byAgent), same(byYou), "move = POST inbox/:id/keep");

  // edit and move a thread
  await send(`/api/dashboard/tasks/${byYou.id}`, "PATCH", { title: "Kept and renamed", body: "New notes", stage: "review" });
  await apply([{ op: "edit", id: byAgent.id, title: "Kept and renamed", body: "New notes" }, { op: "move", id: byAgent.id, to: "review" }]);
  const [x, y] = await task("Kept and renamed");
  assert.deepEqual(same(y), same(x), "edit + move = PATCH tasks/:id");

  // done clears it, as the page's move does
  await send(`/api/dashboard/tasks/${x.id}`, "PATCH", { stage: "done", cleared: true });
  await apply([{ op: "move", id: y.id, to: "done" }]);
  const gone = (await archived()).filter((t) => t.title === "Kept and renamed");
  assert.equal(gone.length, 2);
  assert.deepEqual(same(gone[1]), same(gone[0]), "move done = the page's Done");

  // drop
  const [e, f] = await pair("Drop me");
  await send(`/api/dashboard/inbox/${e}/drop`, "POST", {});
  await apply([{ op: "move", id: f, to: "dropped" }]);
  assert.equal(await item(e), undefined);
  assert.equal(await item(f), undefined, "move dropped = POST inbox/:id/drop");
});

test("the old tool names still answer, for a release", async () => {
  const board = JSON.parse((await call("dashboard_board")).text);
  assert.deepEqual(JSON.parse((await call("dashboard_read", { as: "json" })).text), board);
});
