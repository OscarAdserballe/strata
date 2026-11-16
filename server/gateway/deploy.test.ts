import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployStatus, readUpdater, watchDeploy } from "./deploy.ts";

const now = 1_800_000_000_000, build = "a".repeat(40), other = "b".repeat(40);
const fresh = { at: now / 1000 - 30, state: "current", backup: "ok" } as const;

test("the deploy dot is green on main's head, orange when behind or unwatched, red when the updater gave up", () => {
  assert.equal(deployStatus(build, fresh, { sha: build, at: now - 3_600_000 }, now).level, "green");
  assert.equal(deployStatus(build, null, null, now).level, "green");
  assert.equal(deployStatus(build, fresh, { sha: other, at: now - 5 * 60_000 }, now).level, "green");
  const behind = deployStatus(build, fresh, { sha: other, at: now - 45 * 60_000 }, now);
  assert.equal(behind.level, "orange"); assert.match(behind.line, /main is at bbbbbbb, merged 45 min ago; still running aaaaaaa/);
  assert.equal(deployStatus(build, { ...fresh, at: now / 1000 - 3600 }, { sha: build, at: 0 }, now).level, "orange");
  assert.equal(deployStatus(build, { ...fresh, state: "pull-failed" }, null, now).level, "orange");
  assert.equal(deployStatus(build, { ...fresh, state: "refused" }, { sha: other, at: now }, now).level, "red");
  assert.equal(deployStatus(build, { ...fresh, backup: "failed" }, { sha: build, at: 0 }, now).level, "red");
});

test("the updater's report is read from its file, and a dev build has no dot", () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-deploy-")), file = join(dir, "updater.json");
  assert.equal(readUpdater(file), null);
  writeFileSync(file, '{"at":17'); assert.equal(readUpdater(file), null);
  writeFileSync(file, '{"at":1700000000,"state":"refused","backup":"ok"}');
  assert.deepEqual(readUpdater(file), { at: 1700000000, state: "refused", backup: "ok" });
  assert.equal(watchDeploy("dev", "o/r"), undefined);
  assert.equal(watchDeploy(build, undefined, file)!().level, "red");
});
