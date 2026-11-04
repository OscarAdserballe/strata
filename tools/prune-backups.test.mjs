import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("backup retention keeps daily, then weekly, then monthly recovery points", () => {
  const dir = join(tmpdir(), `strata-retention-${process.pid}-${Date.now()}`);
  mkdirSync(dir);
  for (let days = 0; days < 220; days += 1) {
    const date = new Date(Date.UTC(2026, 8, 5, 12) - days * 86400_000);
    const stamp = date.toISOString().replace(/:/g, "-").replace(".000", "");
    writeFileSync(join(dir, `strata-ada-${stamp}.db`), "backup");
  }
  writeFileSync(join(dir, ".partial.db"), "unfinished");
  writeFileSync(join(dir, "notes.txt"), "unrelated");

  const result = spawnSync(process.execPath, [join(import.meta.dirname, "prune-backups.mjs"), dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const names = readdirSync(dir);
  const backups = names.filter((name) => name.endsWith(".db") && !name.startsWith("."));
  assert.ok(backups.length >= 15 && backups.length <= 18, `${backups.length} backups kept`);
  assert.ok(names.includes(".partial.db"));
  assert.ok(names.includes("notes.txt"));
  assert.ok(backups.some((name) => name.includes("2026-09-05")));
  assert.ok(backups.some((name) => name.includes("2026-03-")));
});
