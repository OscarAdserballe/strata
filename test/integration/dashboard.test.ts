// The dashboard: its page, its routes, and the two MCP tools that feed and read it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";

const server = useServer();
let token = "", n = 0;

const send = (path: string, method: string, body?: unknown, key?: string) => server.api(path, {
  method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
});
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return { text: res.content[0].text as string, isError: !!res.isError };
}
const dash = async () => (await server.api("/api/dashboard")).body as { tasks: any[]; inbox: any[]; archived: number };
const archive = async () => (await server.api("/api/dashboard/archive")).body as { tasks: any[] };
const FROM = { source: "Slack · #beds · Mara", url: "https://example.slack.com/archives/C1/p1", quote: "the valves are replaced but nobody reset the timer" };

test("the page is served at /dashboard and starts empty", async () => {
  token = ((await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "collector", write: true }) })).body as { token: string }).token;
  const page = await server.fetch("/dashboard");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Focus<\/title>/);
  assert.match(html, /<script nonce="/, "inline scripts carry the response's CSP nonce");
  assert.deepEqual(await dash(), { rev: 0, tasks: [], inbox: [], archived: 0, links: [] });
});

test("an agent adds tasks with a line of context; you send each to the backlog or to-do, and the thread holds what was asked", async () => {
  const items = [
    { title: "Fix the sticking gate on \"#12\"", context: "The latch jams on \"#12\" after rain. Two people hit it this week.", from: { source: "Notion · Garden committee sync · 23 Oct" },
      links: [{ kind: "slack", ref: "#north-beds", url: "https://example.slack.com/archives/C1/p1" }, { kind: "linear", ref: "GD-247", title: "Earlier latch repair" }] },
    { kind: "task", title: "Reset the shared timer for bed six", from: FROM },
  ];
  const added = await call("dashboard_add_items", { key: "collect-run-000001", items });
  assert.equal(added.isError, false, added.text);
  assert.match(added.text, /^2 in the dashboard inbox: in_\w+, in_\w+\. The reader keeps or drops each\.$/);
  assert.equal((await call("dashboard_add_items", { key: "collect-run-000001", items })).text, added.text, "a resent key adds nothing and replays the answer");

  const { inbox } = await dash();
  assert.deepEqual(inbox.map((i) => [i.kind, i.area]), [["task", "work"], ["task", "work"]], "the area is guessed from the source");
  assert.equal(inbox[0].context, "The latch jams on \"#12\" after rain. Two people hit it this week.");
  const kept = await send(`/api/dashboard/inbox/${inbox[0].id}/keep`, "POST", {}, "dash-keep-000001");
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  const todo = await send(`/api/dashboard/inbox/${inbox[1].id}/keep`, "POST", { stage: "todo" }, "dash-keep-000002");
  assert.equal(todo.status, 200, JSON.stringify(todo.body));
  assert.equal((await send(`/api/dashboard/inbox/${inbox[0].id}/keep`, "POST", { stage: "todo" }, "dash-keep-000003")).body.outcome, "kept", "keeping twice makes nothing new");

  const after = await dash();
  assert.equal(after.inbox.length, 0);
  const gate = after.tasks.find((t) => t.title.startsWith("Fix the sticking"));
  assert.deepEqual([gate.stage, gate.body, gate.links.length, gate.createdFrom.source], ["backlog", "The latch jams on \"#12\" after rain. Two people hit it this week.", 2, "Notion · Garden committee sync · 23 Oct"], "the context becomes the thread's notes");
  assert.equal(after.tasks.find((t) => t.title.startsWith("Reset")).stage, "todo");
  assert.equal(after.tasks.find((t) => t.title.startsWith("Reset")).createdFrom.quote, FROM.quote);
});

