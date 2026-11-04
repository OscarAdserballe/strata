import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureEventsTable, ensureRequestLog, logRequest, pruneRequestLog } from "./events.ts";

function room() {
  const db = new DatabaseSync(":memory:");
  ensureEventsTable(db); ensureRequestLog(db);
  return db;
}
function hit(db: DatabaseSync, method: string, url: string, status = 200) {
  const req = { method, url, headers: { "x-session": "tab-1" } } as unknown as IncomingMessage;
  const res = Object.assign(new EventEmitter(), { statusCode: status }) as unknown as ServerResponse;
  logRequest(db, req, res);
  res.emit("finish");
  res.emit("close");      // both fire in real life; the row is written once
}
const logged = (db: DatabaseSync) => db.prepare("SELECT method, path, status, session FROM request_log ORDER BY rowid").all()
  .map((r) => ({ ...r }));

test("a request is timed into request_log, once, and never becomes an event", () => {
  const db = room();
  hit(db, "GET", "/u/ada/api/boards/b-1?x=1");
  hit(db, "POST", "/u/ada/api/boards/b-1/marks", 201);
  assert.deepEqual(logged(db), [
    { method: "GET", path: "/u/ada/api/boards/b-1", status: 200, session: "tab-1" },
    { method: "POST", path: "/u/ada/api/boards/b-1/marks", status: 201, session: "tab-1" },
  ]);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n, 0);
});

test("probes, polls and assets are not logged, behind a base path too", () => {
  const db = room();
  for (const url of ["/api/health", "/u/ada/api/health", "/u/ada/api/imports", "/api/boards/b-1/status", "/dist/main.js"])
    hit(db, "GET", url);
  assert.deepEqual(logged(db), []);
  hit(db, "POST", "/u/ada/api/imports");   // starting an import is something someone did
  assert.equal(logged(db).length, 1);
});

test("the log keeps a month", () => {
  const db = room();
  const put = db.prepare("INSERT INTO request_log (ts, method, path) VALUES (?, 'GET', '/')");
  put.run(Date.now() - 40 * 864e5); put.run(Date.now() - 2 * 864e5);
  pruneRequestLog(db);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM request_log").get() as { n: number }).n, 1);
});
