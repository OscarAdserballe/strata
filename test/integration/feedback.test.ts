import { test } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("feedback: a note lands with its snapshot, lists open, resolves out", async () => {
  const made = await api("/api/feedback", { method: "POST", body: JSON.stringify({
    kind: "chat", board: "b-test", messageIdx: 3,
    context: { question: "what is the trace?", reply: "the sum of the diagonal" },
    comment: "too terse — say why it equals the eigenvalue sum",
  }) });
  assert.equal(made.status, 200);
  const id = made.body.id as string;
  assert.ok(id);

  const open = await api("/api/feedback");
  const row = open.body.feedback.find((f: { id: string }) => f.id === id);
  assert.ok(row, "the note is in the open list");
  assert.equal(row.kind, "chat");
  assert.equal(row.messageIdx, 3);
  assert.equal(row.context.question, "what is the trace?");

  const done = await api(`/api/feedback/${id}`, { method: "PATCH", body: JSON.stringify({ resolved: true }) });
  assert.equal(done.status, 200);
  const openAfter = await api("/api/feedback");
  assert.ok(!openAfter.body.feedback.some((f: { id: string }) => f.id === id), "resolved leaves the open list");
  const all = await api("/api/feedback?all=1");
  assert.ok(all.body.feedback.some((f: { id: string }) => f.id === id), "…but never the record");
});

test("feedback: a general suggestion needs no card, chat, or board", async () => {
  const made = await api("/api/feedback", { method: "POST", body: JSON.stringify({
    kind: "general", comment: "  Make the library easier to search  ",
  }) });
  assert.equal(made.status, 200);
  const open = await api("/api/feedback");
  const row = open.body.feedback.find((f: { id: string }) => f.id === made.body.id);
  assert.equal(row.kind, "general");
  assert.equal(row.comment, "Make the library easier to search");
  for (const field of ["board", "card", "deck", "messageIdx", "context"]) assert.equal(row[field], null);
});

test("feedback: an empty note and an unknown kind are refused", async () => {
  const empty = await api("/api/feedback", { method: "POST", body: JSON.stringify({ kind: "chat", comment: "   " }) });
  assert.equal(empty.status, 400);
  const kindless = await api("/api/feedback", { method: "POST", body: JSON.stringify({ kind: "vibes", comment: "hm" }) });
  assert.equal(kindless.status, 400);
});
