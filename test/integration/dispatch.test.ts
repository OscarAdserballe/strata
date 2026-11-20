// Dispatch: a thread's pages kept as versions, notes on the version they were written on, and where a posted page lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const server = useServer({ env: { STRATA_ROUTINE_STUB: "1" } });
let token = "", n = 0, k = 0;

const send = (path: string, method: string, body?: unknown) => server.api(path, {
  method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json", "Idempotency-Key": `dispatch-${++k}-${Date.now()}` },
});
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return { text: res.content[0].text as string, isError: !!res.isError };
}
const open = async (id: string) => { const r = await call("dashboard_open", { id }); assert.equal(r.isError, false, r.text); return JSON.parse(r.text); };
const post = async (id: string, args: Record<string, unknown>) => call("dashboard_post", { key: `post-${++k}-${Date.now()}`, id, ...args });
const pane = async () => (await server.api("/api/dashboard/dispatch")).body as { board: string | null; inbox: number; threads: any[] };
const thread = async (id: string) => (await pane()).threads.find((t) => t.id === id);
const page = (h: string, words: string) => `<!doctype html><html><body><h1>${h}</h1><p>${words}</p></body></html>`;
async function newThread(title: string, links: unknown[] = []): Promise<string> {
  const id = `t_${Math.random().toString(36).slice(2, 12)}`;
  const r = await send("/api/dashboard/tasks", "POST", { id, title, body: `Prompt for ${title}.`, links });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return id;
}
async function note(board: string, resourceId: string, quote: string, text: string): Promise<string> {
  const r = await send(`/api/boards/${board}/marks`, "POST", { resourceId, quote, start: 0, end: quote.length, note: text });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
}

test("sending a thread hands it to Claude: Implementing, a press stored, the routine woken (stubbed) once a minute", async () => {
  token = ((await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "dispatch", write: true }) })).body as { token: string }).token;
  const a = await newThread("Some process steps lack screenshots", [{ kind: "linear", ref: "TRY-1287" }]);
  const b = await newThread("Process overview is unintuitive");
  const sent = await send(`/api/dashboard/tasks/${a}/send`, "POST", {});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual([sent.body.press.kind, sent.body.press.stage], ["send", "todo"]);
  assert.match(sent.body.press.session_url, /^https:\/\/example\.invalid\/stub-session\/\d+$/, "the stub makes up a session and logs the call");
  const again = await send(`/api/dashboard/tasks/${b}/send`, "POST", {});
  assert.equal(again.body.press.session_url, sent.body.press.session_url, "within the cooldown the running session is the one linked");

  const t = await thread(a);
  assert.deepEqual([t.stage, t.lands, t.versions.length, t.press.sessionUrl], ["implementing", "decide", 0, sent.body.press.session_url]);
  assert.equal((await send(`/api/dashboard/tasks/${a}/send`, "POST", {})).status, 400, "only a to-do or thinking thread is sent");
  assert.equal((await send(`/api/dashboard/tasks/${a}`, "PATCH", { stage: "decide" })).status, 400, "Decide is reached through Dispatch, not by hand");
  const focus = (await server.api("/api/dashboard")).body.tasks.find((x: any) => x.id === a);
  assert.equal(focus.dispatched, true, "Focus can tell a Dispatch thread from its own");
});

test("the three tools: board lists implementing first; open gives no page yet; post with a page lands in Decide as v1", async () => {
  const board = JSON.parse((await call("dashboard_board")).text) as { id: string; title: string; stage: string }[];
  assert.deepEqual(Object.keys(board[0]).sort(), ["id", "stage", "title"]);
  assert.equal(board[0].stage, "implementing");
  const a = board.find((t) => t.title.startsWith("Some process"))!.id;
  const first = await open(a);
  assert.deepEqual(Object.keys(first).sort(), ["id", "notes", "page", "stage", "text", "title"]);
  assert.deepEqual([first.stage, first.page, first.notes, first.text], ["implementing", null, [], "Prompt for Some process steps lack screenshots."]);

  const r = await post(a, { page: page("Steps never get a screenshot", "I would make the agent name a recording frame for every step.") });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /v1 posted; the thread is in Decide\./);
  const t = await thread(a);
  assert.deepEqual([t.stage, t.versions.map((v: any) => [v.n, v.landed, v.notes])], ["decide", [[1, "decide", 0]]]);
  const opened = await open(a);
  assert.match(opened.page, /recording frame/);
  assert.equal(opened.stage, "decide");
  const p = await pane();
  const res = (await server.api(`/api/boards/${p.board}`)).body.resources.find((x: any) => x.id === t.versions[0].resourceId);
  assert.deepEqual([res.filename, res.kind], ["try-1287.html", "html"], "the page is an HTML source on the dispatch board, named for the thread");
  assert.match((await post(a, { page: page("x", "y") })).text, /in decide, with the reader/, "no page while the thread is with the reader");
});

