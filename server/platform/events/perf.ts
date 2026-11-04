// Stored per sample: name, duration, build and device class; nothing that says what was being read.
import type { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { transaction } from "../db/transaction.ts";

export function ensurePerfSamples(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS perf_samples (
    ts      INTEGER NOT NULL,
    build   TEXT,
    device  TEXT,                 -- desktop | tablet | phone | server
    journey TEXT NOT NULL,        -- home | board | pdf.open | highlight | flip | chat.key | …
    ms      INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS perf_samples_journey ON perf_samples(journey, ts)");
}

const JOURNEY = /^[a-z][a-z0-9.]{0,31}$/;
const DEVICES = new Set(["desktop", "tablet", "phone"]);
const inserters = new WeakMap<DatabaseSync, ReturnType<DatabaseSync["prepare"]>>();
const insert = (db: DatabaseSync) => {
  let s = inserters.get(db);
  if (!s) { s = db.prepare("INSERT INTO perf_samples (ts, build, device, journey, ms) VALUES (?, ?, ?, ?, ?)"); inserters.set(db, s); }
  return s;
};

export function recordClientSamples(db: DatabaseSync, body: { build?: unknown; device?: unknown; samples?: unknown }): number {
  const build = typeof body.build === "string" ? body.build.slice(0, 16) : null;
  const device = typeof body.device === "string" && DEVICES.has(body.device) ? body.device : null;
  const samples = body.samples;
  if (!Array.isArray(samples)) return 0;
  const now = Date.now();
  let n = 0;
  transaction(db, () => {
    for (const s of samples.slice(0, 200)) {
      const j = (s as { j?: unknown }).j, ms = (s as { ms?: unknown }).ms, at = (s as { at?: unknown }).at;
      if (typeof j !== "string" || !JOURNEY.test(j) || typeof ms !== "number" || !(ms >= 0 && ms <= 600_000)) continue;
      // a client clock may be wrong; a sample from the future or the distant past is filed at arrival
      const ts = typeof at === "number" && at <= now + 60_000 && at >= now - 864e5 ? at : now;
      insert(db).run(Math.round(ts), build, device, j, Math.round(ms));
      n++;
    }
  });
  return n;
}

// Event-loop delay: node:sqlite is synchronous, so this measures a request stuck behind another's work.
export function watchEventLoop(db: DatabaseSync, build: () => string, everyMs = 300_000): () => void {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const timer = setInterval(() => {
    try {
      if (h.count > 0) {
        const at = Date.now(), b = build() || null;
        insert(db).run(at, b, "server", "server.loop.p99", Math.round(h.percentile(99) / 1e6));
        insert(db).run(at, b, "server", "server.loop.max", Math.round(h.max / 1e6));
      }
    } catch { /* best-effort */ }
    h.reset();
  }, everyMs);
  timer.unref();
  return () => { clearInterval(timer); h.disable(); };
}

export function prunePerfSamples(db: DatabaseSync, keepMs = 30 * 864e5): void {
  try { db.prepare("DELETE FROM perf_samples WHERE ts < ?").run(Date.now() - keepMs); } catch { /* best-effort */ }
}
