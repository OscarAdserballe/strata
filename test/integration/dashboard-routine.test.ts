// Run now: the room wakes a fake research routine, once per press, and never hands its token back.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";

const fired: { path?: string; auth?: string; beta?: string; text: string }[] = [];
let answer = 200;
const routine = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    fired.push({ path: req.url, auth: req.headers.authorization, beta: String(req.headers["anthropic-beta"]), text: JSON.parse(raw).text });
    res.writeHead(answer, { "Content-Type": "application/json" })
      .end(JSON.stringify({ type: "routine_fire", claude_code_session_id: "session_01FAKE", claude_code_session_url: "https://claude.ai/code/session_01FAKE" }));
  });
});
await new Promise<void>((resolve) => routine.listen(0, "127.0.0.1", resolve));
after(() => { routine.close(); });
const BASE = `http://127.0.0.1:${(routine.address() as AddressInfo).port}/v1/claude_code/routines/`;
const FIRE = `${BASE}trig_01ABCDEFGHJK/fire`;

const server = useServer({ env: { STRATA_ROUTINE_BASE: BASE } });
const send = (path: string, method: string, body: unknown, key: string) => server.api(path, {
  method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", "Idempotency-Key": key },
});
// The minute between runs passes here instead of in the test.
const age = () => { const db = new DatabaseSync(server.db, { timeout: 5000 }); try { db.prepare("UPDATE dashboard_routine SET ran_at = ran_at - 61000").run(); } finally { db.close(); } };

test("Run now asks for a routine first; a wrong Fire URL or empty token is refused, and the token never comes back", async () => {
  assert.deepEqual((await server.api("/api/dashboard/routine")).body, { connected: false, url: null, ranAt: null, sessionUrl: null, error: null });
  const none = await send("/api/dashboard/routine/run", "POST", {}, "routine-run-0000");
  assert.equal(none.status, 400);
  assert.match(none.body.error, /Connect the research routine/);
  assert.equal((await send("/api/dashboard/routine", "PUT", { url: "https://example.com/fire", token: "sk-ant-oat01-x" }, "routine-put-0001")).status, 400);
  assert.equal((await send("/api/dashboard/routine", "PUT", { url: FIRE, token: " " }, "routine-put-0002")).status, 400);
  const ok = await send("/api/dashboard/routine", "PUT", { url: FIRE, token: "sk-ant-oat01-secret" }, "routine-put-0003");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { connected: true, url: FIRE, ranAt: null, sessionUrl: null, error: null });
  assert.doesNotMatch(JSON.stringify((await server.api("/api/dashboard/routine")).body), /secret/);
  assert.equal(fired.length, 0);
});

test("a press fires the routine once, a resent press replays it, and another inside the minute is refused", async () => {
  const run = await send("/api/dashboard/routine/run", "POST", {}, "routine-run-0001");
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0], { path: "/v1/claude_code/routines/trig_01ABCDEFGHJK/fire", auth: "Bearer sk-ant-oat01-secret", beta: "experimental-cc-routine-2026-04-01", text: "Run now, from the dashboard." });
  assert.equal(run.body.sessionUrl, "https://claude.ai/code/session_01FAKE");
  assert.equal(run.body.error, null);
  assert.ok(run.body.ranAt);

  const again = await send("/api/dashboard/routine/run", "POST", {}, "routine-run-0001");
  assert.deepEqual(again.body, run.body, "a lost answer resent under its key replays");
  const soon = await send("/api/dashboard/routine/run", "POST", {}, "routine-run-0002");
  assert.equal(soon.status, 409);
  assert.match(soon.body.error, /under a minute ago/);
  assert.equal(fired.length, 1, "nothing more reached the routine");
});

test("a refused fire shows why on the page, and disconnecting forgets the token", async () => {
  age();
  answer = 401;
  const bad = await send("/api/dashboard/routine/run", "POST", {}, "routine-run-0003");
  assert.equal(bad.status, 200);
  assert.equal(fired.length, 2);
  assert.match(bad.body.error, /401: the token is wrong/);
  assert.equal(bad.body.sessionUrl, null);
  answer = 200;

  const off = await send("/api/dashboard/routine", "PUT", { url: null }, "routine-put-0004");
  assert.deepEqual(off.body, { connected: false, url: null, ranAt: null, sessionUrl: null, error: null });
  assert.equal((await send("/api/dashboard/routine/run", "POST", {}, "routine-run-0004")).status, 400);
});

test("a task added on the board goes straight to the backlog", async () => {
  const made = await send("/api/dashboard/tasks", "POST", { id: "t_boardadd1", title: "Why does the pump go quiet?", area: "work" }, "board-add-0001");
  assert.equal(made.status, 201);
  const { tasks, inbox } = (await server.api("/api/dashboard")).body;
  assert.deepEqual(inbox, []);
  const t = tasks.find((x: { id: string }) => x.id === "t_boardadd1");
  assert.deepEqual([t.stage, t.area, t.createdFrom.source], ["backlog", "work", "You"]);
});
