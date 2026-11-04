import { db } from "./db.ts";
import { transaction, type Synchronous } from "./transaction.ts";

export function tx<T>(fn: () => Synchronous<T>): T {
  return transaction(db, fn);
}
