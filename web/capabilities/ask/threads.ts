import type { Here } from "../../shell/here.ts";
import type { AskThread } from "../../surfaces.ts";
// a card key splits at its first slash: card ids contain slashes, deck slugs never do

export type ThreadKey = string;
export type ParsedThread =
  | { kind: "library" }
  | { kind: "board"; board: string; source: string | null }
  | { kind: "card"; deck: string; card: string };

export const LIBRARY_BOARD = "inbox";

export function parseThread(key: ThreadKey | null | undefined): ParsedThread | null {
  if (!key) return null;
  if (key === "library") return { kind: "library" };
  let m = /^board:([^/]+)(?:\/source:(.+))?$/.exec(key);
  if (m) return { kind: "board", board: m[1], source: m[2] ?? null };
  m = /^card:([^/]+)\/(.+)$/.exec(key);
  if (m) return { kind: "card", deck: m[1], card: m[2] };
  return null;
}

export function cardThreadKey(course: string | null | undefined, id: string | null | undefined): ThreadKey | null {
  return course && id && !course.includes("/") ? `card:${course}/${id}` : null;
}

export function threadFor(kind: AskThread, h: Here): ThreadKey | null {
  if (kind === "library") return "library";
  if (kind === "card") return h.card ? cardThreadKey(h.card.course ?? h.card.deck, h.card.id) : null;
  if (!h.board) return null;
  return (kind === "source" || kind === "words") && h.source ? `board:${h.board}/source:${h.source}` : `board:${h.board}`;
}

export function storeKeyOf(key: ThreadKey | null): string {
  const p = parseThread(key);
  if (!p) return "";
  if (p.kind === "library") return `thread:${LIBRARY_BOARD}/`;
  if (p.kind === "board") return `thread:${p.board}/${p.source ?? ""}`;
  return `thread:card:${p.deck}/${p.card}`;
}
