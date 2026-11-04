import type { DatabaseSync, StatementSync } from "node:sqlite";

// Statements are prepared once per database, on first use: these run in front of hot reads.
const prepared = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function prep(db: DatabaseSync, sql: string): StatementSync {
  let held = prepared.get(db);
  if (!held) prepared.set(db, held = new Map());
  let s = held.get(sql);
  if (!s) held.set(sql, s = db.prepare(sql));
  return s;
}

export interface ReviewSchedule { rung: number; at: number; dueAt: number }
export type GradeFold<Row> = (rows: Row[], kept?: ReadonlyMap<string, number>) => Map<string, ReviewSchedule>;

const ACTIVITY = "'read_progress','resource_view','card_show','card_grade','card_answer','card_keep','card_unkeep','bench_open'";
const GRADES = "'card_grade','card_answer'";

/** Events stay authoritative: edits invalidate the activity fold, while an append folds only new rows. */
export function ensureProjections(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_meta (id INTEGER PRIMARY KEY, watermark INTEGER NOT NULL, latest INTEGER NOT NULL, reset INTEGER NOT NULL);
    INSERT OR IGNORE INTO activity_meta VALUES (1,0,0,1);
    CREATE TABLE IF NOT EXISTS activity_read (board TEXT, resource TEXT, deepest REAL, ms REAL, at INTEGER, last_id INTEGER, last_depth REAL, PRIMARY KEY(board,resource));
    CREATE TABLE IF NOT EXISTS activity_views (board TEXT, resource TEXT, at INTEGER, PRIMARY KEY(board,resource));
    CREATE TABLE IF NOT EXISTS activity_cards (board TEXT, card TEXT, seen INTEGER, done INTEGER, PRIMARY KEY(board,card));
    CREATE TABLE IF NOT EXISTS activity_bench (deck TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS review_dirty (card TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS review_schedule (card TEXT PRIMARY KEY, rung INTEGER, at INTEGER, due_at INTEGER);
    CREATE INDEX IF NOT EXISTS events_board_activity ON events(event,json_extract(props,'$.board'),id);
    CREATE INDEX IF NOT EXISTS events_card_history ON events(json_extract(props,'$.card'),ts,id) WHERE event IN (${GRADES});
    CREATE TRIGGER IF NOT EXISTS activity_append AFTER INSERT ON events WHEN NEW.event IN (${ACTIVITY}) BEGIN
      UPDATE activity_meta SET latest = MAX(latest,NEW.id) WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS activity_edit AFTER UPDATE ON events WHEN OLD.event IN (${ACTIVITY}) OR NEW.event IN (${ACTIVITY}) BEGIN
      UPDATE activity_meta SET reset=1 WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS activity_delete AFTER DELETE ON events WHEN OLD.event IN (${ACTIVITY}) BEGIN
      UPDATE activity_meta SET reset=1 WHERE id=1;
    END;
    CREATE TRIGGER IF NOT EXISTS review_append AFTER INSERT ON events WHEN NEW.event IN (${GRADES}) BEGIN
      INSERT OR IGNORE INTO review_dirty SELECT json_extract(NEW.props,'$.card') WHERE json_extract(NEW.props,'$.card') IS NOT NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS review_event_delete AFTER DELETE ON events WHEN OLD.event IN (${GRADES}) BEGIN
      INSERT OR IGNORE INTO review_dirty SELECT json_extract(OLD.props,'$.card') WHERE json_extract(OLD.props,'$.card') IS NOT NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS review_event_edit AFTER UPDATE ON events WHEN OLD.event IN (${GRADES}) OR NEW.event IN (${GRADES}) BEGIN
      INSERT OR IGNORE INTO review_dirty SELECT json_extract(OLD.props,'$.card') WHERE json_extract(OLD.props,'$.card') IS NOT NULL;
      INSERT OR IGNORE INTO review_dirty SELECT json_extract(NEW.props,'$.card') WHERE json_extract(NEW.props,'$.card') IS NOT NULL;
    END;
  `);
  for (const table of ["cards", "card_keeps"]) for (const action of ["INSERT", "UPDATE", "DELETE"]) {
    const row = action === "DELETE" ? "OLD" : "NEW";
    db.exec(`CREATE TRIGGER IF NOT EXISTS review_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN
      INSERT OR IGNORE INTO review_dirty VALUES (${row}.id);
    END;`);
  }
  if (!db.prepare("SELECT value FROM settings WHERE key='review-projection-v1'").get()) {
    db.exec("INSERT OR IGNORE INTO review_dirty SELECT id FROM cards; INSERT INTO settings VALUES ('review-projection-v1','1');");
  }
}

export function syncActivity(db: DatabaseSync): void {
  const meta = prep(db, "SELECT watermark,latest,reset FROM activity_meta WHERE id=1").get()!;
  if (!meta.reset && meta.watermark === meta.latest) return;
  db.exec("SAVEPOINT activity_sync");
  try {
    let from = Number(meta.watermark), to = Number(meta.latest);
    if (meta.reset) {
      db.exec("DELETE FROM activity_read; DELETE FROM activity_views; DELETE FROM activity_cards; DELETE FROM activity_bench;");
      from = 0; to = Number(prep(db, "SELECT COALESCE(MAX(id),0) n FROM events").get()!.n);
    }
    const board = "COALESCE(json_extract(props,'$.board'),'')";
    prep(db, `INSERT INTO activity_read SELECT ${board}, json_extract(props,'$.resource'),
      MAX(COALESCE(json_extract(props,'$.deepest'),json_extract(props,'$.pct'),0)), SUM(COALESCE(json_extract(props,'$.ms'),0)),
      MAX(ts), MAX(id), NULL FROM events
      WHERE id>? AND id<=? AND event='read_progress' AND json_extract(props,'$.resource') IS NOT NULL GROUP BY 1,2
      ON CONFLICT(board,resource) DO UPDATE SET deepest=MAX(deepest,excluded.deepest), ms=ms+excluded.ms, at=MAX(at,excluded.at),
      last_depth=CASE WHEN excluded.last_id>last_id THEN excluded.last_depth ELSE last_depth END,last_id=MAX(last_id,excluded.last_id)`).run(from,to);
    // Multiple MAX aggregates don't define which row supplies a bare selected column.
    prep(db, `UPDATE activity_read SET last_depth=(SELECT json_extract(props,'$.deepest') FROM events WHERE id=last_id)
      WHERE last_id>? AND last_id<=?`).run(from,to);
    prep(db, `INSERT INTO activity_views SELECT ${board},json_extract(props,'$.resource'),MAX(ts) FROM events
      WHERE id>? AND id<=? AND event='resource_view' AND json_extract(props,'$.resource') IS NOT NULL GROUP BY 1,2
      ON CONFLICT(board,resource) DO UPDATE SET at=MAX(at,excluded.at)`).run(from,to);
    prep(db, `INSERT INTO activity_cards SELECT ${board},json_extract(props,'$.card'),
      MAX(CASE WHEN event='card_show' THEN id ELSE 0 END),MAX(CASE WHEN event IN (${GRADES}) THEN id ELSE 0 END) FROM events
      WHERE id>? AND id<=? AND event IN ('card_show',${GRADES}) AND json_extract(props,'$.card') IS NOT NULL GROUP BY 1,2
      ON CONFLICT(board,card) DO UPDATE SET seen=MAX(seen,excluded.seen),done=MAX(done,excluded.done)`).run(from,to);
    prep(db, `INSERT OR IGNORE INTO activity_bench SELECT DISTINCT json_extract(props,'$.deck') FROM events
      WHERE id>? AND id<=? AND event IN ('card_keep','card_unkeep','bench_open') AND json_extract(props,'$.deck') IS NOT NULL`).run(from,to);
    prep(db, "UPDATE activity_meta SET watermark=?,latest=?,reset=0 WHERE id=1").run(to,to);
    db.exec("RELEASE activity_sync");
  } catch (e) { db.exec("ROLLBACK TO activity_sync; RELEASE activity_sync"); throw e; }
}

/** Re-fold only changed cards: keeping, dropping, restoring or changing a past verdict invalidates one. */
export function reviewSchedules<Row>(db: DatabaseSync, replayGrades: GradeFold<Row>): Map<string, ReviewSchedule> {
  const rows = prep(db, "SELECT card FROM review_dirty").all();
  if (rows.length) {
    const history = prep(db, `SELECT json_extract(props,'$.card') card,ts,
      COALESCE(json_extract(props,'$.got'),json_extract(props,'$.hit')) got,
      CASE event WHEN 'card_answer' THEN 'answer' ELSE 'grade' END kind,json_extract(props,'$.review') review
      FROM events WHERE event IN (${GRADES}) AND json_extract(props,'$.card')=? ORDER BY ts,id`);
    const keep = prep(db, "SELECT created_at FROM card_keeps WHERE id=?");
    const exists = prep(db, "SELECT id FROM cards WHERE id=?");
    const put = prep(db, "INSERT OR REPLACE INTO review_schedule VALUES (?,?,?,?)");
    const remove = prep(db, "DELETE FROM review_schedule WHERE card=?");
    db.exec("SAVEPOINT review_sync");
    try {
      for (const r of rows) {
        const id = String(r.card), kept = keep.get(id);
        const result = exists.get(id) ? replayGrades(history.all(id) as unknown as Row[], kept ? new Map([[id,Number(kept.created_at)]]) : undefined).get(id) : null;
        if (result) put.run(id,result.rung,result.at,result.dueAt); else remove.run(id);
      }
      db.exec("DELETE FROM review_dirty; RELEASE review_sync");
    } catch (e) { db.exec("ROLLBACK TO review_sync; RELEASE review_sync"); throw e; }
  }
  return new Map(prep(db, "SELECT card,rung,at,due_at FROM review_schedule").all()
    .map(r => [String(r.card), { rung:Number(r.rung), at:Number(r.at), dueAt:Number(r.due_at) }]));
}