test("Send back keeps v1 with its notes, and the next page is v2 in Decide; replies go under the reader's note", async () => {
  const p = await pane();
  const t = p.threads.find((x) => x.title.startsWith("Some process"));
  const v1 = t.versions[0].resourceId;
  const mid = await note(p.board!, v1, "recording frame", "Which frame does it pick?");
  assert.equal((await thread(t.id)).versions[0].notes, 1);
  const pressed = await send(`/api/dashboard/tasks/${t.id}/press`, "POST", { kind: "back" });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  const told = await open(t.id);
  assert.equal(told.stage, "implementing");
  assert.deepEqual(told.notes, [{ id: `hl_${mid}`, on: "recording frame", text: "Which frame does it pick?" }, { id: pressed.body.press.id, on: null, text: "Send back" }],
    "the press is the newest note, on nothing");
  assert.equal((await thread(t.id)).lands, "decide");

  const r = await post(t.id, { page: page("v2: the frame the agent picked", "It picks the frame that shows the step."), replies: { [`hl_${mid}`]: "The one nearest the step's timestamp." } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /1 reply under the reader's notes; v2 posted; the thread is in Decide\./);
  const after = await thread(t.id);
  assert.deepEqual(after.versions.map((v: any) => [v.n, v.landed, v.notes]), [[1, "decide", 1], [2, "decide", 0]], "every version is kept, each with its own notes");
  assert.notEqual(after.versions[0].resourceId, after.versions[1].resourceId);
  const list = (await server.api(`/api/boards/${p.board}`)).body.marks as any[];
  const v1note = list.find((m: any) => m.id === mid);
  assert.equal(v1note.resourceId, v1, "the note stays on the version it was written on");
  assert.deepEqual(v1note.replies.map((x: any) => [x.author, x.text]), [["agent", "The one nearest the step's timestamp."]]);
  assert.match(await (await server.fetch(`/api/boards/${p.board}/resources/${v1}/raw`)).text(), /recording frame/, "v1's page is still there");
  const fresh = await open(t.id);
  assert.deepEqual([fresh.notes, /picks the frame/.test(fresh.page)], [[], true], "open gives the newest version and only its notes");
  assert.match((await post(t.id, { replies: { hl_mk_nope: "x" } })).text, /not one of the reader's notes on this thread/);
});

test("an older client's Go still lands as before, with Done now Finish", async () => {
  const t = (await pane()).threads.find((x) => x.title.startsWith("Some process"));
  assert.equal((await send(`/api/dashboard/tasks/${t.id}/press`, "POST", { kind: "maybe" })).status, 400);
  assert.equal((await send(`/api/dashboard/tasks/${t.id}/press`, "POST", { kind: "go" })).status, 200);
  assert.equal((await thread(t.id)).lands, "review");
  assert.match((await post(t.id, { page: page("Built as you picked in v2", "Red on main, green on the PR.") })).text, /v3 posted; the thread is in Review\./);
  assert.equal((await send(`/api/dashboard/tasks/${t.id}/press`, "POST", { kind: "go" })).status, 200);
  assert.equal((await thread(t.id)).lands, "finish");
  assert.match((await post(t.id, { page: page("Merged", "PR merged.") })).text, /v4 posted; the thread is in Finish\./);
});

test("Send leaves where it lands to Claude: the post's lands puts it in Decide, Review or Finish, and Archive clears it", async () => {
  const id = await newThread("Fewer buttons in flow");
  await send(`/api/dashboard/tasks/${id}/send`, "POST", {});
  assert.match((await post(id, { page: page("v1", "Two buttons."), lands: "nowhere" })).text, /lands is one of decide, review, finish/);
  assert.match((await post(id, { replies: {}, lands: "review" })).text, /lands goes with a page/);
  assert.match((await post(id, { page: page("v1", "Two buttons.") })).text, /v1 posted; the thread is in Decide\./, "no lands: a new thread's first page is a proposal");

  const sent = await send(`/api/dashboard/tasks/${id}/press`, "POST", { kind: "send" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual((await open(id)).notes.at(-1), { id: sent.body.press.id, on: null, text: "Send" }, "the press is a note on nothing");
  assert.match((await post(id, { page: page("Built", "Whole stack."), lands: "review" })).text, /v2 posted; the thread is in Review\./);

  await send(`/api/dashboard/tasks/${id}/press`, "POST", { kind: "send" });
  assert.equal((await thread(id)).lands, "review", "without lands it goes back where it was pressed");
  assert.match((await post(id, { page: page("Merged", "Open a board: Finish lists it."), lands: "finish" })).text, /v3 posted; the thread is in Finish\./);
  const t = await thread(id);
  assert.deepEqual([t.stage, t.versions.map((v: any) => v.landed)], ["finish", ["decide", "review", "finish"]]);
  assert.equal((await send(`/api/dashboard/tasks/${id}/press`, "POST", { kind: "go" })).status, 400, "Finish has no Go");

  const reopened = await send(`/api/dashboard/tasks/${id}/press`, "POST", { kind: "send" });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal((await open(id)).notes.at(-1).text, "Reopen");
  assert.equal((await thread(id)).lands, "decide", "a reopened thread comes back as a proposal unless Claude says otherwise");
  await post(id, { page: page("Not doing it", "Filed as TRY-1."), lands: "finish" });

  assert.equal((await send(`/api/dashboard/tasks/${id}`, "PATCH", { stage: "finish" })).status, 200, "staying in Finish is not a move");
  const other = await newThread("Not in Finish yet");
  assert.equal((await send(`/api/dashboard/tasks/${other}`, "PATCH", { stage: "finish" })).status, 400, "Finish is reached through a post, not by hand");
  const archived = await send(`/api/dashboard/tasks/${id}`, "PATCH", { stage: "done", cleared: true });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(await thread(id), undefined, "an archived thread leaves the pane");
  const fold = (await server.api("/api/dashboard/archive")).body.tasks.find((x: any) => x.id === id);
  assert.deepEqual([fold.stage, fold.dispatched], ["done", true], "and is listed under Archived");
});

test("a press needs a page on you, and a resent post writes one version", async () => {
  const id = await newThread("Get rid of per-step configurable timeouts");
  assert.equal((await send(`/api/dashboard/tasks/${id}/press`, "POST", { kind: "go" })).status, 400, "nothing to press on in to-do");
  await send(`/api/dashboard/tasks/${id}/send`, "POST", {});
  const args = { key: "post-resent-000001", id, page: page("Timeouts", "One timeout for the run.") };
  const once = await call("dashboard_post", args);
  assert.equal((await call("dashboard_post", args)).text, once.text, "the same key replays the first answer");
  assert.equal((await thread(id)).versions.length, 1);
  assert.match((await call("dashboard_open", { id: "t_nothere" })).text, /No thread t_nothere/);
});

test("a page carries the ask and how Claude read it, kept per version; both or neither, and only with a page", async () => {
  const id = await newThread("See the prompt behind a thread");
  await send(`/api/dashboard/tasks/${id}/send`, "POST", {});
  assert.match((await post(id, { page: page("v1", "Two fields."), ask: "Show what I sent." })).text, /ask and heard go together/);
  assert.match((await post(id, { replies: {}, ask: "a", heard: "b" })).text, /ask and heard go with a page/);
  assert.match((await post(id, { page: page("v1", "Two fields."), ask: " ", heard: "b" })).text, /ask is empty/);
  assert.match((await post(id, { page: page("v1", "Two fields."), ask: "x".repeat(601), heard: "b" })).text, /at most 600/);
  await post(id, { page: page("v1", "Two fields."), ask: "Let me see\n what I  sent.", heard: "Two fields above each page." });
  await send(`/api/dashboard/tasks/${id}/press`, "POST", { kind: "send" });
  await post(id, { page: page("v2", "No ask.") });
  assert.deepEqual((await thread(id)).versions.map((v: any) => [v.n, v.ask, v.heard]),
    [[1, "Let me see what I sent.", "Two fields above each page."], [2, null, null]], "each version keeps its own; a page without them shows the page alone");
});

test("Later and To thinking take a thread out of Dispatch with its pages, and Send brings it back to carry on", async () => {
  const id = await newThread("A Later button on Dispatch");
  await send(`/api/dashboard/tasks/${id}/send`, "POST", {});
  await post(id, { page: page("v1", "Three options."), ask: "Later on cards.", heard: "Three options." });
  const later = await send(`/api/dashboard/tasks/${id}`, "PATCH", { stage: "todo" });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(await thread(id), undefined, "Later takes it out of Dispatch");
  assert.equal((await server.api("/api/dashboard")).body.tasks.find((x: any) => x.id === id).stage, "todo");
  assert.equal((await send(`/api/dashboard/tasks/${id}`, "PATCH", { stage: "thinking" })).status, 200);
  const back = await send(`/api/dashboard/tasks/${id}/send`, "POST", {});
  assert.equal(back.status, 200, "Send to Dispatch works from Thinking");
  assert.deepEqual([back.body.press.stage, back.body.press.version], ["thinking", null]);
  assert.match((await open(id)).page, /Three options/, "its pages were kept: Claude opens the last one and carries on");
  await post(id, { page: page("v2", "Built."), ask: "Later on cards.", heard: "Built." });
  assert.deepEqual([(await thread(id)).stage, (await thread(id)).versions.length], ["decide", 2]);
  await send(`/api/dashboard/tasks/${id}`, "PATCH", { stage: "thinking" });
  assert.equal((await send(`/api/dashboard/tasks/${id}`, "PATCH", { stage: "implementing" })).status, 400, "Implementing is still only reached by a press");
});
