#!/usr/bin/env node
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) {
  console.error("usage: node tools/check-db.mjs PATH/strata.db");
  process.exit(2);
}

const db = new DatabaseSync(resolve(path), { readOnly: true });
try {
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") throw new Error(`integrity check failed: ${JSON.stringify(integrity)}`);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const count = (table) => tables.has(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0;
  console.log(JSON.stringify({ integrity, boards: count("boards"), resources: count("resources"), cards: count("cards") }));
} finally { db.close(); }
