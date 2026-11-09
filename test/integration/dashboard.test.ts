// The dashboard: its page, its routes, and the MCP tools that feed and read it.
import { test } from "node:test";
import assert from "node:assert/strict";
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
const dash = async () => (await server.api("/api/dashboard")).body as { tasks: any[]; inbox: any[]; pad: { text: string; rev: number }; archived: number };
const archive = async () => (await server.api("/api/dashboard/archive")).body as { tasks: any[]; sources: any[] };
const FROM = { source: "Notion · 1:1 with Mara · 23 Oct", quote: "the valves are replaced but nobody reset the timer" };

test("the page is served at /dashboard and starts empty", async () => {
  token = ((await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "dispatcher", write: true }) })).body as { token: string }).token;
  const page = await server.fetch("/dashboard");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>Focus<\/title>/);
  assert.match(html, /<script nonce="/, "inline scripts carry the response's CSP nonce");
  assert.deepEqual(await dash(), { tasks: [], inbox: [], pad: { text: "", rev: 0 }, archived: 0, links: [] });
});

test("an agent adds a task, a subtask and an update; you keep them and the board holds what was asked", async () => {
  const made = await send("/api/dashboard/tasks", "POST", { id: "t_fail0001", title: "Watering log, one sheet", body: "One sheet for every bed." }, "dash-create-0001");
  assert.equal(made.status, 201);
  await send("/api/dashboard/tasks", "POST", { id: "t_ir000001", title: "Compost rota", body: "Four volunteers signed up." }, "dash-create-0002");

  const items = [
    { kind: "task", title: "Fix the sticking gate on \"#12\"", body: "The latch jams on \"#12\" after rain.", from: { source: "Notion · Garden committee sync · 23 Oct" }, why: "No tracker issue matches.",
      links: [{ kind: "slack", ref: "#north-beds", url: "https://example.slack.com/archives/C1/p1" }, { kind: "linear", ref: "GD-247", title: "Earlier latch repair" }] },
    { kind: "subtask", parent: "Watering log, one sheet", title: "Reset the shared timer for bed six", from: FROM, why: "Needs the shed key." },
    { kind: "update", task: "t_ir000001", text: "Mara wants the seed count first.", from: FROM, links: [{ kind: "linear", ref: "GD-836" }] },
  ];
  const added = await call("dashboard_add_items", { key: "dispatch-run-000001", items });
  assert.equal(added.isError, false, added.text);
  assert.match(added.text, /^3 in the dashboard inbox: in_\w+, in_\w+, in_\w+\./);
  assert.equal((await call("dashboard_add_items", { key: "dispatch-run-000001", items })).text, added.text, "a resent key adds nothing and replays the answer");

  const { inbox } = await dash();
  assert.deepEqual(inbox.map((i) => i.kind), ["task", "subtask", "update"]);
  assert.equal(inbox[1].parent, "t_fail0001", "a parent named by title is stored as its id");

  for (const i of inbox) {
    const kept = await send(`/api/dashboard/inbox/${i.id}/keep`, "POST", {}, `dash-keep-${i.id.replace("_", "-")}`);
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
  }
  assert.equal((await send(`/api/dashboard/inbox/${inbox[0].id}/keep`, "POST", {}, `dash-keep-again-${inbox[0].id.replace("_", "-")}`)).body.outcome, "kept", "keeping twice makes nothing new");

  const after = await dash();
  assert.equal(after.inbox.length, 0);
  assert.equal(after.tasks.length, 4);
  const gate = after.tasks.find((t) => t.title.startsWith("Fix the sticking"));
  assert.equal(gate.stage, "backlog", "a kept task starts in the backlog");
  assert.equal(gate.state, "you", "the old state column stays in step");
  assert.equal(gate.links.length, 2);
  assert.equal(gate.createdFrom.source, "Notion · Garden committee sync · 23 Oct");
  assert.equal(after.tasks.find((t) => t.title.startsWith("Reset"))?.parent, "t_fail0001");
  const ir = after.tasks.find((t) => t.id === "t_ir000001");
  assert.equal(ir.updates.length, 1);
  assert.equal(ir.updates[0].text, "Mara wants the seed count first.");
  assert.deepEqual(ir.links.map((l: { ref: string }) => l.ref), ["GD-836"], "an update's links join its task");
});

