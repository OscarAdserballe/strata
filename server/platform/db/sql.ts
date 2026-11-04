import { randomUUID } from "node:crypto";
import type { SQLInputValue, StatementResultingChanges } from "node:sqlite";
import { db } from "./db.ts";
import { syncActivity } from "../projections.ts";

export interface Stmt<Row = never> {
  get(...args: SQLInputValue[]): Row | undefined;
  all(...args: SQLInputValue[]): Row[];
  run(...args: SQLInputValue[]): StatementResultingChanges;
}
export const stmt = <Row = never>(sql: string): Stmt<Row> => db.prepare(sql) as unknown as Stmt<Row>;
export const activity = <Row,>(sql: string): Stmt<Row> => {
  const query = stmt<Row>(sql);
  return { get: (...args) => { syncActivity(db); return query.get(...args); },
    all: (...args) => { syncActivity(db); return query.all(...args); }, run: (...args) => query.run(...args) };
};

export const now = (): number => Date.now();
export const genId = (p = ""): string => p + randomUUID().replace(/-/g, "").slice(0, 8);
export const parseJson = <T,>(s: string | null, fb: T): T => { if (!s) return fb; try { return JSON.parse(s) as T; } catch { return fb; } };
export const slugify = (v: unknown): string => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);

// roomRev is read on every API answer, so it is prepared once.
const roomRevStmt = stmt<{ rev: number }>("SELECT rev FROM room_rev WHERE id = 1");

export const roomRev = (): number => roomRevStmt.get()?.rev ?? 0;
