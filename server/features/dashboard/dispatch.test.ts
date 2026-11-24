import { test } from "node:test";
import assert from "node:assert/strict";
import { claimVerdict } from "./dispatch.ts";

test("claimVerdict: a thread is free, this run's, or another run's until its claim lapses", () => {
  const c = { task_id: "t_1", run: "run-a", at: 0, until: 1000 };
  assert.equal(claimVerdict(undefined, "run-a", 10), "free");
  assert.equal(claimVerdict(c, "run-a", 10), "mine");
  assert.equal(claimVerdict(c, "run-b", 10), "taken");
  assert.equal(claimVerdict(c, null, 10), "taken", "a post that names no run can't work a thread another run holds");
  assert.equal(claimVerdict(c, "run-b", 1000), "free", "a lapsed claim frees the thread");
});
