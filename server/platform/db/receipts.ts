import type { DatabaseSync } from "node:sqlite";

export const RECEIPT_KEY = /^[A-Za-z0-9-]{8,80}$/;

// A week: clients retry for minutes, and stored bodies reference board states, so rows stay small.
export const RECEIPT_KEEP_MS = 7 * 864e5;

export interface Receipt {
  key: string;
  method: string;
  path: string;
  /** sha256 hex of the raw request body, '' for none */
  body_hash: string;
  /** 'done', or 'open' between a two-phase route's phases */
  state: string;
  status: number;
  body: string | null;
  rev: number | null;
  created_at: number;
}

export function ensureReceipts(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS request_receipts (
    key        TEXT PRIMARY KEY,
    method     TEXT NOT NULL,
    path       TEXT NOT NULL,
    body_hash  TEXT NOT NULL,
    state      TEXT NOT NULL DEFAULT 'done',
    status     INTEGER NOT NULL,
    body       TEXT,
    rev        INTEGER,
    created_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS request_receipts_created ON request_receipts(created_at)");
}

export function pruneReceipts(db: DatabaseSync, keepMs = RECEIPT_KEEP_MS): void {
  try { db.prepare("DELETE FROM request_receipts WHERE created_at < ?").run(Date.now() - keepMs); }
  catch (e) { console.error("strata: pruning receipts failed", e); }
}

// `put` returns false for a key already stored, so the router can answer with that receipt instead.
export interface ReceiptStore {
  find(key: string): Receipt | undefined;
  put(r: Omit<Receipt, "state"> & { state?: "done" | "open" }): boolean;
  finish(key: string, status: number, body: string | null, rev: number | null): boolean;
}
const stores = new WeakMap<DatabaseSync, ReceiptStore>();
export function receiptStore(db: DatabaseSync): ReceiptStore {
  let s = stores.get(db);
  if (s) return s;
  const find = db.prepare("SELECT key, method, path, body_hash, state, status, body, rev, created_at FROM request_receipts WHERE key = ?");
  const put = db.prepare(`INSERT INTO request_receipts (key, method, path, body_hash, state, status, body, rev, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`);
  const finish = db.prepare("UPDATE request_receipts SET state = 'done', status = ?, body = ?, rev = ? WHERE key = ? AND state = 'open'");
  s = {
    find: (key) => find.get(key) as Receipt | undefined,
    put: (r) => Number(put.run(r.key, r.method, r.path, r.body_hash, r.state ?? "done", r.status, r.body, r.rev, r.created_at).changes) === 1,
    finish: (key, status, body, rev) => Number(finish.run(status, body, rev, key).changes) === 1,
  };
  stores.set(db, s);
  return s;
}