test("dashboard_add_items refuses a bad item and writes none of the batch", async () => {
  const before = (await dash()).inbox.length;
  const bad = await call("dashboard_add_items", { key: "dispatch-bad-00001", items: [
    { kind: "task", title: "Fine on its own", from: FROM },
    { kind: "subtask", parent: "No such task", title: "Orphan", from: FROM },
  ] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /items\[1\]\.parent "No such task" matches no task/);
  assert.match((await call("dashboard_add_items", { key: "dispatch-bad-00002", items: [{ kind: "subtask", parent: "Reset the shared timer for bed six", title: "Too deep", from: FROM }] })).text, /subtasks go one level deep/);
  assert.match((await call("dashboard_add_items", { key: "dispatch-bad-00003", items: [{ kind: "task", title: "No source" }] })).text, /items\[0\]\.from/);
  assert.match((await call("dashboard_add_items", { key: "dispatch-bad-00004", items: [{ kind: "task", title: "x", from: FROM, links: [{ kind: "jira", ref: "X-1" }] }] })).text, /kind is one of linear/);
  assert.equal((await dash()).inbox.length, before);
});

test("tasks move between stages, nest one level deep, and drop items stay dropped", async () => {
  const { tasks } = await dash();
  const gate = tasks.find((t) => t.title.startsWith("Fix the sticking"));
  const moved = await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { stage: "todo" }, "dash-move-00001");
  assert.equal(moved.status, 200);
  assert.equal(moved.body.stage, "todo");
  assert.equal(moved.body.state, "you");
  const picked = await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { morning: true }, "dash-move-00002");
  assert.ok(picked.body.morningAt > 0, "picked for tomorrow morning");
  assert.equal(picked.body.pinnedAt, picked.body.morningAt, "pinned_at mirrors the pick for older readers");
  assert.equal((await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { stage: "thinking" }, "dash-move-00003")).body.stage, "thinking");
  const legacy = await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { state: "claude" }, "dash-move-00004");
  assert.equal(legacy.body.stage, "review", "an older caller's claude state lands in review");
  assert.equal((await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { stage: "nowhere" }, "dash-move-00005")).status, 400);
  assert.equal((await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { state: "nowhere" }, "dash-move-00006")).status, 400);

  const sub = tasks.find((t) => t.title.startsWith("Reset"));
  const deep = await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { parent: sub.id }, "dash-nest-00001");
  assert.equal(deep.status, 400);
  assert.match(deep.body.error, /one level deep/);
  const parentOfKids = await send("/api/dashboard/tasks/t_fail0001", "PATCH", { parent: gate.id }, "dash-nest-00002");
  assert.match(parentOfKids.body.error, /has subtasks of its own/);
  assert.equal((await send(`/api/dashboard/tasks/${gate.id}`, "PATCH", { parent: "t_ir000001", prompt: "Mine now." }, "dash-nest-00003")).body.parent, "t_ir000001");

  const own = await send("/api/dashboard/inbox", "POST", { kind: "task", title: "Seed catalogue order" }, "dash-own-000001");
  assert.equal(own.status, 201);
  assert.equal((await send(`/api/dashboard/inbox/${own.body.id}/drop`, "POST", {}, "dash-drop-00001")).status, 200);
  assert.equal((await send(`/api/dashboard/inbox/${own.body.id}/keep`, "POST", {}, "dash-keep-dropped")).body.outcome, "dropped", "a dropped item can't be kept later");
  assert.equal((await dash()).tasks.some((t) => t.title === "Seed catalogue order"), false);
});

