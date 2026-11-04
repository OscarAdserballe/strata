// Rule: every table a board or a deck owns is either readable by an agent (a kind lists it) or
// hidden on purpose (HIDDEN gives the reason). A new table fails here until someone decides.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "strata-kinds-"));
process.env.STRATA_DB = join(dir, "kinds.db");
process.env.GEMINI_API_KEY = "";
const { db } = await import("../server/platform/db/db.ts");
const { REVISIONED, ROOM_ONLY } = await import("../server/platform/db/revisions.ts");
const { KINDS, HIDDEN } = await import("../server/features/agent/kinds.ts");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const read = new Set(KINDS.flatMap((k) => k.tables));
const owned = [...new Set([...REVISIONED.map((t) => t.table), "review_receipts"])];

test("every table a board or deck owns is readable by agents or hidden with a reason", () => {
  const undecided = owned.filter((t) => !read.has(t) && !(t in HIDDEN));
  assert.deepEqual(undecided, [], `decide for each: add it to a kind in server/features/agent/kinds.ts, or to HIDDEN with why:\n  ${undecided.join("\n  ")}`);
  const both = owned.filter((t) => read.has(t) && t in HIDDEN);
  assert.deepEqual(both, [], "a table is either read or hidden, not both");
});

test("every table the agent kinds name exists", () => {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
  const missing = [...read, ...Object.keys(HIDDEN)].filter((t) => !tables.has(t));
  assert.deepEqual(missing, [], "a renamed or dropped table is still named in kinds.ts");
  assert.ok(ROOM_ONLY.some((r) => r.table === "agent_tokens"), "making or revoking a token moves the room revision, so the token list rereads");
});
