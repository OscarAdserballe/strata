#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

const appDir = join(import.meta.dirname, "..");
const source = resolve(process.env.STRATA_DB ?? join(process.env.STRATA_DATA ?? join(appDir, "data"), "strata.db"));
const targetArg = process.argv[2];

if (!targetArg) {
  console.error("usage: npm run backup -- PATH/strata.db");
  process.exit(2);
}

const target = resolve(targetArg);
if (!existsSync(source)) throw new Error(`database does not exist: ${source}`);
if (existsSync(target)) throw new Error(`backup already exists: ${target}`);
mkdirSync(dirname(target), { recursive: true });

const db = new DatabaseSync(source, { readOnly: true, timeout: 10_000 });
try { await backup(db, target); } finally { db.close(); }
chmodSync(target, 0o600);

// Convert the WAL copy back to a rollback journal so the single file is a complete backup.
const copy = new DatabaseSync(target);
try {
  copy.exec("PRAGMA journal_mode = DELETE");
  const result = copy.prepare("PRAGMA integrity_check").get();
  if (result?.integrity_check !== "ok") throw new Error(`backup integrity check failed: ${JSON.stringify(result)}`);
} finally { copy.close(); }

console.log(`backup ok: ${target}`);
