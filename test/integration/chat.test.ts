import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";
import { MD, newBoard, addMarkdown } from "./seed.ts";

let boardId = "";

const server = useServer({ seed: async (s) => {
  boardId = await newBoard(s, { question: "How does duration hedging actually fail?" });
  await addMarkdown(s, boardId, "tuckman-ch4.md", MD);
} });
const api = (path: string, init?: RequestInit) => server.api(path, init);

// The turns share the seeded board's thread, so each counts from what the thread held when it began.
const threadLength = async () => (await api(`/api/boards/${boardId}`)).body.messages.length as number;

test("chat (blocking): a turn persists user + assistant messages, no graph fields", async () => {
  const before = await threadLength();
  const { status, body } = await api(`/api/boards/${boardId}/chat`, { method: "POST", body: JSON.stringify({ message: "What is the failure mode of a DV01-neutral hedge?" }) });
  assert.equal(status, 200);
  const msgs = body.state.messages;
  assert.equal(msgs.length, before + 2);
  assert.equal(msgs[before].role, "user");
  assert.equal(msgs[before + 1].role, "assistant");
  assert.ok(msgs[before + 1].text.length > 0);
  assert.equal(body.state.defs, undefined);
  assert.equal(body.state.nodes, undefined);
});

test("chat (SSE): streams delta frames then a done frame with the state", async () => {
  const before = await threadLength();
  const r = await fetch(`${server.base}/api/boards/${boardId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ message: "And why does convexity matter for it?" }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
  const raw = await r.text();
  assert.match(raw, /event: start/);
  assert.match(raw, /event: delta/);
  assert.match(raw, /event: done/);
  const doneData = raw.split("event: done")[1];
  const state = JSON.parse(doneData.slice(doneData.indexOf("data:") + 5, doneData.indexOf("\n\n"))).state;
  assert.equal(state.messages.length, before + 2);
  assert.equal(state.messages[before].role, "user");
  assert.equal(state.messages[before + 1].role, "assistant");
});

test("empty message is rejected", async () => {
  const { status } = await api(`/api/boards/${boardId}/chat`, { method: "POST", body: JSON.stringify({ message: "  " }) });
  assert.equal(status, 400);
});

test("the thread can be cleared, and only the thread goes", async () => {
  const before = await api(`/api/boards/${boardId}`);
  assert.ok(before.body.messages.length > 0);
  const { status, body } = await api(`/api/boards/${boardId}/messages`, { method: "DELETE" });
  assert.equal(status, 200);
  assert.deepEqual(body.state.messages, []);
  assert.equal(body.state.board.title, before.body.board.title);
  assert.equal(body.state.resources.length, before.body.resources.length);
  // the server writes events on its own connection, so wait out its locks
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 2000 });
  const rows = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE board_id = ? AND archived = 1").get(boardId) as { n: number };
  const liveRows = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE board_id = ? AND archived = 0").get(boardId) as { n: number };
  db.close();
  assert.equal(rows.n, before.body.messages.length);
  assert.equal(liveRows.n, 0);
  const after = await api(`/api/boards/${boardId}/chat`, { method: "POST", body: JSON.stringify({ message: "start again" }) });
  assert.equal(after.status, 200);
  assert.equal(after.body.state.messages.length, 2);
});

test("clearing an unknown board is a 404, not a silent ok", async () => {
  const { status } = await api("/api/boards/b-nope/messages", { method: "DELETE" });
  assert.equal(status, 404);
});

test("chat context follows the open page, not the whole course", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "focus" }) });
  const id = made.board.id;
  const mk = async (name: string, text: string) =>
    (await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: name, base64: Buffer.from(text, "utf-8").toString("base64") }) })).body.id;
  const a = await mk("lecture1.md", "ALPHA lecture one");
  await mk("lecture2.md", "BETA lecture two");
  const { status } = await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: "what is this?", focus: a }) });
  assert.equal(status, 200);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

// The chapters differ in size, so the chat_turn event's srcChars says which one rode the turn.
test("the turn carries ONE SECTION of a divided source, not the whole thing", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "sections" }) });
  const id = made.board.id;
  const small = "ALPHA. ".repeat(20);
  const big = "BETA. ".repeat(2000);
  const { body: res } = await api(`/api/boards/${id}/resources`, {
    method: "POST",
    body: JSON.stringify({
      filename: "book.pdf", kind: "pdf", text: small + small + big + big,
      sections: [
        { label: "Chapter One", firstPage: 1, lastPage: 2 },
        { label: "Chapter Two", firstPage: 3, lastPage: 4 },
      ],
      pageText: [small, small, big, big],
    }),
  });
  assert.equal(res.sections, 2, "the source divided");
  const { body: state } = await api(`/api/boards/${id}`);
  const secs = state.sections.filter((s: { resourceId: string }) => s.resourceId === res.id).sort((a: { ord: number }, b: { ord: number }) => a.ord - b.ord);
  assert.equal(secs.length, 2);

  const ask = async (sectionId: string | null, page?: number) => {
    const r = await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: "what is this?", here: { sectionId, page } }) });
    assert.equal(r.status, 200);
  };
  await ask(secs[0].id, 1);
  await ask(secs[1].id, 3);
  await ask(null);

  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  const turns = (db.prepare("SELECT props FROM events WHERE event = 'chat_turn' ORDER BY id DESC LIMIT 3").all() as { props: string }[])
    .map((r) => JSON.parse(r.props || "{}")).reverse();
  db.close();
  const [one, two, home] = turns;

  assert.ok(one.srcChars < 1000, `chapter one is two small pages, got ${one.srcChars}`);
  assert.ok(two.srcChars > 20000, `chapter two is two big pages, got ${two.srcChars}`);
  assert.ok(two.srcChars > one.srcChars * 10, "the cut is real, not a truncation of the same thing");
  assert.ok(one.srcChars + two.srcChars > Math.max(one.srcChars, two.srcChars), "sanity");
  assert.equal(one.grounded, true, "a section open means the model is told where it is");
  assert.equal(home.grounded, false, "home has no page to be grounded in");
  assert.equal(home.srcChars, 0, "and nothing to read");

  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("an UNDIVIDED source still rides whole, as a file — nothing regresses (C4)", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "one section" }) });
  const id = made.board.id;
  const body = "GAMMA slide deck. ".repeat(400);
  const { body: res } = await api(`/api/boards/${id}/resources`, {
    method: "POST", body: JSON.stringify({ filename: "slides.md", text: body }),
  });
  const { body: state } = await api(`/api/boards/${id}`);
  const sec = state.sections.find((s: { resourceId: string }) => s.resourceId === res.id);
  assert.ok(sec, "even an undivided source has one section spanning it");

  const { status } = await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: "what is this?", here: { sectionId: sec.id } }) });
  assert.equal(status, 200);

  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  const last = JSON.parse((db.prepare("SELECT props FROM events WHERE event = 'chat_turn' ORDER BY id DESC LIMIT 1").get() as { props: string }).props);
  db.close();
  assert.ok(last.srcChars >= body.length, "the whole source rode, uncut");

  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("the whole conversation rides the turn, and the state says where the window starts", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "memory" }) });
  const id = made.board.id;
  for (let i = 0; i < 14; i++) {
    await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: `turn ${i}` }) });
  }
  const { body: state } = await api(`/api/boards/${id}`);
  // 1 welcome + 14 exchanges
  assert.equal(state.messages.length, 29);
  assert.equal(state.windowFrom[""] ?? 0, 0, "nothing has been forgotten");

  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  const last = JSON.parse((db.prepare("SELECT props FROM events WHERE event = 'chat_turn' ORDER BY id DESC LIMIT 1").get() as { props: string }).props);
  db.close();
  // the 14th turn is fed all 27 prior messages
  assert.equal(last.turns, 27, "the thread is no longer truncated at 24");

  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("chat threads are the source's — scoped rides, scoped clears", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "threads" }) });
  const id = made.board.id;
  const mk = async (name: string, text: string) =>
    (await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: name, base64: Buffer.from(text, "utf-8").toString("base64") }) })).body.id;
  const a = await mk("alpha.md", "ALPHA lecture");
  const b = await mk("beta.md", "BETA lecture");
  await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: "about alpha 1", focus: a }) });
  await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: "about alpha 2", focus: a }) });
  await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: "about beta", focus: b }) });

  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  const last = JSON.parse((db.prepare("SELECT props FROM events WHERE event = 'chat_turn' ORDER BY id DESC LIMIT 1").get() as { props: string }).props);
  db.close();
  assert.equal(last.turns, 0, "a fresh source starts a fresh conversation");

  const { body: state } = await api(`/api/boards/${id}`);
  assert.deepEqual(
    state.messages.map((m: { resourceId: string | null }) => m.resourceId),
    [null],
    "the default payload contains only the board conversation");
  const alpha = (await api(`/api/boards/${id}/messages?resource=${a}`)).body;
  const beta = (await api(`/api/boards/${id}/messages?resource=${b}`)).body;
  assert.deepEqual(alpha.messages.map((m: {resourceId:string}) => m.resourceId), [a,a,a,a]);
  assert.deepEqual(beta.messages.map((m: {resourceId:string}) => m.resourceId), [b,b]);
  assert.equal(state.windowFrom[a] ?? 0, 0);

  const { body: cleared } = await api(`/api/boards/${id}/messages?resource=${a}`, { method: "DELETE" });
  assert.deepEqual(
    cleared.state.messages.map((m: { resourceId: string | null }) => m.resourceId),
    [],
    "the cleared conversation is empty");
  assert.equal((await api(`/api/boards/${id}/messages?resource=${b}`)).body.messages.length,2,"beta survives alpha's clear");
  assert.equal((await api(`/api/boards/${id}`)).body.messages.length,1,"the board welcome survives");
  assert.ok(cleared.floor >= Math.max(...alpha.messages.map((m: { idx: number }) => m.idx)), "the floor covers the cleared turns");

  // the asker names the thread: inferred, the turn fell to the board's thread and left the screen
  await api(`/api/boards/${id}/chat`, { method: "POST", body: JSON.stringify({ message: "asked over beta", here: { thread: b } }) });
  const named = (await api(`/api/boards/${id}/messages?resource=${b}`)).body.messages;
  assert.deepEqual(named.slice(-2).map((m: { role: string; text: string }) => m.role === "user" ? m.text : m.role), ["asked over beta", "assistant"]);
  assert.equal((await api(`/api/boards/${id}`)).body.messages.length, 1, "the board's own thread did not take it");

  await api(`/api/boards/${id}`, { method: "DELETE" });
});
