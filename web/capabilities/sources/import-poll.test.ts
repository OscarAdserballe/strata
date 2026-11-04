import { test } from "node:test";
import assert from "node:assert/strict";
import { importsMoving, importPollDelay } from "./import-poll.ts";
import type { ImportStatus } from "../../../shared/imports/import-status.ts";

const job = (stage: ImportStatus["stage"], generation?: ImportStatus["generation"]): ImportStatus => ({
  id: "i", board_id: "b", filename: "f.pdf", size: 1, received: 1, stage, error: null, page: 0, pages: 0,
  resource_id: stage === "imported" ? "r" : null, updated_at: 0, ...(generation ? { generation } : {}),
});
const done = { ready: 3, total: 3, failed: 0, busy: 0, disabled: 0, error: null };

test("nothing moving: the watch slows to once a minute instead of every 4 s", () => {
  assert.equal(importsMoving([job("imported", done), job("imported", done), job("cancelled")], []), false);
  assert.equal(importPollDelay(false), 60_000);
});

test("the longer nothing moves, the less often it looks: doubling to five minutes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => importPollDelay(false, n)), [60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  assert.equal(importPollDelay(true, 9), 4000, "something moving is watched closely however long it was idle");
});

test("a stage the server advances by itself is watched closely", () => {
  for (const stage of ["uploading", "stored", "extracting", "sizing", "queued", "finalizing"] as const)
    assert.equal(importsMoving([job(stage)], []), true, stage);
  assert.equal(importPollDelay(true), 4000);
});

test("chapters still generating after the import count as moving", () => {
  assert.equal(importsMoving([job("imported", { ...done, ready: 1, busy: 2 })], []), true);
});

test("waiting on the reader, or on a retry, is not moving", () => {
  assert.equal(importsMoving([job("awaiting_groups"), job("error")], []), false);
});

test("a local upload still retrying is moving; one that gave up is not", () => {
  assert.equal(importsMoving([], [{ retryAt: Date.now() + 4000 }]), true);
  assert.equal(importsMoving([], [{ retryAt: Number.MAX_SAFE_INTEGER }]), false);
});
