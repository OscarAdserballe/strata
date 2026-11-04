// Background jobs: one in flight per (name, key), never throw, and never hold a transaction across an await.

import { APP } from "./config.ts";
import { db } from "./db/db.ts";
import { tx } from "./db/tx.ts";
import { logEvent } from "./events/events.ts";

export interface JobCtx { name: string; key: string }

const inFlight = new Map<string, Promise<unknown>>();

export const isJobRunning = (name: string, key: string): boolean => inFlight.has(`${name}\u0000${key}`);

export function runJob<T>(name: string, key: string, fn: (job: JobCtx) => Promise<T>,
                          opts?: { onFail?: (e: Error) => void }): Promise<T | undefined> {
  const id = `${name}\u0000${key}`;
  const running = inFlight.get(id);
  if (running) return running as Promise<T | undefined>;
  /* Registered before the job starts, so a synchronous throw still clears its own entry. */
  let settle!: (value: T | undefined) => void;
  const job = new Promise<T | undefined>((resolve) => { settle = resolve; });
  inFlight.set(id, job);
  const t0 = Date.now();
  /* Start once the current stack unwinds, so the job's first writes never join the caller's transaction. */
  const deferred = db.isTransaction;
  void (async () => {
    try {
      if (deferred) await null;
      settle(await fn({ name, key }));
    }
    catch (e) { jobFailed(name, key, e, Date.now() - t0, opts?.onFail); settle(undefined); }
    finally { inFlight.delete(id); }
  })();
  return job;
}

export function jobFailed(name: string, key: string, e: unknown, ms: number, onFail?: (e: Error) => void): void {
  const error = e instanceof Error ? e : new Error(String(e ?? "job failed"));
  try {
    console.error(`[job ${name} ${key}]`, error.message);
    logEvent(db, APP, "job_error", { name, key, ms, error: error.message.slice(0, 300) }, null);
    if (onFail) tx(() => onFail(error));
  } catch (again) {
    console.error(`[job ${name} ${key}] could not be marked failed:`, again);
  }
}
