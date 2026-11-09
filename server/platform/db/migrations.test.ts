import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.ts";

test("dashboard bodies are put in parts once: body and quote become Context, source and links become Sources", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const add = db.prepare("INSERT INTO dashboard_tasks (id,title,body,state,links,created_from,created_at,updated_at) VALUES (?,?,?,?,?,?,0,0)");
  add.run("t_old00001", "Tomato yield", "Two crates a week.", "you",
    JSON.stringify([{ kind: "notion", ref: "Allotment brainstorm", url: "https://app.notion.com/p/1" }]),
    JSON.stringify({ source: "Notion · Allotment brainstorm · 23 Oct", url: "https://app.notion.com/p/1", quote: "the beds never catch up" }));
  add.run("t_old00002", "Mine", "", "you", "[]", JSON.stringify({ source: "You" }));
  add.run("t_new00001", "Parted", "## Context\nAlready in parts.", "you", "[]", null);
  db.prepare("INSERT INTO dashboard_inbox (id,kind,item,at) VALUES (?,?,?,0)").run("in_old0001", "task",
    JSON.stringify({ kind: "task", title: "Reply to Mara", body: "Asked in #beds.", from: { source: "Slack · #beds · 24 Oct" }, links: [] }));
  migrate(db);
  migrate(db);
  const body = (id: string) => (db.prepare("SELECT body FROM dashboard_tasks WHERE id = ?").get(id) as { body: string }).body;
  assert.equal(body("t_old00001"), "## Context\nTwo crates a week.\n\n> “the beds never catch up”\n\n## Sources\n- Notion · Allotment brainstorm · 23 Oct <https://app.notion.com/p/1>\n- notion: Allotment brainstorm");
  assert.equal(body("t_old00002"), "", "an empty task of your own stays empty");
  assert.equal(body("t_new00001"), "## Context\nAlready in parts.");
  const item = JSON.parse((db.prepare("SELECT item FROM dashboard_inbox WHERE id = 'in_old0001'").get() as { item: string }).item);
  assert.equal(item.body, "## Context\nAsked in #beds.\n\n## Sources\n- Slack · #beds · 24 Oct");
});

test("existing dashboard tasks get an area from their source once; one already set stays", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const add = db.prepare("INSERT INTO dashboard_tasks (id,title,body,state,links,created_from,created_at,updated_at,area) VALUES (?,?,?,?,?,?,0,0,?)");
  add.run("t_a1", "Gate", "", "you", "[]", JSON.stringify({ source: "Notion · Irrigation design review · 22 Oct" }), null);
  add.run("t_a2", "Flights", "", "you", "[]", JSON.stringify({ source: "Notion · Personal brain dump · 22 Oct" }), null);
  add.run("t_a3", "Frost", "", "you", "[]", JSON.stringify({ source: "Slack · #frost-watch · 24 Oct" }), null);
  add.run("t_a4", "Chosen", "", "you", "[]", JSON.stringify({ source: "Slack · #beds" }), "personal");
  migrate(db);
  const area = (id: string) => (db.prepare("SELECT area FROM dashboard_tasks WHERE id = ?").get(id) as { area: string }).area;
  assert.deepEqual(["t_a1", "t_a2", "t_a3", "t_a4"].map(area), ["work", "personal", "work", "personal"]);
});

test("existing dashboard tasks get a stage once: open ones go to the backlog, pinned ones to to-do as tomorrow morning's pick, Claude's to review", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const add = db.prepare("INSERT INTO dashboard_tasks (id,title,body,state,links,created_at,updated_at,pinned_at,stage) VALUES (?,?,?,?,'[]',0,0,?,?)");
  add.run("t_s1", "Open", "", "you", null, null);
  add.run("t_s2", "Pinned", "", "you", 5, null);
  add.run("t_s3", "With Claude", "", "claude", null, null);
  add.run("t_s4", "Parked", "", "later", null, null);
  add.run("t_s5", "Finished", "", "done", 7, null);
  add.run("t_s6", "Already staged", "", "you", null, "thinking");
  migrate(db);
  migrate(db);
  const row = (id: string) => ({ ...(db.prepare("SELECT stage, morning_at FROM dashboard_tasks WHERE id = ?").get(id) as { stage: string; morning_at: number | null }) });
  assert.deepEqual(["t_s1", "t_s2", "t_s3", "t_s4", "t_s5", "t_s6"].map(row), [
    { stage: "backlog", morning_at: null }, { stage: "todo", morning_at: 5 }, { stage: "review", morning_at: null },
    { stage: "backlog", morning_at: null }, { stage: "done", morning_at: null }, { stage: "thinking", morning_at: null },
  ]);
});