test("dashboard_add_items takes tasks only, refuses a bad item and writes none of the batch", async () => {
  const before = (await dash()).inbox.length;
  const bad = await call("dashboard_add_items", { key: "collect-bad-00001", items: [{ title: "Fine on its own", from: FROM }, { title: "No source" }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /items\[1\]\.from/);
  assert.match((await call("dashboard_add_items", { key: "collect-bad-00002", items: [{ kind: "update", title: "y", from: FROM }] })).text, /items\[0\]\.kind is task/);
  assert.match((await call("dashboard_add_items", { key: "collect-bad-00003", items: [{ title: "x", from: FROM, links: [{ kind: "jira", ref: "X-1" }] }] })).text, /kind is one of linear/);
  assert.match((await call("dashboard_add_items", { key: "collect-bad-00004", items: [{ title: "x", area: "hobby", from: FROM }] })).text, /area is work or personal/);
  const long = await call("dashboard_add_items", { key: "collect-bad-00005", items: [{ title: "Long context", context: "x".repeat(900), from: FROM }] });
  assert.equal(long.isError, false);
  const row = (await dash()).inbox.find((i) => i.title === "Long context");
  assert.equal(row.context.length, 400, "context is cut to a line or two");
  await send(`/api/dashboard/inbox/${row.id}/drop`, "POST", {}, "dash-drop-long-01");
  assert.equal((await dash()).inbox.length, before);
});

test("threads move between stages by hand; a pick for tomorrow morning lifts a backlog thread into to-do", async () => {
  const { tasks } = await dash();
  const gate = tasks.find((t) => t.title.startsWith("Fix the sticking"));
  const picked = await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { morning: true }, "dash-move-00001");
  assert.equal(picked.status, 200);
  assert.deepEqual([picked.body.stage, picked.body.morningAt > 0], ["todo", true]);
  assert.equal((await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { stage: "thinking" }, "dash-move-00002")).body.stage, "thinking");
  const reviewed = await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { stage: "review", links: [{ kind: "github", ref: "trynolan/nolan#1438", url: "https://github.com/trynolan/nolan/pull/1438" }] }, "dash-move-00003");
  assert.deepEqual([reviewed.body.stage, reviewed.body.links.length], ["review", 1], "links are replaced, so Review's artifacts are whatever you pasted last");
  assert.equal((await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { stage: "nowhere" }, "dash-move-00004")).status, 400);
  assert.equal((await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { morning: "yes" }, "dash-move-00005")).status, 400);
  assert.equal((await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { state: "claude" }, "dash-move-00006")).body.stage, "review", "the old state field is ignored, not an error");
  const unpicked = await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { morning: false }, "dash-move-00007");
  assert.equal(unpicked.body.morningAt, null);

  const own = await send("/api/dashboard/inbox", "POST", { title: "Seed catalogue order" }, "dash-own-000001");
  assert.equal(own.status, 201);
  assert.equal((await send(`/api/dashboard/inbox/${own.body.id}/drop`, "POST", {}, "dash-drop-00001")).status, 200);
  assert.equal((await send(`/api/dashboard/inbox/${own.body.id}/keep`, "POST", {}, "dash-keep-dropped")).body.outcome, "dropped", "a dropped item can't be kept later");
  assert.equal((await dash()).tasks.some((t) => t.title === "Seed catalogue order"), false);
});

