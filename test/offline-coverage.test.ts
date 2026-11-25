// Rule: every route the server answers says what it does offline (web/data/offline-coverage.ts). A new read
// or write fails here until someone decides whether a Download saves it, it waits on the device, or it needs a connection.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "strata-offline-"));
process.env.STRATA_DB = join(dir, "offline.db");
process.env.GEMINI_API_KEY = "";
const { db } = await import("../server/platform/db/db.ts");
const { apiRoutes, publicRoutes } = await import("../server/features/index.ts");
const { READS, WRITES, readRow, writeRow, savedUrls } = await import("../web/data/offline-coverage.ts");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const ID = "0123456789abcdef";
const routes = [...apiRoutes, ...publicRoutes];
/** One concrete path a route answers: each capture group becomes an id every pattern accepts. */
const sampleOf = (p: string | RegExp): string =>
  typeof p === "string" ? p : p.source.replace(/^\^/, "").replace(/\$$/, "").replace(/\((?!\?)[^)]*\)/g, ID).replace(/\\\//g, "/");
const answers = (p: string | RegExp, path: string) => (typeof p === "string" ? p === path : p.test(path));
const sampleRow = (path: string) => path.replace(/:[a-z]+/g, ID);

test("every server route says what it does offline", () => {
  const missing = routes.map((r) => ({ r, path: sampleOf(r.pattern) }))
    .filter(({ r, path }) => (r.method === "GET" ? !readRow(path) : !writeRow(r.method, path)))
    .map(({ r, path }) => `${r.method} ${path}`);
  assert.deepEqual(missing, [], "add a row to READS or WRITES in web/data/offline-coverage.ts");
});

test("every row names a route the server still has", () => {
  const stale = [
    ...READS.filter((row) => !row.path.includes("*")).map((row) => ({ method: "GET", path: sampleRow(row.path) })),
    ...WRITES.filter((row) => !row.route.includes("*")).map((row) => { const [method, path] = row.route.split(" "); return { method, path: sampleRow(path) }; }),
  ].filter(({ method, path }) => !routes.some((r) => r.method === method && answers(r.pattern, path)))
    .map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(stale, [], "the server no longer answers these; drop their rows");
});

test("a Download names a URL for every saved read, and each answers to its own row", () => {
  const state = {
    resources: [
      { id: "rpdf", kind: "pdf", generation: 0 },
      { id: "rmd", kind: "text", generation: 3 },
      { id: "rhtml", kind: "html", generation: 2 },
    ],
    sections: [{ id: "sec1", resourceId: "rpdf" }],
    pairs: [{ deck: "econometrics" }, { deck: null }],
  } as never;
  const urls = savedUrls({ board: "b1", state, since: 1700000000000 });
  for (const row of READS) {
    if (row.offline !== "saved" || row.path === "/api/images/:hash") continue;
    assert.ok(urls.some((u) => readRow(u) === row), `no URL saved for ${row.path}`);
  }
  for (const u of urls) assert.ok(readRow(u), `${u} answers to no row`);
  assert.ok(urls.includes("/api/boards/b1/resources/rmd/raw?v=3"), "the reader asks for prose with its generation");
  assert.ok(urls.includes("/api/boards/b1/resources/rhtml/live?v=2"), "an HTML page opens from /live");
  assert.ok(urls.includes("/api/review/tree?course=econometrics"), "review's tree is saved per deck");
  assert.ok(!urls.some((u) => u.includes("course=null")), "a pair without a deck saves no deck read");
});

test("a write's row decides whether it waits", () => {
  assert.equal(writeRow("POST", "/api/review/grade")?.offline, "waits");
  assert.equal(writeRow("PUT", "/u/di/api/boards/b1/notes")?.offline, "waits", "the room's mount point is ignored");
  assert.equal(writeRow("PATCH", "/api/boards/b1/resources/r1")?.offline, "live");
});
