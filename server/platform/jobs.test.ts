import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "strata-jobs-"));
process.env.STRATA_DB = join(dir, "room.db");
process.env.STRATA_COURSES = join(dir, "courses");
const { db } = await import("./db/db.ts");
const { runJob, isJobRunning, jobFailed } = await import("./jobs.ts");
const { tx } = await import("./db/tx.ts");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

const jobErrors = () => db.prepare("SELECT props FROM events WHERE event = 'job_error' ORDER BY id").all()
  .map((r) => JSON.parse(String(r.props)) as { name: string; key: string; ms: number; error: string });

test("one job in flight per (name, key): a second start joins the first", async () => {
  let runs = 0;
  let release!: () => void;
  const work = () => { runs++; return new Promise<string>((resolve) => { release = () => resolve("done"); }); };
  const first = runJob("classify", "r-1", work);
  const second = runJob("classify", "r-1", work);
  assert.equal(second, first, "the same promise");
  assert.equal(isJobRunning("classify", "r-1"), true);
  const other = runJob("classify", "r-2", async () => "other");
  assert.equal(await other, "other", "another key is another job");
  release();
  assert.equal(await first, "done");
  assert.equal(runs, 1);
  assert.equal(isJobRunning("classify", "r-1"), false, "a settled job lets go of its key");
  assert.equal(await runJob("classify", "r-1", async () => "again"), "again");
});

test("a failing job never rejects: it is logged, recorded as job_error, and marked failed in a transaction", async (t) => {
  const said: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args); });
  db.exec("CREATE TABLE IF NOT EXISTS job_marks (what TEXT)");
  let inTx = false;
  const result = await runJob("distil", "s-9", async () => { await null; throw new Error("disk I/O error"); }, {
    onFail: (e) => { inTx = db.isTransaction; db.prepare("INSERT INTO job_marks VALUES (?)").run(e.message); },
  });
  assert.equal(result, undefined);
  assert.equal(inTx, true, "onFail writes inside a tx()");
  assert.deepEqual(db.prepare("SELECT what FROM job_marks").all().map((r) => r.what), ["disk I/O error"]);
  assert.match(String(said[0]?.[0]), /^\[job distil s-9\]$/);
  assert.match(String(said[0]?.[1]), /disk I\/O error/);
  const logged = jobErrors().at(-1)!;
  assert.equal(logged.name, "distil");
  assert.equal(logged.key, "s-9");
  assert.equal(logged.error, "disk I/O error");
  assert.ok(logged.ms >= 0);
  assert.equal(isJobRunning("distil", "s-9"), false);
});

test("a job that throws before its first await, and an onFail that throws, are absorbed too", async (t) => {
  const said: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args); });
  const work = (() => { throw new Error("synchronous"); }) as () => Promise<void>;
  assert.equal(await runJob("imports", "pump", work, { onFail: () => { throw new Error("cannot mark"); } }), undefined);
  assert.ok(said.some((args) => /could not be marked failed/.test(String(args[0]))));
  assert.equal(isJobRunning("imports", "pump"), false, "the key is free again");
  assert.equal(await runJob("imports", "pump", async () => 1), 1);
});

test("a loop with its own guard (the distil pump) reports its failure as a job's", (t) => {
  const said: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { said.push(args); });
  jobFailed("distil-pump", "pump", new Error("no such table: sections"), 7);
  assert.match(String(said[0]?.[0]), /^\[job distil-pump pump\]$/);
  const logged = jobErrors().at(-1)!;
  assert.deepEqual([logged.name, logged.key, logged.error, logged.ms], ["distil-pump", "pump", "no such table: sections", 7]);
});

test("a job asked for inside a transaction starts after it: its first writes do not roll back with the asker", async () => {
  // a route's ctx.commit that starts the import pump (chooseImport, retryImport) and then fails
  db.exec("CREATE TABLE IF NOT EXISTS job_rows (what TEXT)");
  let sawTx: boolean | undefined, job: Promise<unknown> | undefined;
  assert.throws(() => tx(() => {
    db.prepare("INSERT INTO job_rows VALUES ('asker')").run();
    job = runJob("imports", "pump-in-tx", async () => {
      sawTx = db.isTransaction;
      db.prepare("INSERT INTO job_rows VALUES ('job')").run();
    });
    throw new Error("the commit fails after starting the job");
  }), /the commit fails/);
  await job;
  assert.equal(sawTx, false, "the job's first statement ran outside the asker's transaction");
  assert.deepEqual(db.prepare("SELECT what FROM job_rows").all().map((r) => r.what), ["job"],
    "the asker's row rolled back; the job's, written after, stayed");
});