test("dashboard_read gives the board by stage as Markdown, and one thread in full", async () => {
  await call("dashboard_add_items", { key: "collect-read-0001", items: [{ title: "Rain gauge reading", context: "Mara asked for last week's numbers.", from: { source: "Notion · Garden committee sync · 23 Oct" } }] });
  const all = await call("dashboard_read");
  assert.equal(all.isError, false, all.text);
  assert.match(all.text, /^# Dashboard · /);
  assert.match(all.text, /Inbox 1 · Backlog \d+ · To-do \d+ · Thinking \d+ · Decide \d+ · Implementing \d+ · Review 1/);
  assert.match(all.text, /## Review\n### Fix the sticking gate on "#12" · t_\w+ · work\nLinks: github trynolan\/nolan#1438 <https:\/\/github\.com\/trynolan\/nolan\/pull\/1438>\nFrom: Notion · Garden committee sync · 23 Oct\n\nThe latch jams/);
  assert.match(all.text, /## Inbox\n- in_\w+ · "Rain gauge reading" · from Notion · Garden committee sync · 23 Oct\n  Mara asked for last week's numbers\./);
  assert.doesNotMatch(all.text, /Scratch pad|## Sources/);

  const one = await call("dashboard_read", { task: "Reset the shared timer for bed six" });
  assert.match(one.text, /^### Reset the shared timer for bed six · t_\w+ · work\nFrom: Slack · #beds · Mara — "the valves are replaced/);
  assert.match((await call("dashboard_read", { stages: ["thinking"] })).text, /Nothing on the dashboard yet\./);
  assert.match((await call("dashboard_read", { task: "nope" })).text, /No task "nope"/);
});

test("an inbox item is edited before it is kept, and an item from before of another kind keeps as a task", async () => {
  const own = await send("/api/dashboard/inbox", "POST", { title: "Investigate late deliveries" }, "dash-edit-own-001");
  const edited = await send(`/api/dashboard/inbox/${own.body.id}`, "PATCH", { title: "Investigate late compost deliveries", context: "Deliveries land hours late." }, "dash-edit-0001");
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const later = await send(`/api/dashboard/inbox/${own.body.id}`, "PATCH", { area: "work" }, "dash-edit-0002");
  assert.deepEqual([later.body.title, later.body.area], ["Investigate late compost deliveries", "work"], "a later edit to another field keeps the first");
  assert.equal((await send(`/api/dashboard/inbox/${own.body.id}`, "PATCH", { kind: "fragment" }, "dash-edit-0003")).body.kind, "task", "there is only one kind of item now");
  const kept = await send(`/api/dashboard/inbox/${own.body.id}/keep`, "POST", {}, "dash-edit-keep-1");
  const t = (await dash()).tasks.find((x) => x.id === kept.body.result);
  assert.deepEqual([t.title, t.body, t.stage, t.area], ["Investigate late compost deliveries", "Deliveries land hours late.", "backlog", "work"]);
  assert.equal((await send(`/api/dashboard/inbox/${own.body.id}`, "PATCH", { title: "too late" }, "dash-edit-0004")).status, 400, "a triaged item can't be edited");
  const odd = await send("/api/dashboard/inbox", "POST", { title: "Odd stage" }, "dash-edit-own-002");
  assert.equal((await send(`/api/dashboard/inbox/${odd.body.id}/keep`, "POST", { stage: "done" }, "dash-edit-keep-2")).status, 400, "an item can only be kept into an open stage");

  // Items an older routine left in the inbox as updates or fragments still keep, as plain tasks.
  assert.equal((await send("/api/dashboard/inbox", "POST", { kind: "update", title: "x", from: FROM }, "dash-old-kind-000")).status, 400, "nothing new of the old kinds comes in");
  const db = new DatabaseSync(server.db, { timeout: 5000 });
  try {
    db.prepare("INSERT INTO dashboard_inbox (id,kind,item,at) VALUES (?,?,?,?)").run("in_oldupd01", "update",
      JSON.stringify({ kind: "update", task: "t_gone", text: "Mara wants the seed count first.\nThen the rota.", from: FROM, links: [] }), Date.now());
  } finally { db.close(); }
  assert.ok((await dash()).inbox.some((i) => i.id === "in_oldupd01"));
  const asTask = await send("/api/dashboard/inbox/in_oldupd01/keep", "POST", {}, "dash-old-kind-002");
  assert.equal(asTask.status, 200, JSON.stringify(asTask.body));
  const made = (await dash()).tasks.find((x) => x.id === asTask.body.result);
  assert.deepEqual([made.title, made.body], ["Mara wants the seed count first.", "Mara wants the seed count first.\nThen the rota."]);
});

test("done and dropped threads go to the archive and come back to the backlog", async () => {
  const { tasks } = await dash();
  const a = tasks.find((t) => t.title.startsWith("Investigate late"));
  const b = tasks.find((t) => t.title.startsWith("Mara wants"));
  const done = await send(`/api/dashboard/tasks/${a.id}`, "PATCH", { stage: "done", cleared: true }, "dash-done-00001");
  assert.deepEqual([done.body.stage, done.body.morningAt, done.body.clearedAt > 0], ["done", null, true]);
  await send(`/api/dashboard/tasks/${b.id}`, "PATCH", { stage: "dropped", cleared: true }, "dash-done-00002");
  const board = await dash();
  assert.equal(board.tasks.some((t) => t.id === a.id || t.id === b.id), false, "cleared threads leave the board");
  assert.equal(board.archived, 2);
  assert.doesNotMatch((await call("dashboard_read")).text, /Investigate late/);
  assert.match((await call("dashboard_read", { done_since: "2020-01-01" })).text, /## Done\n### Investigate late compost deliveries · t_\w+ · work · archived/);
  assert.deepEqual((await archive()).tasks.map((t) => t.id).sort(), [a.id, b.id].sort());
  const back = await send(`/api/dashboard/tasks/${a.id}`, "PATCH", { cleared: false, stage: "backlog" }, "dash-done-00003");
  assert.deepEqual([back.body.clearedAt, back.body.stage], [null, "backlog"]);
  assert.ok((await dash()).tasks.some((t) => t.id === a.id), "a restored thread is back on the board");
});

test("every thread is work or personal: guessed from its source, set by the agent or the page, and dashboard_read filters by it", async () => {
  const r = await call("dashboard_add_items", { key: "collect-area-0001", items: [
    { title: "Area from Slack", from: { source: "Slack · #beds · 24 Oct" } },
    { title: "Area from a brain dump", from: { source: "Notion · Personal brain dump · 22 Oct" } },
    { title: "Area said outright", area: "work", from: { source: "Notion · Personal brain dump · 22 Oct" } },
  ] });
  assert.equal(r.isError, false, r.text);
  const inbox = (await dash()).inbox.filter((i) => String(i.title).startsWith("Area "));
  assert.deepEqual(inbox.map((i) => i.area), ["work", "personal", "work"]);
  const moved = await send(`/api/dashboard/inbox/${inbox[1].id}`, "PATCH", { area: "work" }, "dash-area-edit-01");
  assert.equal(moved.body.area, "work", "triage can change the area before keeping");
  for (const i of inbox) await send(`/api/dashboard/inbox/${i.id}/keep`, "POST", {}, `dash-area-keep-${i.id.slice(3)}`);
  const tasks = (await dash()).tasks.filter((t) => t.title.startsWith("Area "));
  assert.ok(tasks.length === 3 && tasks.every((t) => t.area === "work"));
  const back = await send(`/api/dashboard/tasks/${tasks[0].id}`, "PATCH", { area: "personal" }, "dash-area-move-01");
  assert.equal(back.body.area, "personal");
  assert.equal((await send(`/api/dashboard/tasks/${tasks[0].id}`, "PATCH", { area: "hobby" }, "dash-area-move-02")).status, 400);
  const mine = await send("/api/dashboard/tasks", "POST", { id: "t_areawork1", title: "Made on the work board", area: "work", stage: "todo" }, "dash-area-make-01");
  assert.equal(mine.status, 201);
  assert.deepEqual([(await dash()).tasks.find((t) => t.id === "t_areawork1").area, (await dash()).tasks.find((t) => t.id === "t_areawork1").stage], ["work", "todo"]);
  assert.equal((await send("/api/dashboard/tasks", "POST", { id: "t_areawork2", title: "Nowhere", stage: "done" }, "dash-area-make-02")).status, 400, "a new thread starts in an open stage");
  const work = (await call("dashboard_read", { area: "work" })).text;
  assert.match(work, /^# Dashboard · work · /);
  assert.match(work, /## To-do\n(### [^\n]*\n[^#][^\n]*\n\n)*### Made on the work board · t_areawork1 · work/);
  assert.doesNotMatch(work, /Area from Slack/, "a thread moved to personal leaves the work read");
});

test("every write answers with the board and the Dispatch pane as they now are, under a revision that only rises", async () => {
  const before = (await dash()) as unknown as { rev: number };
  const made = await send("/api/dashboard/tasks", "POST", { id: "t_revcheck01", title: "Revision check", area: "work" }, "dash-rev-000001");
  assert.equal(made.status, 201);
  assert.ok(made.body.board.rev >= before.rev, "the answer's board is no older than what was read");
  assert.ok(made.body.board.tasks.some((t: { id: string }) => t.id === "t_revcheck01"), "the answer holds the write");
  assert.equal(made.body.pane.rev, made.body.board.rev, "the board and the pane share one revision");
  const moved = await send("/api/dashboard/tasks/t_revcheck01", "PATCH", { stage: "todo" }, "dash-rev-000002");
  assert.ok(moved.body.board.rev >= made.body.board.rev);
  assert.equal(moved.body.board.tasks.find((t: { id: string }) => t.id === "t_revcheck01").stage, "todo");
});
