// get_guide's topics from guide.md; primer and flashcards end in a receipt that set_primer and add_deck must send back.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAX_UPLOAD_BYTES } from "../../platform/config.ts";
import { AgentError } from "./kinds.ts";

export const RECEIPTED = ["primer", "flashcards"] as const;
type Receipted = (typeof RECEIPTED)[number];

const TOPICS = (() => {
  const raw = readFileSync(new URL("./guide.md", import.meta.url), "utf8").replace("{{MAX_MB}}", String(Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)));
  const topics = new Map<string, string>();
  for (const part of raw.split(/^## /m).slice(1)) topics.set(part.slice(0, part.indexOf("\n")).trim(), `## ${part.trim()}`);
  return topics;
})();
for (const t of RECEIPTED) if (!TOPICS.has(t)) throw new Error(`guide.md has no "${t}" topic`);

const RECEIPTS = new Map(RECEIPTED.map((t) => [t, `${t}-${createHash("sha256").update(TOPICS.get(t)!).digest("hex").slice(0, 4)}`]));
export const receiptOf = (topic: Receipted): string => RECEIPTS.get(topic)!;

/** Each topic's text as get_guide serves it, the receipted ones ending in their receipt line. */
export const GUIDE_PAGES = new Map([...TOPICS].map(([t, text]) => [t, RECEIPTS.has(t as Receipted) ? `${text}\n\nreceipt: ${RECEIPTS.get(t as Receipted)}` : text]));

export function checkReceipt(sent: unknown, topic: Receipted): void {
  if (sent !== receiptOf(topic)) throw new AgentError(`Read this first, then send guide: ${receiptOf(topic)}\n\n${GUIDE_PAGES.get(topic)}`);
}
