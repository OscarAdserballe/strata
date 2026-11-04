// Logging must never break a request: every write here is wrapped.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

export function ensureEventsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY,
    ts      INTEGER NOT NULL,
    session TEXT,
    app     TEXT NOT NULL,
    event   TEXT NOT NULL,
    props   TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS events_ts ON events(ts)");
  db.exec("CREATE INDEX IF NOT EXISTS events_event ON events(event)");
  db.exec(`CREATE INDEX IF NOT EXISTS events_card_grades
    ON events(json_extract(props, '$.card'), ts, id) WHERE event = 'card_grade'`);
}

const inserters = new WeakMap<DatabaseSync, ReturnType<DatabaseSync["prepare"]>>();
function inserter(db: DatabaseSync): ReturnType<DatabaseSync["prepare"]> {
  let stmt = inserters.get(db);
  if (!stmt) {
    stmt = db.prepare("INSERT INTO events (ts, session, app, event, props) VALUES (?, ?, ?, ?, ?)");
    inserters.set(db, stmt);
  }
  return stmt;
}

export function logEvent(
  db: DatabaseSync,
  app: string,
  event: string,
  props?: unknown,
  session?: string | null,
): void {
  try {
    inserter(db).run(Date.now(), session ?? null, app, event, props == null ? null : JSON.stringify(props));
  } catch {
    /* logging is best-effort and must never break the request that triggered it */
  }
}

export function sessionOf(req: IncomingMessage): string | null {
  const h = req.headers["x-session"];
  if (typeof h === "string" && h.length > 0 && h.length <= 64) return h;
  return null;
}

const ASSET_RE = /\.(?:js|jsx|css|png|svg|ico|map|woff2?)$/i;

// Health probes are not usage; matched at the end of the path so /u/<name>/api/health is caught too.
const PROBE_RE = /\/api\/health$/;
const POLL_RE = /\/api\/(?:imports|boards\/[^/]+\/status)$/;
const BEACON_RE = /\/api\/perf$/;

// Request timings get their own table: as events they bloated every scan of the events table.
export function ensureRequestLog(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS request_log (
    ts      INTEGER NOT NULL,
    session TEXT,
    method  TEXT NOT NULL,
    path    TEXT NOT NULL,
    status  INTEGER,
    ms      INTEGER
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS request_log_ts ON request_log(ts)");
}
const requestInserters = new WeakMap<DatabaseSync, ReturnType<DatabaseSync["prepare"]>>();

export function pruneRequestLog(db: DatabaseSync, keepMs = 30 * 864e5): void {
  try { db.prepare("DELETE FROM request_log WHERE ts < ?").run(Date.now() - keepMs); } catch { /* best-effort */ }
}

export function logRequest(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  session: string | null = sessionOf(req),
): void {
  const path = (req.url ?? "/").split("?")[0];
  if (ASSET_RE.test(path) || PROBE_RE.test(path) || BEACON_RE.test(path) || (req.method === "GET" && POLL_RE.test(path))) return;
  const start = Date.now();
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    try {
      let insert = requestInserters.get(db);
      if (!insert) {
        insert = db.prepare("INSERT INTO request_log (ts, session, method, path, status, ms) VALUES (?, ?, ?, ?, ?, ?)");
        requestInserters.set(db, insert);
      }
      insert.run(start, session ?? null, req.method ?? "GET", path, res.statusCode, Date.now() - start);
    } catch {
    }
  };
  res.once("finish", finish);
  res.once("close", finish);
}
