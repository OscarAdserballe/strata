import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

test("online backup includes writes still living in WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-backup-test-"));
  const source = join(dir, "live.db");
  const target = join(dir, "backups", "copy.db");
  try {
    const live = new DatabaseSync(source);
    live.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('still in WAL')");
    const run = spawnSync(process.execPath, ["tools/backup.mjs", target], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, STRATA_DB: source },
      encoding: "utf-8",
    });
    live.close();
    assert.equal(run.status, 0, run.stderr);
    const copy = new DatabaseSync(target, { readOnly: true });
    assert.equal(copy.prepare("SELECT text FROM notes").get()?.text, "still in WAL");
    assert.equal(copy.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.equal(copy.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
    copy.close();
    assert.equal(existsSync(`${target}-wal`), false, "the transport backup is one file");
    assert.equal(existsSync(`${target}-shm`), false, "the transport backup is one file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