test("dashboard_read gives the board as Markdown, and one task in full", async () => {
  await call("dashboard_add_items", { key: "dispatch-read-0001", items: [{ kind: "task", title: "Rain gauge reading", from: { source: "Notion · Garden committee sync · 23 Oct" } }] });
  const all = await call("dashboard_read");
  assert.equal(all.isError, false, all.text);
  assert.match(all.text, /^# Dashboard · /);
  assert.match(all.text, /Inbox 1 · Backlog \d+ · To-do \d+ · Thinking \d+ · Review 1/);
  assert.match(all.text, /## Review\n### Fix the sticking gate on "#12" · t_\w+ · work · under Compost rota/);
  assert.match(all.text, /Links: slack #north-beds <https:\/\/example\.slack\.com\/archives\/C1\/p1> · linear GD-247 \(Earlier latch repair\)/);
  assert.match(all.text, /── \d{4}-\d\d-\d\d \d\d:\d\d · Notion · 1:1 with Mara · 23 Oct ──\nMara wants the seed count first\./);
  assert.match(all.text, /## Inbox\n- in_\w+ · task · "Rain gauge reading" · from Notion · Garden committee sync · 23 Oct/);

  const one = await call("dashboard_read", { task: "Compost rota" });
  assert.match(one.text, /^### Compost rota · t_ir000001/);
  assert.match(one.text, /Subtasks: Fix the sticking gate on "#12" \(t_\w+, review\)/);
  assert.match((await call("dashboard_read", { stages: ["thinking"] })).text, /Nothing on the dashboard yet\./);
  assert.match((await call("dashboard_read", { states: ["claude"] })).text, /## Review\n### Fix the sticking gate/, "an older prompt's state names still narrow");
  assert.match((await call("dashboard_read", { task: "nope" })).text, /No task "nope"/);
});

test("a fragment arrives with directions, gets more on request, and keeps as the tasks you pick", async () => {
  const from = { source: "Notion · Personal brain dump · 23 Oct", url: "https://app.notion.com/p/abc" };
  const added = await call("dashboard_add_items", { key: "dispatch-frag-0001", items: [
    { kind: "fragment", title: "Seed library from Mara's harvest notes", body: "can we build a seed library straight from Mara's harvest notes?", why: "Could be a spike, a tool or a question.", from,
      directions: [{ title: "Spike: catalogue one bed's seeds", body: "Half a day." }, { title: "Ask Mara which notes cover the autumn beds" }] },
  ], sources: [{ source: from.source, url: from.url, coverage: "partial", note: "The reading list is not drafted yet." }] });
  assert.equal(added.isError, false, added.text);
  assert.match(added.text, /Noted 1 source\./);
  const frag = (await dash()).inbox.find((i) => i.kind === "fragment");
  assert.equal(frag.directions.length, 2);

  assert.equal((await send(`/api/dashboard/inbox/${frag.id}`, "PATCH", { wantsMore: true }, "dash-frag-more-01")).status, 200);
  assert.match((await call("dashboard_read")).text, new RegExp(`${frag.id} · fragment · "Seed library from Mara's harvest notes" · from Notion · Personal brain dump · 23 Oct · wants more directions`));
  const more = await call("dashboard_add_items", { key: "dispatch-frag-0002", items: [{ kind: "fragment", fragment: frag.id, directions: [{ title: "List the beds with no notes" }], from }] });
  assert.equal(more.isError, false, more.text);
  const grown = (await dash()).inbox.find((i) => i.id === frag.id);
  assert.equal(grown.directions.length, 3, "directions join the open fragment instead of making a new one");
  assert.equal(grown.wantsMore, false);
  assert.match((await call("dashboard_add_items", { key: "dispatch-frag-0003", items: [{ kind: "fragment", fragment: "in_nope", directions: [{ title: "x" }], from }] })).text, /is no open fragment/);

  const kept = await send(`/api/dashboard/inbox/${frag.id}/keep`, "POST", { picked: [0, 2], own: ["Write it up for Mara"] }, "dash-frag-keep-01");
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal(kept.body.result.split(",").length, 3);
  const made = (await dash()).tasks.filter((t) => kept.body.result.split(",").includes(t.id));
  assert.deepEqual(made.map((t) => t.title).sort(), ["List the beds with no notes", "Spike: catalogue one bed's seeds", "Write it up for Mara"]);
  assert.ok(made.every((t) => t.stage === "backlog" && t.createdFrom.source === from.source));
  assert.equal(made.find((t) => t.title.startsWith("Spike")).body,
    "## Context\nHalf a day.\n\nFrom the fragment “Seed library from Mara's harvest notes”: can we build a seed library straight from Mara's harvest notes?\n\n## Sources\n- Notion · Personal brain dump · 23 Oct <https://app.notion.com/p/abc>");

  await call("dashboard_add_items", { key: "dispatch-frag-0004", items: [{ kind: "fragment", title: "Plain fragment", body: "just a thought", from: { source: "Notion · Another dump · 24 Oct" }, directions: [{ title: "A way" }] }] });
  const plain = (await dash()).inbox.find((i) => i.title === "Plain fragment");
  const asOne = await send(`/api/dashboard/inbox/${plain.id}/keep`, "POST", { stage: "todo" }, "dash-frag-keep-02");
  assert.equal(asOne.status, 200, JSON.stringify(asOne.body));
  const one = (await dash()).tasks.find((t) => t.id === asOne.body.result);
  assert.deepEqual([one.title, one.body, one.stage], ["Plain fragment", "just a thought", "todo"], "no direction picked keeps the fragment as one task, in the stage asked for");
});

test("an inbox draft is edited before it is kept, and becomes a fragment when too fuzzy", async () => {
  const own = await send("/api/dashboard/inbox", "POST", { kind: "task", title: "Investigate late deliveries" }, "dash-edit-own-001");
  const body = "## Context\nDeliveries land hours late.\n\n## Done when\n- They arrive before noon.";
  const edited = await send(`/api/dashboard/inbox/${own.body.id}`, "PATCH", { title: "Investigate late compost deliveries", body }, "dash-edit-0001");
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const later = await send(`/api/dashboard/inbox/${own.body.id}`, "PATCH", { why: "Two people saw it." }, "dash-edit-0002");
  assert.equal(later.body.title, "Investigate late compost deliveries", "a later edit to another field keeps the first");
  const kept = await send(`/api/dashboard/inbox/${own.body.id}/keep`, "POST", {}, "dash-edit-keep-1");
  const t = (await dash()).tasks.find((x) => x.id === kept.body.result);
  assert.equal(t.title, "Investigate late compost deliveries");
  assert.equal(t.body, body);
  assert.equal(t.stage, "backlog");
  assert.equal((await send(`/api/dashboard/inbox/${own.body.id}`, "PATCH", { title: "too late" }, "dash-edit-0003")).status, 400, "a triaged item can't be edited");
  assert.equal((await send(`/api/dashboard/inbox/${own.body.id}/keep`, "POST", { stage: "done" }, "dash-edit-keep-2")).body.outcome, "kept", "a kept item replays; the stage is checked only on the first keep");
  const odd = await send("/api/dashboard/inbox", "POST", { kind: "task", title: "Odd stage" }, "dash-edit-own-003");
  assert.equal((await send(`/api/dashboard/inbox/${odd.body.id}/keep`, "POST", { stage: "done" }, "dash-edit-keep-3")).status, 400, "an item can only be kept into an open stage");

  const fuzzy = await send("/api/dashboard/inbox", "POST", { kind: "task", title: "A tracker overview I triage into" }, "dash-edit-own-002");
  const asFrag = await send(`/api/dashboard/inbox/${fuzzy.body.id}`, "PATCH", { kind: "fragment", wantsMore: true }, "dash-edit-0004");
  assert.equal(asFrag.body.kind, "fragment");
  assert.equal(asFrag.body.wantsMore, true);
  assert.deepEqual(asFrag.body.directions, []);
  assert.equal((await send(`/api/dashboard/inbox/${fuzzy.body.id}/drop`, "POST", {}, "dash-edit-drop-1")).status, 200);
});

test("a task arrives with a line of context, which becomes its notes; the answer carries no nags", async () => {
  const r = await call("dashboard_add_items", { key: "dispatch-ctx-00001", items: [
    { kind: "task", title: "Reply to Mara", context: "She asked in #beds, twice.", from: FROM },
    { kind: "task", title: "Both given", context: "Short.", body: "Longer notes.", from: FROM },
    { kind: "task", title: "Context too long", context: "x".repeat(500), from: FROM },
  ] });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^3 in the dashboard inbox: in_\w+, in_\w+, in_\w+\. The reader keeps or drops each\.$/);
  const rows = (await dash()).inbox.filter((x) => x.from?.source === FROM.source);
  assert.deepEqual(rows.map((i) => [i.context, i.body]), [["She asked in #beds, twice.", "She asked in #beds, twice."], ["Short.", "Longer notes."], ["x".repeat(400), "x".repeat(400)]]);
  assert.match((await call("dashboard_read")).text, /- in_\w+ · task · "Reply to Mara" · from Notion · 1:1 with Mara · 23 Oct\n  She asked in #beds, twice\./);
  const kept = await send(`/api/dashboard/inbox/${rows[0].id}/keep`, "POST", { stage: "todo" }, "dash-ctx-keep-001");
  const t = (await dash()).tasks.find((x) => x.id === kept.body.result);
  assert.deepEqual([t.body, t.stage], ["She asked in #beds, twice.", "todo"]);
  assert.equal((await send(`/api/dashboard/tasks/${t.id}`, "PATCH", { stage: "dropped" }, "dash-ctx-drop-001")).body.state, "dropped", "the old state column follows an ended stage");
  for (const i of rows.slice(1)) await send(`/api/dashboard/inbox/${i.id}/drop`, "POST", {}, `dash-ctx-drop-${i.id.slice(3)}`);
});

test("a pick for tomorrow morning lifts a task into to-do, ending clears it, and cleared tasks move to the archive with their sources", async () => {
  const { tasks } = await dash();
  const a = tasks.find((t) => t.title.startsWith("Spike"));
  const b = tasks.find((t) => t.title === "Write it up for Mara");
  const picked = await send(`/api/dashboard/tasks/${a.id}`, "PATCH", { pinned: true }, "dash-pin-000001");
  assert.ok(picked.body.morningAt > 0, "pinned is the older name for morning");
  assert.equal(picked.body.stage, "todo", "a backlog task picked for the morning moves to to-do");
  const read = await call("dashboard_read");
  assert.match(read.text, /^# Dashboard · .*\nWork \d+ open · Personal \d+ open\nInbox \d+ · Backlog \d+ · To-do \d+ \(1 for tomorrow morning\) · /);
  assert.match(read.text, /## To-do\n### Spike: catalogue one bed's seeds · t_\w+ · personal · tomorrow morning/);
  assert.equal((await send(`/api/dashboard/tasks/${a.id}`, "PATCH", { morning: "yes" }, "dash-pin-000002")).status, 400);

  const done = await send(`/api/dashboard/tasks/${a.id}`, "PATCH", { stage: "done" }, "dash-pin-000003");
  assert.equal(done.body.morningAt, null, "an ended task loses its pick");
  assert.equal(done.body.state, "done");
  await send(`/api/dashboard/tasks/${a.id}`, "PATCH", { cleared: true }, "dash-clear-00001");
  await send(`/api/dashboard/tasks/${b.id}`, "PATCH", { state: "dropped", cleared: true }, "dash-clear-00002");
  const board = await dash();
  assert.equal(board.tasks.some((t) => t.id === a.id || t.id === b.id), false, "cleared tasks leave the board");
  assert.equal(board.archived, 2);
  assert.doesNotMatch((await call("dashboard_read")).text, /Spike: catalogue/);
  assert.match((await call("dashboard_read", { done_since: "2020-01-01" })).text, /### Spike: catalogue one bed's seeds · t_\w+ · personal · archived/);

  const arch = await archive();
  assert.deepEqual(arch.tasks.map((t) => t.id).sort(), [a.id, b.id].sort());
  const src = arch.sources.find((s) => s.source === "Notion · Personal brain dump · 23 Oct");
  assert.deepEqual({ coverage: src.coverage, note: src.note, url: src.url, tasks: src.tasks, done: src.done, open: src.open },
    { coverage: "partial", note: "The reading list is not drafted yet.", url: "https://app.notion.com/p/abc", tasks: 3, done: 1, open: 1 });
  assert.ok(arch.sources.some((s) => s.source === "Notion · Garden committee sync · 23 Oct" && s.coverage === null), "a source no agent described still lists, coverage not stated");
  assert.equal(arch.sources.some((s) => s.source === "You"), false);
  assert.match((await call("dashboard_read")).text, /## Sources\n(- .*\n)*- Notion · Personal brain dump · 23 Oct <https:\/\/app\.notion\.com\/p\/abc> · partly read: The reading list is not drafted yet\. · 3 tasks, 1 done/);

  await call("dashboard_add_items", { key: "dispatch-src-00001", items: [{ kind: "update", task: tasks.find((t) => t.title.startsWith("List"))!.id, text: "Nothing more in the dump.", from: { source: "Notion · Personal brain dump · 23 Oct" } }],
    sources: [{ source: "Notion · Personal brain dump · 23 Oct", coverage: "full" }] });
  const after = (await archive()).sources.find((s) => s.source === "Notion · Personal brain dump · 23 Oct");
  assert.equal(after.coverage, "full");
  assert.equal(after.note, "The reading list is not drafted yet.", "a later note-less report keeps the note");
  assert.match((await call("dashboard_add_items", { key: "dispatch-src-00002", items: [{ kind: "task", title: "x", from: FROM }], sources: [{ source: "y", coverage: "most" }] })).text, /coverage is full or partial/);

  const back = await send(`/api/dashboard/tasks/${a.id}`, "PATCH", { cleared: false, state: "you" }, "dash-clear-00003");
  assert.equal(back.body.clearedAt, null);
  assert.equal(back.body.stage, "backlog", "restored with an older caller's state, it lands in the backlog");
  assert.ok((await dash()).tasks.some((t) => t.id === a.id), "a restored task is back on the board");
});

test("the scratch pad saves whole, and a save based on an older rev is refused", async () => {
  const put = (text: string, rev: number | null, k: string) => server.api("/api/dashboard/pad", { method: "PUT", body: JSON.stringify({ text }),
    headers: { "Content-Type": "application/json", "Idempotency-Key": k, ...(rev === null ? {} : { "If-Match": `"${rev}"` }) } });
  const first = await put("seed library??\nbetter watering tools", 0, "dash-pad-000001");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { text: "seed library??\nbetter watering tools", rev: 1 });
  const stale = await put("from an old tab", 0, "dash-pad-000002");
  assert.equal(stale.status, 409);
  assert.deepEqual((stale.body as any).conflict.value, { text: "seed library??\nbetter watering tools", rev: 1 });
  assert.equal((await put("next", 1, "dash-pad-000003")).body.rev, 2);
  assert.deepEqual((await dash()).pad, { text: "next", rev: 2 });
  const html = "<div><b>Dashboard</b></div><ul><li>seed library??</li><li>watering &amp; tools</li></ul><div>poke at the compost</div>";
  assert.equal((await put(html, 2, "dash-pad-000004")).status, 200);
  assert.match((await call("dashboard_read")).text, /## Scratch pad \(the reader's own notes; ideas here may become fragments\)\nDashboard\n\n- seed library\?\?\n- watering & tools\npoke at the compost/);
});

test("an agent sends notes for a task; keeping them puts them under the task's own", async () => {
  const { tasks } = await dash();
  const t = tasks.find((x) => x.title === "Compost rota");
  const body = "## Context\nFour volunteers signed up for the rota.\n\n## Done when\n- Each has a week.";
  const r = await call("dashboard_add_items", { key: "dispatch-rewrite-01", items: [{ kind: "update", task: t.id, body, from: FROM }] });
  assert.equal(r.isError, false, r.text);
  assert.match((await call("dashboard_read")).text, new RegExp(`- in_\\w+ · rewrite · new description → ${t.id} · from`));
  assert.ok(t.body.length > 0, "the task has notes of its own to keep");
  assert.match((await call("dashboard_add_items", { key: "dispatch-rewrite-02", items: [{ kind: "update", task: t.id, from: FROM }] })).text, /items\[0\]\.text is required/);
  const item = (await dash()).inbox.find((i) => i.kind === "update" && i.task === t.id);
  const kept = await send(`/api/dashboard/inbox/${item.id}/keep`, "POST", {}, "dash-rewrite-keep1");
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  const after = (await dash()).tasks.find((x) => x.id === t.id);
  assert.equal(after.body, `${t.body}\n\n${body}`, "the agent's notes go under the reader's, never over them");
  assert.equal(after.updates.length, t.updates.length, "notes alone add no dated update");
});

test("every task is work or personal: guessed from its source, set by the agent or the page, and dashboard_read filters by it", async () => {
  const r = await call("dashboard_add_items", { key: "dispatch-area-0001", items: [
    { kind: "task", title: "Area from Slack", from: { source: "Slack · #beds · 24 Oct" } },
    { kind: "task", title: "Area from a brain dump", from: { source: "Notion · Personal brain dump · 22 Oct" } },
    { kind: "task", title: "Area said outright", area: "work", from: { source: "Notion · Personal brain dump · 22 Oct" } },
  ] });
  assert.equal(r.isError, false, r.text);
  assert.match((await call("dashboard_add_items", { key: "dispatch-area-0002", items: [{ kind: "task", title: "x", area: "hobby", from: FROM }] })).text, /area is work or personal/);
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
  const mine = await send("/api/dashboard/tasks", "POST", { id: "t_areawork1", title: "Made on the work board", area: "work" }, "dash-area-make-01");
  assert.equal(mine.status, 201);
  assert.equal((await dash()).tasks.find((t) => t.id === "t_areawork1").area, "work");
  const work = (await call("dashboard_read", { area: "work" })).text;
  assert.match(work, /^# Dashboard · work · /);
  assert.match(work, /### Made on the work board · t_areawork1 · work/);
  assert.doesNotMatch(work, /Area from Slack/, "a task moved to personal leaves the work read");
});

test("an agent edits kept tasks in place, all or nothing, and a resent key replays", async () => {
  const body = "## Context\nOne sheet for every bed.\n\n## Done when\n- Every bed reaches one sheet.";
  const edits = [
    { task: "Watering log, one sheet", body, prompt: "Help me think first.", links: [{ kind: "linear", ref: "GD-838" }] },
    { task: "t_ir000001", title: "Compost rota, four volunteers", stage: "review", waitingOn: "Mara" },
  ];
  const r = await call("dashboard_edit_tasks", { key: "migrate-run-000001", edits });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Edited 2 tasks:\n1\. t_fail0001 "Watering log, one sheet": body, links, prompt\.\n2\. t_ir000001 "Compost rota, four volunteers" \(was "Compost rota"\): title, stage, waitingOn\.$/);
  assert.equal((await call("dashboard_edit_tasks", { key: "migrate-run-000001", edits })).text, r.text, "a resent key changes nothing and replays the answer");

  const { tasks } = await dash();
  const fail = tasks.find((t) => t.id === "t_fail0001"), ir = tasks.find((t) => t.id === "t_ir000001");
  assert.equal(fail.body, body);
  assert.equal(fail.prompt, "Help me think first.");
  assert.deepEqual(fail.links.map((l: { ref: string }) => l.ref), ["GD-838"], "links are replaced, not merged");
  assert.equal(fail.stage, "backlog", "a field left out stays as it was");
  assert.deepEqual([ir.title, ir.stage, ir.waitingOn], ["Compost rota, four volunteers", "review", "Mara"]);

  const bad = await call("dashboard_edit_tasks", { key: "migrate-run-000002", edits: [{ task: "t_fail0001", prompt: null }, { task: "t_ir000001", state: "someday" }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /^edits\[1\]: state is one of .* Nothing was written\.$/);
  assert.equal((await dash()).tasks.find((t) => t.id === "t_fail0001").prompt, "Help me think first.", "the good edit before a bad one rolls back");
  assert.match((await call("dashboard_edit_tasks", { key: "migrate-run-000003", edits: [{ task: "No such task", body: "x" }] })).text, /edits\[0\]\.task: no task "No such task"/);
  assert.match((await call("dashboard_edit_tasks", { key: "migrate-run-000004", edits: [{ task: "t_fail0001", pinned: true }] })).text, /pinned can't be edited here/);
});
