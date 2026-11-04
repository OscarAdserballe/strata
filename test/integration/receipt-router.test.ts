import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const dir = mkdtempSync(join(tmpdir(), "strata-receipt-router-"));
const file = join(dir, "router.db");
process.env.STRATA_DB = file;
process.env.GEMINI_API_KEY = "";
const { db } = await import("../../server/platform/db/db.ts");
const { q } = await import("../../server/features/repo.ts");
const { dispatch, route } = await import("../../server/platform/router/router.ts");
const { sendJson } = await import("../../server/platform/http/http.ts");
const { publicRoutes } = await import("../../server/features/system/routes.ts");
const { importRoutes } = await import("../../server/features/imports/routes.ts");
// no server/main.ts here: the board-state builder must come with the routes that name it
const { mintRoutes } = await import("../../server/features/author/routes.ts");

db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, k TEXT NOT NULL)");
const probes = (k: string): number => Number((db.prepare("SELECT count(*) AS n FROM probe WHERE k = ?").get(k) as { n: number }).n);
const receiptsFor = (key: string): number => Number((db.prepare("SELECT count(*) AS n FROM request_receipts WHERE key = ?").get(key) as { n: number }).n);
const insertProbe = db.prepare("INSERT INTO probe (k) VALUES (?)");
const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let slowRuns = 0;
const other = new DatabaseSync(file, { timeout: 5000 });

const testRoutes = [
  route("POST", "/t/slow", async ({ body, commit }) => {
    const b = await body<{ k: string }>();
    slowRuns++;
    await tick(50);
    commit(() => { insertProbe.run(b.k); return { status: 201, body: { k: b.k, run: slowRuns } }; });
  }, { receipt: "atomic" }),
  route("POST", "/t/taken", async ({ req, body, commit }) => {
    const b = await body<{ k: string }>();
    const key = String(req.headers["idempotency-key"]);
    other.prepare(`INSERT INTO request_receipts (key, method, path, body_hash, state, status, body, rev, created_at)
      VALUES (?, 'POST', '/t/taken', ?, 'done', 201, ?, 0, ?)`)
      .run(key, createHash("sha256").update(JSON.stringify(b)).digest("hex"), JSON.stringify({ k: b.k, by: "the other process" }), Date.now());
    commit(() => { insertProbe.run(b.k); return { status: 201, body: { k: b.k, by: "this one" } }; });
  }, { receipt: "atomic" }),
  route("POST", "/t/dated", ({ commit }) => {
    commit(() => ({ status: 200, body: { at: new Date(0), list: [new Date(0)] } }));
  }, { receipt: "atomic" }),
];

const server = createServer(async (req, res) => {
  try {
    if (!await dispatch([...testRoutes, ...publicRoutes, ...importRoutes, ...mintRoutes], {
      req, res, ssn: null, url: new URL(req.url!, "http://localhost"),
    })) res.writeHead(404).end();
  } catch (e) {
    const status = (e as { httpStatus?: number }).httpStatus ?? 500;
    if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
  }
});
let base: string;
let port = 0;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  other.close(); db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Answer { status: number; body: any; replay: boolean }
async function send(method: string, path: string, body: unknown, key?: string): Promise<Answer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== undefined) headers["Idempotency-Key"] = key;
  const r = await fetch(base + path, { method, headers, body: body instanceof Buffer ? new Blob([body]) : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, replay: r.headers.get("Idempotent-Replay") === "true" };
}

// A body that is never ended is answered only by a handler that does not wait for all of it.
function unended(path: string, chunk: Buffer, key: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key, "Content-Length": String(chunk.length + 1e6) } });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`${path}: no answer while the body was still open — it was read up front`)); }, 3000);
    req.on("response", (res: IncomingMessage) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => { clearTimeout(timer); req.destroy(); resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }); });
    });
    req.on("error", (e) => { clearTimeout(timer); if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
    req.write(chunk);
  });
}

test("two requests under one key while the first awaits: the handler runs once, the second waits and replays", async () => {
  slowRuns = 0;
  const key = "slow-key-0001";
  const [a, b] = await Promise.all([send("POST", "/t/slow", { k: "slow" }, key), send("POST", "/t/slow", { k: "slow" }, key)]);
  assert.equal(slowRuns, 1, "the second request waited for the first rather than running the handler");
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.deepEqual(a.body, b.body);
  assert.equal([a, b].filter((x) => x.replay).length, 1, "exactly one answer is the replay");
  assert.equal(probes("slow"), 1);
  assert.equal(receiptsFor(key), 1);
});

test("a key stored by another process mid-request: this one's rows roll back and that answer is replayed", async () => {
  const key = "taken-key-0001";
  const r = await send("POST", "/t/taken", { k: "taken" }, key);
  assert.equal(r.status, 201);
  assert.equal(r.replay, true);
  assert.deepEqual(r.body, { k: "taken", by: "the other process" });
  assert.equal(probes("taken"), 0, "the commit's own row went with its refused receipt");
  assert.equal(receiptsFor(key), 1);
});

test("a keyed login keeps its own 16 KB cap and rate limit: the router never buffers its body", async () => {
  const big = await unended("/api/login", Buffer.alloc(20 * 1024, 0x61), "login-key-0001");
  assert.equal(big.status, 413);
  // the rest of the eight attempts a window allows (no password is configured: each is a 401)…
  for (let i = 0; i < 7; i++) assert.equal((await send("POST", "/api/login", { password: "nope" }, "login-key-0002")).status, 401);
  const limited = await unended("/api/login", Buffer.from('{"password":'), "login-key-0003");
  assert.equal(limited.status, 429);
  assert.equal(receiptsFor("login-key-0002"), 0, "login is exempt: no receipt");
});

test("a keyed PUT of import bytes stores the whole chunk: the handler streams the body itself", async () => {
  q.insBoard.run("imp", "Imports", "blank", 1, 1);
  const id = "import-under-key-1";
  const made = await send("POST", "/api/imports", { id, board: "imp", filename: "book.pdf", size: 1000 });
  assert.equal(made.status, 201);
  const chunk = await send("PUT", `/api/imports/${id}/bytes?offset=0`, Buffer.alloc(1000, 7), "bytes-key-0001");
  assert.equal(chunk.status, 200);
  assert.equal(chunk.body.import.received, 1000);
  assert.equal(chunk.replay, false);
  assert.equal(receiptsFor("bytes-key-0001"), 0);
});

test("a body with a Date is one shape first, on replay and without a key", async () => {
  const at = new Date(0).toISOString();
  const first = await send("POST", "/t/dated", {}, "dated-key-0001");
  const again = await send("POST", "/t/dated", {}, "dated-key-0001");
  const unkeyed = await send("POST", "/t/dated", {});
  assert.deepEqual(first.body, { at, list: [at] });
  assert.equal(again.replay, true);
  assert.deepEqual(again.body, first.body);
  assert.deepEqual(unkeyed.body, first.body);
});

test("a route table dispatched without server/main.ts still builds the board a write names", async () => {
  q.insBoard.run("minted-here", "Minted", "blank", 1, 1);
  const made = await send("POST", "/api/boards/minted-here/minted", { front: "Why hedge convexity?", variant: "bare" }, "minted-key-0001");
  assert.equal(made.status, 201);
  assert.equal(made.body.state.board.id, "minted-here");
  const again = await send("POST", "/api/boards/minted-here/minted", { front: "Why hedge convexity?", variant: "bare" }, "minted-key-0001");
  assert.equal(again.replay, true);
  assert.equal(again.body.id, made.body.id);
});
