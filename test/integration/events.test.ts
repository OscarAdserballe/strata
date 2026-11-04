import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

// Each write must have a verb in events, so none can be dropped silently.
test("the writes that had no verb now have one", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "logged" }) });
  const id = made.board.id;

  await api(`/api/boards/${id}/notes`, { method: "PUT", body: JSON.stringify({ text: "the running log" }) });
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "a.md", text: "Alpha beta gamma delta." }) });
  const { body: mk } = await api(`/api/boards/${id}/marks`, { method: "POST", body: JSON.stringify({ resourceId: res.id, start: 6, end: 10, quote: "beta" }) });
  await api(`/api/boards/${id}/marks/${mk.id}?undo=1`, { method: "DELETE" });
  const { body: pair } = await api(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify({ label: "one" }) });
  await api(`/api/boards/${id}/pairs/${pair.id}`, { method: "PATCH", body: JSON.stringify({ label: "renamed" }) });
  await api(`/api/boards/${id}/pairs/${pair.id}`, { method: "DELETE" });
  await api(`/api/boards/${id}/capture`, { method: "POST", body: JSON.stringify({ url: "https://example.com/x" }) });

  // the server is still writing this file (no WAL): wait for the lock rather than race it
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  const seen = new Map((db.prepare("SELECT event, props FROM events ORDER BY id").all() as { event: string; props: string }[])
    .map((r) => [r.event, JSON.parse(r.props || "{}")]));
  db.close();

  assert.equal(seen.get("notes_write").len, 15, "the running log's growth, not its text");
  assert.equal(seen.get("mark_add").format, "text", "which format was marked — #87 shipped all of them");
  assert.equal(seen.get("mark_remove").undo, true, "⌘Z is not the same act as deciding a mark was wrong");
  assert.equal(seen.get("pair_edit").renamed, true);
  assert.ok(seen.has("pair_remove"), "boards could only ever be seen growing");
  // capture_start fires on every branch so the funnel has a denominator
  assert.equal(seen.get("capture_start").kind, "article");
  assert.ok(seen.has("capture_error"), "a capture that never landed is the interesting one");

  await api(`/api/boards/${id}`, { method: "DELETE" });
});
