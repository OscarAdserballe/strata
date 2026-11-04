import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "strata-queue-"));
process.env.STRATA_DB = join(dir, "room.db");
process.env.STRATA_COURSES = join(dir, "courses");
process.env.GEMINI_API_KEY = "test-key-never-sent";
const { db } = await import("../../platform/db/db.ts");
const { q } = await import("../repo.ts");
const { deps } = await import("../../platform/config.ts");
const { enqueueDistil, distilSection, isDistilRunning } = await import("./queue.ts");
const { distilRoutes } = await import("./routes.ts");
const { tx } = await import("../../platform/db/tx.ts");
const realModel = deps.callGeminiJson;
after(() => { deps.callGeminiJson = realModel; db.close(); rmSync(dir, { recursive: true, force: true }); });

q.insBoard.run("board", "Queue", "blank", 1, 1);
function source(name: string): { rid: string; sid: string } {
  const rid = `res-${name}`, sid = `${name}-s0`;
  db.prepare("INSERT INTO resources (id,board_id,filename,mime,text,tokens,included,created_at,kind) VALUES (?,'board',?,'text/plain',?,10,1,1,'text')")
    .run(rid, `${name}.md`, `# Claim\n${name} practice matters for recall.`);
  q.insSection.run(sid, rid, "board", 0, name, 1, 0, 1, 10);
  q.insPair.run(`${name}-p0`, "board", name, rid, null, 0, sid);
  q.upsertTree.run(sid, rid, "board", name, "", null, null, "queued", null, 0, 1);
  return { rid, sid };
}

const calls: string[] = [];
let held = "", failing = "", release = () => {};
deps.callGeminiJson = (async (opts: { user: string }) => {
  calls.push(opts.user);
  if (held && opts.user.includes(held)) await new Promise<void>((resolve) => { release = () => { held = ""; resolve(); }; });
  if (failing && opts.user.includes(failing)) throw new Error("Gemini 429: RESOURCE_EXHAUSTED");
  return {
    title: "Practice", question: "Why practice?",
    nodes: [{ kind: "synthesis", label: "Practice improves recall", anchor: "#claim", questions: ["Why practice?"], children: [] }],
    cards: [{ type: "flashcard", front: "Why practice?", back: "To improve recall.", node: "1", quote: "practice matters for recall" }],
  };
}) as typeof deps.callGeminiJson;

const until = async (what: string, done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(done(), `timed out waiting for ${what}`);
};
const doneEvents = () => Number((db.prepare("SELECT count(*) AS n FROM events WHERE event = 'distil_done'").get() as { n: number }).n);
const callsAbout = (name: string) => calls.filter((c) => c.includes(`${name} practice`)).length;

async function askFor(rid: string, sid: string): Promise<number> {
  let status = 0;
  const res = { writeHead: (code: number) => { status = code; }, end: () => {} };
  const commit = (fn: () => { status: number }) => { const out = tx(fn); status = out.status; return out; };
  await distilRoutes[0].handler({ res, params: ["board", rid], url: new URL(`http://test/distil?section=${sid}`), ssn: null, commit } as never);
  return status;
}

test("a section asked for while it waits in the queue is built once, not once per request", async () => {
  const busy = source("Xylophone"), wanted = source("Saxophone");
  held = "Xylophone practice";
  assert.equal(enqueueDistil("board", busy.sid, null, "arrival"), true);
  assert.equal(enqueueDistil("board", wanted.sid, null, "arrival"), true);
  await until("the pump to be busy", () => isDistilRunning(busy.sid));
  assert.equal(q.tree.get(wanted.sid)?.status, "queued");
  assert.equal(await askFor(wanted.rid, wanted.sid), 202);
  assert.equal(await askFor(wanted.rid, wanted.sid), 202);
  assert.equal(isDistilRunning(wanted.sid), false, "nothing ran it out of turn");
  assert.equal(callsAbout("Saxophone"), 0);
  release();
  await until("both sections to land", () => q.tree.get(busy.sid)?.status === "ready" && q.tree.get(wanted.sid)?.status === "ready" && !isDistilRunning(wanted.sid));
  assert.equal(callsAbout("Saxophone"), 2, "one run: the tree and the cards, once");
  assert.equal(doneEvents(), 2, "one distil_done per section");
  assert.equal(q.tree.get(wanted.sid)?.cards, 1);

  await distilSection("board", wanted.sid, null);
  assert.equal(callsAbout("Saxophone"), 2);
  assert.equal(doneEvents(), 2);
  assert.equal(q.tree.get(wanted.sid)?.status, "ready");
});

test("a distil that fails outside its own bookkeeping marks the section error and logs job_error", async (t) => {
  t.mock.method(console, "error", () => {});
  const { sid } = source("Oboe");
  db.exec(`CREATE TEMP TRIGGER oboe_claim_fails BEFORE UPDATE OF status ON trees
           WHEN NEW.section_id = '${sid}' AND NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`);
  try {
    assert.equal(enqueueDistil("board", sid, null, "arrival"), true);
    await until("the section to be marked failed", () => q.tree.get(sid)?.status === "error");
    assert.match(String(q.tree.get(sid)?.error), /disk I\/O error/);
    const logged = db.prepare("SELECT props FROM events WHERE event = 'job_error'").all()
      .map((r) => JSON.parse(String(r.props)) as { name: string; key: string; error: string });
    assert.ok(logged.some((e) => e.name === "distil" && e.key === sid && /disk I\/O error/.test(e.error)), JSON.stringify(logged));
    assert.equal(isDistilRunning(sid), false, "and it no longer counts as running, so a retry is accepted");
    assert.equal(callsAbout("Oboe"), 0);
  } finally { db.exec("DROP TRIGGER oboe_claim_fails"); }
  assert.equal(enqueueDistil("board", sid, null, "retry"), true);
  await until("the retry to land", () => q.tree.get(sid)?.status === "ready");
});

test("a model call that fails after the section moved on leaves the section as it is now", async (t) => {
  t.mock.method(console, "error", () => {});
  const { sid } = source("Cello");
  held = failing = "Cello practice";
  const errorsBefore = Number((db.prepare("SELECT count(*) AS n FROM events WHERE event = 'distil_error'").get() as { n: number }).n);
  assert.equal(enqueueDistil("board", sid, null, "arrival"), true);
  await until("the run to wait on the model", () => isDistilRunning(sid) && q.tree.get(sid)?.status === "running");
  q.upsertTree.run(sid, "res-Cello", "board", "Cello", "Why?", JSON.stringify({ nodes: [] }), "tree", "ready", null, 0, 2);
  release();
  await until("the run to finish", () => !isDistilRunning(sid));
  assert.equal(q.tree.get(sid)?.status, "ready", "the failure is not written over the hand-made tree");
  assert.equal(q.tree.get(sid)?.error, null);
  const errorsAfter = Number((db.prepare("SELECT count(*) AS n FROM events WHERE event = 'distil_error'").get() as { n: number }).n);
  assert.equal(errorsAfter, errorsBefore + 1, "the spent call is still logged");
  failing = "";
});
