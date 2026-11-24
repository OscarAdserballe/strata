// The guide's topics as agents read them: the shipped text, or the reader's own where they wrote one, and the receipt a guided write must carry.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAX_UPLOAD_BYTES } from "../../platform/config.ts";
import { now } from "../../platform/db/sql.ts";
import { agentRepo as a, type PromptRow } from "./repo.ts";

const SHIPPED = (() => {
  const raw = readFileSync(new URL("./guide.md", import.meta.url), "utf8").replace("{{MAX_MB}}", String(Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)));
  const topics = new Map<string, string>();
  for (const part of raw.split(/^## /m).slice(1)) topics.set(part.slice(0, part.indexOf("\n")).trim(), `## ${part.trim()}`);
  return topics;
})();
export const TOPICS = [...SHIPPED.keys()];

/** The topics whose ops refuse to write without their receipt. */
export const GUIDED = { primer: "set_primer", flashcards: "add_deck" } as const;
export type GuidedTopic = keyof typeof GUIDED;
for (const t of Object.keys(GUIDED)) if (!SHIPPED.has(t)) throw new Error(`guide.md has no "${t}" topic`);

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 8);
const own = (topic: string): PromptRow | null => { const r = a.prompt.get(topic); return r && r.text !== null ? r : null; };
/** What an agent reads for a topic before placeholders are filled: the reader's text if they wrote one. */
const bodyOf = (topic: string): string => own(topic)?.text ?? SHIPPED.get(topic)!;

export const receiptOf = (topic: GuidedTopic): string => `${topic}-${hash(bodyOf(topic))}`;
const ending = (topic: GuidedTopic): string => `\n\nReceipt: ${receiptOf(topic)}. Send it as \`guide\` on \`${GUIDED[topic]}\`; it changes whenever this guide does.`;

/** One topic as an agent reads it: placeholders filled, and a guided topic ending with its receipt; null for no such topic. */
export function guideTopic(topic: string, fill: (body: string) => string): string | null {
  if (!SHIPPED.has(topic)) return null;
  return topic in GUIDED ? bodyOf(topic) + ending(topic as GuidedTopic) : fill(bodyOf(topic));
}

/** Refuses a guided write without the current receipt, and hands back the guide so the next try can follow it. */
export function needReceipt(topic: GuidedTopic, sent: unknown): string | null {
  if (sent === receiptOf(topic)) return null;
  const why = sent === undefined || sent === null || sent === "" ? `${GUIDED[topic]} needs the receipt from get_guide({ topic: "${topic}" }) as guide.` : `"${String(sent)}" is not the current receipt for the ${topic} guide; it has changed since.`;
  return `${why} Read this first and follow it, then send guide: "${receiptOf(topic)}".\n\n${bodyOf(topic)}${ending(topic)}`;
}

// ---------- the reader's own text ----------

export const PROMPT_MAX = 40_000;
export interface PromptView { topic: string; text: string; shipped: string; own: boolean; rev: number; updatedAt: number | null; shippedChanged: boolean }
export class PromptError extends Error {}

function view(topic: string, r: PromptRow | undefined): PromptView {
  const shipped = SHIPPED.get(topic)!, mine = r && r.text !== null ? r : null;
  return { topic, text: mine?.text ?? shipped, shipped, own: !!mine, rev: r?.rev ?? 0, updatedAt: mine?.updated_at ?? null, shippedChanged: !!mine && mine.base !== hash(shipped) };
}

/** Every topic, in the guide's order, as the drawer edits it. */
export function promptsView(): { topics: PromptView[] } {
  const rows = new Map(a.prompts.all().map((r) => [r.topic, r]));
  return { topics: TOPICS.map((t) => view(t, rows.get(t))) };
}
export const promptView = (topic: string): PromptView => view(topic, a.prompt.get(topic));

/** Writes a topic whole; null, or the shipped text itself, puts the shipped guide back. */
export function writePrompt(topic: string, text: unknown): PromptView {
  if (!SHIPPED.has(topic)) throw new PromptError(`No guide topic "${topic}". Topics: ${TOPICS.join(", ")}.`);
  if (text !== null && typeof text !== "string") throw new PromptError("text is the topic's whole text, or null for the shipped guide.");
  // refused rather than cut: a cut prompt would lose its tail without saying so
  if (typeof text === "string" && text.length > PROMPT_MAX) throw new PromptError(`text is at most ${PROMPT_MAX} characters.`);
  const shipped = SHIPPED.get(topic)!;
  const mine = typeof text === "string" && text.trim() && text.trim() !== shipped.trim() ? text : null;
  a.putPrompt.run(topic, mine, hash(shipped), now());
  return promptView(topic);
}

/** The topics in the reader's own text right now, kept with a posted page so its ⓘ says what the run was told. */
export const toldNow = (): { topic: string; at: number }[] =>
  a.prompts.all().filter((r) => r.text !== null).map((r) => ({ topic: r.topic, at: r.updated_at }));
