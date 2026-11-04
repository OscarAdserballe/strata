import { db } from "../../platform/db/db.ts";
import { now } from "../../platform/db/sql.ts";

const list = db.prepare("SELECT idx, role, text FROM card_messages WHERE course = ? AND card = ? AND archived = 0 ORDER BY idx");
const at = db.prepare("SELECT role, text, archived FROM card_messages WHERE course = ? AND card = ? AND idx = ?");
const next = db.prepare("SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM card_messages WHERE course = ? AND card = ?");
const insert = db.prepare("INSERT INTO card_messages(course, card, idx, role, text, created_at) VALUES(?,?,?,?,?,?)");
const archive = db.prepare("UPDATE card_messages SET archived = 1 WHERE course = ? AND card = ? AND archived = 0");

export interface CardMessage { idx: number; role: string; text: string }

export const cardThread = (course: string, card: string): CardMessage[] => list.all(course, card) as unknown as CardMessage[];
export const cardMessageAt = (course: string, card: string, idx: number) =>
  at.get(course, card, idx) as { role: string; text: string; archived: number } | undefined;
export function addCardMessage(course: string, card: string, role: "user" | "assistant", text: string): number {
  const idx = (next.get(course, card) as { n: number }).n;
  insert.run(course, card, idx, role, text, now());
  return idx;
}
export const clearCardThread = (course: string, card: string): void => { archive.run(course, card); };
