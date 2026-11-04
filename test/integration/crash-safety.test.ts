import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { background, guardProcess } from "../../server/platform/background.ts";
import { stopServer } from "../support/stop-server.ts";
import { freePort } from "../support/free-port.ts";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("background() logs a failed job by name and lets it mark itself failed", async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args); });
  const marked: unknown[] = [];
  background("distil s-1", Promise.reject(new Error("disk I/O error")), (e) => marked.push(e));
  await settle();
  assert.equal(marked.length, 1);
  assert.match(String((marked[0] as Error).message), /disk I\/O/);
  assert.match(String(logged[0]?.[0]), /\[distil s-1\] failed in the background/);
  background("imports", Promise.reject(new Error("first")), () => { throw new Error("second"); });
  await settle();
  assert.ok(logged.some((args) => /could not be marked failed/.test(String(args[0]))));
  const before = logged.length;
  background("quiet", Promise.resolve(1), () => assert.fail("not failed"));
  await settle();
  assert.equal(logged.length, before);
});

test("guardProcess() keeps serving through a stray rejection, and exits on an uncaught exception", () => {
  const target = new EventEmitter();
  const said: unknown[][] = [];
  const exits: number[] = [];
  guardProcess(target, (...args) => said.push(args), (code) => exits.push(code));
  target.emit("unhandledRejection", new Error("a pump fell over"));
  assert.deepEqual(exits, []);
  assert.match(String(said[0]?.[0]), /still serving/);
  target.emit("uncaughtException", new Error("state unknown"));
  assert.deepEqual(exits, [1]);
  assert.match(String(said[1]?.[0]), /uncaught exception, exiting/);
});

// The preload waits for an IPC message, then rejects a promise the way a broken background job would.
const PRELOAD = `data:text/javascript,${encodeURIComponent(`
  process.on("message", (m) => {
    if (m === "reject") Promise.reject(new Error("a background job failed (test)"));
    if (m === "throw") setTimeout(() => { throw new Error("an uncaught exception (test)"); });
  });`)}`;

test("the real server survives a rejected background promise and still exits on an exception", async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const db = join(tmpdir(), `strata-crashtest-${process.pid}.db`);
  const rmDb = () => { for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true }); };
  rmDb();
  const server = spawn(process.execPath, ["--import", PRELOAD, "server/main.ts"], {
    cwd: APP_DIR,
    env: { ...process.env, STRATA_OPEN: "1", STRATA_PORT: String(port), STRATA_DB: db, GEMINI_API_KEY: "" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  server.stderr!.on("data", (d) => { stderr += String(d); });
  const healthy = async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } };
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { up = await healthy(); if (!up) await new Promise((r) => setTimeout(r, 250)); }
    assert.ok(up, `server did not start: ${stderr}`);

    server.send("reject");
    for (let i = 0; i < 40 && !/background promise failed/.test(stderr); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(stderr, /background promise failed and nothing caught it/);
    assert.match(stderr, /a background job failed \(test\)/);
    assert.equal(server.exitCode, null, "the rejection must not end the process");
    assert.ok(await healthy(), "and the room still answers");

    const exited = once(server, "exit");
    server.send("throw");
    const [code] = await exited;
    assert.equal(code, 1);
    assert.match(stderr, /uncaught exception, exiting/);
  } finally {
    await stopServer(server);
    rmDb();
  }
});
