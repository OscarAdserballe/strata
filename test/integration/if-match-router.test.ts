import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "strata-if-match-router-"));
process.env.STRATA_DB = join(dir, "router.db");
process.env.GEMINI_API_KEY = "";
const { db } = await import("../../server/platform/db/db.ts");
const { dispatch, route } = await import("../../server/platform/router/router.ts");
const { sendJson } = await import("../../server/platform/http/http.ts");

db.exec("CREATE TABLE doc (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, text TEXT NOT NULL); INSERT INTO doc VALUES (1, 1, 'first')");
db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, k TEXT NOT NULL)");
const doc = () => ({ ...db.prepare("SELECT rev, text FROM doc WHERE id = 1").get() }) as { rev: number; text: string };
const probes = (): number => Number((db.prepare("SELECT count(*) AS n FROM probe").get() as { n: number }).n);
const receiptsFor = (key: string): number => Number((db.prepare("SELECT count(*) AS n FROM request_receipts WHERE key = ?").get(key) as { n: number }).n);
const write = db.prepare("UPDATE doc SET rev = rev + 1, text = ? WHERE id = 1");
const probe = db.prepare("INSERT INTO probe (k) VALUES (?)");

let after_ = 0;
const routes = [
  route("PUT", "/t/doc", async ({ body, commit, ifMatch }) => {
    const b = await body<{ text: string }>();
    commit(() => {
      ifMatch(doc().rev, () => ({ text: doc().text }));
      write.run(b.text);
      return { status: 200, body: doc() };
    });
    after_++;
  }, { receipt: "atomic" }),
  route("PUT", "/t/late", async ({ body, commit, ifMatch }) => {
    const b = await body<{ text: string }>();
    commit(() => {
      probe.run(b.text);
      ifMatch(doc().rev, () => ({ text: doc().text }));
      write.run(b.text);
      return { status: 200, body: doc() };
    });
  }, { receipt: "atomic" }),
  route("PUT", "/t/outside", async ({ body, commit, ifMatch }) => {
    const b = await body<{ text: string }>();
    ifMatch(doc().rev, () => ({ text: doc().text }));
    commit(() => { write.run(b.text); return { status: 200, body: doc() }; });
  }, { receipt: "atomic" }),
];

const server = createServer(async (req, res) => {
  try {
    if (!await dispatch(routes, { req, res, ssn: null, url: new URL(req.url!, "http://localhost") })) res.writeHead(404).end();
  } catch (e) {
    const status = (e as { httpStatus?: number }).httpStatus ?? 500;
    if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
  }
});
let base = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function put(path: string, text: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(base + path, { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ text }) });
  return { status: r.status, body: await r.json() };
}

test("a stale base is answered 409 with the value, ends the handler, and writes nothing — keyed or not", async () => {
  const { rev } = doc();
  assert.equal((await put("/t/doc", "second", { "If-Match": `"${rev}"` })).status, 200);
  const ran = after_;
  for (const headers of [{}, { "Idempotency-Key": "if-match-router-stale-1" }] as Record<string, string>[]) {
    const stale = await put("/t/doc", "over the first", { "If-Match": `"${rev}"`, ...headers });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { error: "changed elsewhere", conflict: { rev: rev + 1, value: { text: "second" } } });
  }
  assert.deepEqual(doc(), { rev: rev + 1, text: "second" });
  assert.equal(after_, ran, "nothing after the commit ran for a refused write");
  assert.equal(receiptsFor("if-match-router-stale-1"), 0, "and no receipt was kept");
  const retried = await put("/t/doc", "over the second", { "If-Match": `"${rev + 1}"`, "Idempotency-Key": "if-match-router-stale-1" });
  assert.equal(retried.status, 200, "so the key is free for the retry over the fresh base");
  assert.equal(receiptsFor("if-match-router-stale-1"), 1);
});

test("a conflict rolls back the whole commit, a write made before the check included", async () => {
  const { rev } = doc();
  const before = probes();
  const stale = await put("/t/late", "slipped in first", { "If-Match": `"${rev - 1}"` });
  assert.equal(stale.status, 409);
  assert.equal(probes(), before, "the probe written ahead of the check went with the rollback");
  assert.equal(doc().rev, rev);
});

test("a check outside the commit is refused, and nothing is written", async () => {
  const held = doc();
  const outside = await put("/t/outside", "unguarded", { "If-Match": `"${held.rev}"` });
  assert.equal(outside.status, 500);
  assert.match(outside.body.error, /inside ctx\.commit/);
  assert.deepEqual(doc(), held);
});
