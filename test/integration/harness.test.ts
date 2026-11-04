// The harness must never pass the developer's GEMINI_API_KEY through: a local run would call the real model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_LOG, outputLog, startServer, type TestServer } from "../support/server.ts";

test("a test server never inherits a model key, a fetcher key, or the shell's STRATA_ settings", async () => {
  const shell = { GEMINI_API_KEY: "a-real-key-that-must-not-leak", TAVILY_API_KEY: "t", STRATA_BASE_PATH: "/elsewhere/", STRATA_FAKE_MODEL: "1" };
  const saved = Object.fromEntries(Object.keys(shell).map((k) => [k, process.env[k]]));
  Object.assign(process.env, shell);
  let server;
  try { server = await startServer(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  try {
    const { status, body } = await server.api("/api/health");
    assert.equal(status, 200, "served at the root: the shell's base path did not reach it");
    assert.equal(body.gemini, false, "no model key, whatever the shell exported");
    assert.equal(server.live, false);
    assert.doesNotMatch(server.output(), /FAKE MODEL/, "nor the shell's fake-model switch");
  } finally { await server.stop(); }
});

// The key is a dummy and the database empty, so nothing is ever sent with it.
test("a key kept in GEMINI_API_KEY_FILE reaches a live run, and only a live run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-key-"));
  const file = join(dir, "gemini.key");
  writeFileSync(file, "not-a-real-key\n");
  const shell: Record<string, string | undefined> = { GEMINI_API_KEY: undefined, GEMINI_API_KEY_FILE: file, STRATA_LIVE_TESTS: "1" };
  const saved = Object.fromEntries(Object.keys(shell).map((k) => [k, process.env[k]]));
  const put = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  let hermetic: TestServer | undefined, live: TestServer | undefined;
  try {
    put(shell);
    try { hermetic = await startServer(); live = await startServer({ live: true }); }
    finally { put(saved); }
    assert.equal(hermetic.live, false, "a hermetic server ignores the key file");
    assert.equal(live.live, true, "a live server reads it");
  } finally {
    await hermetic?.stop(); await live?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a test server's output is kept, and its database is its own and goes with it", async () => {
  const server = await startServer();
  assert.ok(server.output().includes(`listening on ${server.base}`), "the boot line is kept");
  assert.ok(server.output().includes(server.db), "…naming the throwaway database it was given");
  assert.ok(existsSync(server.db));
  await server.stop();
  assert.equal(existsSync(server.db), false, "the temp database is removed on stop");
});

// A failing test prints output(mark), so a mark must stay correct after old output is trimmed.
test("a mark taken earlier still points at the same place once the kept output has been trimmed", () => {
  const log = outputLog();
  log.keep("boot line\n");
  const early = log.written();
  log.keep("x".repeat(KEEP_LOG));
  assert.ok(!log.output().includes("boot line"), "the oldest output was let go");
  const mark = log.written();
  log.keep(Buffer.from("MARKER and what followed it\n"));
  assert.equal(log.output(mark), "MARKER and what followed it\n", "output(mark) is exactly what came after the mark");
  assert.equal(log.written(), mark + "MARKER and what followed it\n".length, "written counts every character, kept or not");
  log.keep("y".repeat(KEEP_LOG));
  assert.ok(log.output(early).length <= KEEP_LOG, "a mark older than what is kept gets all that is kept, no more");
  assert.equal(log.output(log.written()), "", "a mark taken now has nothing after it yet");
  log.keep("p".repeat(100));
  const late = log.written();
  const tail = "LATE\n" + "z".repeat(KEEP_LOG / 2 - 6);
  log.keep(tail);
  assert.equal(log.output().length, KEEP_LOG / 2, "this write went past the cap, so the log was trimmed to half");
  assert.equal(log.output(late), tail, "the mark still starts at LATE after the trim");
});
