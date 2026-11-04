// A route that states no mode would run a keyed retry again, so every write route must state one.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "strata-modes-"));
process.env.STRATA_DB = join(dir, "modes.db");
process.env.GEMINI_API_KEY = "";
const { db } = await import("../../server/platform/db/db.ts");
const { apiRoutes, publicRoutes } = await import("../../server/features/index.ts");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const re = String.raw;
const WITH_IF_MATCH: string[] = [];

const name = (r: { method: string; pattern: string | RegExp }) => `${r.method} ${typeof r.pattern === "string" ? r.pattern : r.pattern.source}`;
const writes = [...publicRoutes, ...apiRoutes].filter((r) => r.method !== "GET");
const modeOf = (method: string, path: string) => {
  const r = writes.find((w) => w.method === method && (typeof w.pattern === "string" ? w.pattern === path : w.pattern.test(path)));
  assert.ok(r, `no ${method} route answers ${path}`);
  return r.receipt;
};

test("every non-GET route states its receipt mode", () => {
  assert.ok(writes.length >= 50, `only ${writes.length} write routes found`);
  const unstated = writes.filter((r) => r.receipt === undefined).map(name);
  const pending = new Set(WITH_IF_MATCH);
  const fresh = unstated.filter((n) => !pending.has(n));
  const gone = WITH_IF_MATCH.filter((n) => !unstated.includes(n));
  assert.deepEqual(fresh, [], `these write routes state no receipt mode (give them one):\n  ${fresh.join("\n  ")}`);
  assert.deepEqual(gone, [], `these routes state a mode now (or are gone): delete them from WITH_IF_MATCH:\n  ${gone.join("\n  ")}`);
});

test("the modes are the ADR's: the chat turn streams, read-only POSTs keep nothing, beacons and login are exempt", () => {
  assert.equal(modeOf("POST", "/api/boards/b-1/chat"), "stream");
  assert.equal(modeOf("POST", "/api/review/chat"), "stream", "a card thread is kept: two-phase like the board turn");
  assert.equal(modeOf("POST", "/api/cards/tidy"), "none");
  assert.equal(modeOf("PUT", "/api/imports/imp-12345678/bytes"), "exempt");
  for (const path of ["/api/login", "/api/logout", "/api/perf", "/api/log"])
    assert.equal(modeOf("POST", path), "exempt", path);
  assert.equal(modeOf("POST", "/api/boards/b-1/capture"), "atomic");
  assert.equal(modeOf("POST", "/api/boards/b-1/resources"), "atomic");
  assert.equal(modeOf("DELETE", "/api/boards/b-1"), "atomic");
  assert.equal(modeOf("POST", "/api/review/grade"), "atomic");
});
