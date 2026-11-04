// fn must be synchronous: if it awaited, other requests would write into this transaction.

import type { DatabaseSync } from "node:sqlite";

export type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

// savepoints may share a name: RELEASE and ROLLBACK TO act on the innermost one so named
const SAVEPOINT = "tx";

export function transaction<T>(database: DatabaseSync, fn: () => Synchronous<T>): T {
  const nested = database.isTransaction;
  database.exec(nested ? `SAVEPOINT ${SAVEPOINT}` : "BEGIN IMMEDIATE");
  try {
    const out: unknown = fn();
    if (out !== null && (typeof out === "object" || typeof out === "function") && typeof (out as PromiseLike<unknown>).then === "function") {
      // work after the first await runs outside this transaction; its rejection must not go unhandled
      (out as PromiseLike<unknown>).then(undefined, () => {});
      throw new Error("a transaction cannot await: do the awaiting first, then write in one synchronous block");
    }
    database.exec(nested ? `RELEASE ${SAVEPOINT}` : "COMMIT");
    return out as T;
  } catch (e) {
    // some failures end the transaction themselves; rolling back again would mask the real error
    if (database.isTransaction) database.exec(nested ? `ROLLBACK TO ${SAVEPOINT}; RELEASE ${SAVEPOINT}` : "ROLLBACK");
    throw e;
  }
}
