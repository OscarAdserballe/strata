import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrations.ts";
import { DATA_DIR, DB_PATH } from "../config.ts";

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

// WAL lets readers continue during writes; synchronous=NORMAL risks only the last commits on power loss.
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

// Other processes (backups, scripts) write this file: wait briefly for their lock instead of failing.
db.exec("PRAGMA busy_timeout = 1500");
db.exec("PRAGMA cache_size = -32768");
db.exec("PRAGMA temp_store = MEMORY");

migrate(db);

try { db.exec("PRAGMA optimize = 0x10002"); } catch (e) { console.error("  optimize failed:", e instanceof Error ? e.message : e); }
