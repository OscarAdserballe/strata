// Rule: whatever the reader can do, an agent can do too, or the reason it can't is written down. Every write route the
// room serves is one of the reader's actions, so each must be in server/features/agent/coverage.ts: a way for an agent,
// a reason it is the reader's alone, or a gap still to close. A new route fails here until someone decides.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "strata-coverage-"));
process.env.STRATA_DB = join(dir, "coverage.db");
process.env.GEMINI_API_KEY = "";
const { db } = await import("../server/platform/db/db.ts");
const { apiRoutes } = await import("../server/features/index.ts");
const { receiptModeOf } = await import("../server/platform/router/router.ts");
const { AGENT_WAY, HUMAN_ONLY, NOT_YET } = await import("../server/features/agent/coverage.ts");
const { OPS } = await import("../server/features/agent/ops.ts");
const { DASH_OPS } = await import("../server/features/dashboard/ops.ts");
const { TOOL_BY_NAME } = await import("../server/features/agent/tools.ts");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// Close a gap and lower this; it never rises.
const NOT_YET_CEILING = 14;

const keyOf = (method: string, pattern: string | RegExp): string =>
  `${method} ${typeof pattern === "string" ? pattern : pattern.source.replace(/^\^|\$$/g, "").replace(/\([^)]*\)/g, ":id").replace(/\\\//g, "/")}`;
// "none" is a POST that only reads (a draft, a tidy suggestion): it changes nothing, so there is nothing to cover.
const writes = apiRoutes.filter((r) => r.method !== "GET" && receiptModeOf(r) !== "none").map((r) => keyOf(r.method, r.pattern));
const lists = { AGENT_WAY, HUMAN_ONLY, NOT_YET } as Record<string, Record<string, unknown>>;

test("every write route has an agent way, a reason it is the reader's alone, or is a named gap", () => {
  const undecided = writes.filter((k) => !Object.values(lists).some((l) => k in l));
  assert.deepEqual(undecided, [], `decide for each in server/features/agent/coverage.ts: AGENT_WAY (an apply op, a dashboard_apply op or a tool), HUMAN_ONLY with why, or NOT_YET:\n  ${undecided.join("\n  ")}`);
  for (const k of writes) {
    const in_ = Object.entries(lists).filter(([, l]) => k in l).map(([n]) => n);
    assert.equal(in_.length, 1, `${k} is in ${in_.join(" and ")}; it belongs in one`);
  }
});

test("every route coverage.ts names is still served", () => {
  const served = new Set(writes);
  const stale = Object.values(lists).flatMap((l) => Object.keys(l)).filter((k) => !served.has(k));
  assert.deepEqual(stale, [], "a renamed or removed route is still listed in coverage.ts");
});

test("every agent way names an op or tool that exists", () => {
  const missing: string[] = [];
  for (const [k, w] of Object.entries(AGENT_WAY)) for (const way of [w].flat()) {
    if ("apply" in way && !(way.apply in OPS)) missing.push(`${k}: apply op ${way.apply}`);
    if ("dash" in way && !(way.dash in DASH_OPS)) missing.push(`${k}: dashboard_apply op ${way.dash}`);
    if ("tool" in way && !TOOL_BY_NAME.has(way.tool)) missing.push(`${k}: tool ${way.tool}`);
  }
  assert.deepEqual(missing, []);
  for (const [k, why] of Object.entries(HUMAN_ONLY)) assert.ok(why.trim().length > 10, `${k}: say why it is the reader's alone`);
});

test("the gaps only shrink", () => {
  const n = Object.keys(NOT_YET).length;
  assert.ok(n <= NOT_YET_CEILING, `NOT_YET has ${n}; it may not grow past ${NOT_YET_CEILING}. Give the new route an op instead.`);
});

test("every dashboard op is how an agent does one of the reader's routes", () => {
  const used = new Set(Object.values(AGENT_WAY).flat().flatMap((w) => ("dash" in w ? [w.dash] : [])));
  // post answers a press: the reader's side of it is the press, which is theirs alone.
  const unrouted = Object.keys(DASH_OPS).filter((op) => !used.has(op) && op !== "post");
  assert.deepEqual(unrouted, [], "an op no route matches does something the reader can't");
});
