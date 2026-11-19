// The guide's topics, and the receipt a write that follows one must carry to show it was read.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAX_UPLOAD_BYTES } from "../../platform/config.ts";

const RAW = (() => {
  const raw = readFileSync(new URL("./guide.md", import.meta.url), "utf8").replace("{{MAX_MB}}", String(Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)));
  const topics = new Map<string, string>();
  for (const part of raw.split(/^## /m).slice(1)) topics.set(part.slice(0, part.indexOf("\n")).trim(), `## ${part.trim()}`);
  return topics;
})();

/** The topics whose ops refuse to write without their receipt. */
export const GUIDED = { primer: "set_primer", flashcards: "add_deck" } as const;
export type GuidedTopic = keyof typeof GUIDED;

const RECEIPTS = new Map(Object.keys(GUIDED).map((t) => {
  const body = RAW.get(t);
  if (!body) throw new Error(`guide.md has no "${t}" topic`);
  return [t, `${t}-${createHash("sha256").update(body).digest("hex").slice(0, 8)}`];
}));

export const receiptOf = (topic: GuidedTopic): string => RECEIPTS.get(topic)!;
const ending = (topic: GuidedTopic): string => `\n\nReceipt: ${receiptOf(topic)}. Send it as \`guide\` on \`${GUIDED[topic]}\`; it changes whenever this guide does.`;

/** The guide's topics as an agent reads them: placeholders filled, and each guided topic ending with its receipt. */
export function guideTopics(fill: (body: string) => string): Map<string, string> {
  return new Map([...RAW].map(([t, body]) => [t, t in GUIDED ? body + ending(t as GuidedTopic) : fill(body)]));
}

/** Refuses a guided write without the current receipt, and hands back the guide so the next try can follow it. */
export function needReceipt(topic: GuidedTopic, sent: unknown): string | null {
  if (sent === receiptOf(topic)) return null;
  const why = sent === undefined || sent === null || sent === "" ? `${GUIDED[topic]} needs the receipt from get_guide({ topic: "${topic}" }) as guide.` : `"${String(sent)}" is not the current receipt for the ${topic} guide; it has changed since.`;
  return `${why} Read this first and follow it, then send guide: "${receiptOf(topic)}".\n\n${RAW.get(topic)}${ending(topic)}`;
}
