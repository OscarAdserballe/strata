import { facesOf } from "../../../shared/cards/faces.ts";
import { parseJson } from "../../platform/db/sql.ts";

export const DEFAULT_TOKENS = 6000;
export const MAX_TOKENS = 24000;
// The same heuristic the rest of Strata uses when no model count is at hand.
export const tokensOf = (s: string): number => Math.ceil(s.length / 4);

export const budgetOf = (asked: unknown): number => {
  const n = Number(asked);
  return Number.isFinite(n) && n >= 500 ? Math.min(Math.floor(n), MAX_TOKENS) : DEFAULT_TOKENS;
};

const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
const minute = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");
export const when = { day, minute };

/** Items cut to the budget: whole items only, and a cursor naming where the next part starts. */
export function paged(head: string, items: string[], cursor: unknown, budget: number, again: (cursor: string) => string, empty = "Nothing here yet."): string {
  if (!items.length) return `${head}\n\n${empty}`;
  const from = Math.max(0, Math.min(items.length, Number(/^o(\d+)$/.exec(String(cursor ?? ""))?.[1] ?? 0)));
  let used = tokensOf(head) + 40, to = from;
  while (to < items.length && (to === from || used + tokensOf(items[to]) <= budget)) used += tokensOf(items[to++]) + 1;
  const range = from === 0 && to === items.length ? `${items.length} in all` : `${from + 1}–${to} of ${items.length}`;
  const tail = to < items.length ? `more: ${again(`o${to}`)}` : "end";
  return `${head}\n${range} · ~${used} tokens\n\n${items.slice(from, to).join("\n")}\n\n— ${tail}`;
}

/** Long text cut to the budget at a paragraph, with a character cursor. */
export function pagedText(head: string, text: string, cursor: unknown, budget: number, again: (cursor: string) => string): string {
  const from = Math.max(0, Math.min(text.length, Number(/^c(\d+)$/.exec(String(cursor ?? ""))?.[1] ?? 0)));
  const room = Math.max(1000, (budget - tokensOf(head) - 40) * 4);
  let to = Math.min(text.length, from + room);
  if (to < text.length) { const cut = text.lastIndexOf("\n\n", to); if (cut > from + room / 2) to = cut; }
  const whole = from === 0 && to === text.length;
  const part = whole ? `~${tokensOf(text)} tokens` : `characters ${from}–${to} of ${text.length}`;
  const tail = to < text.length ? `more: ${again(`c${to}`)}` : "end";
  if (!head) return `${text.slice(from, to).trimEnd()}\n\n— ${whole ? "end" : `${part} · ${tail}`}`;
  return `${head}\n${part}\n\n${text.slice(from, to).trimEnd()}\n\n— ${tail}`;
}

export interface CardFaces { question: string; answer: string; type: string }
/** A card's question and answer faces, whatever its type. */
export function facesOfCard(type: string, payload: string): CardFaces {
  const p = parseJson<Record<string, unknown>>(payload, {});
  const faces = facesOf(type);
  const text = (k: string) => {
    const v = p[k];
    return Array.isArray(v) ? v.map((o, i) => `${String.fromCharCode(97 + i)}) ${String(o)}`).join("; ") : String(v ?? "").trim();
  };
  const question = text(faces[0].key);
  const answer = faces.slice(1).map((f) => text(f.key)).filter(Boolean).join(" · ");
  return { question, answer, type };
}

export const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export const indent = (s: string): string => s.split("\n").map((l) => `  ${l}`).join("\n");
