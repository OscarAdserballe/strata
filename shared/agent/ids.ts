// The ids an agent sees: a prefix that says what a thing is, then the room's own id for it.

export const COLLECTIONS = ["log", "plan", "kept", "questions", "highlights", "comments", "sources", "chat"] as const;
export type Collection = (typeof COLLECTIONS)[number];

const PREFIXES = {
  src: "source", sec: "section", deck: "deck", card: "card", q: "question",
  hl: "highlight", cm: "comment", grp: "group", ms: "milestone", imp: "import",
} as const;
type Prefix = keyof typeof PREFIXES;
export type ItemKind = (typeof PREFIXES)[Prefix];

export type Ref =
  | { kind: "board"; board: string }
  | { kind: "collection"; board: string; name: Collection }
  | { kind: ItemKind; id: string };

const PREFIX_OF = Object.fromEntries(Object.entries(PREFIXES).map(([p, k]) => [k, p])) as Record<ItemKind, Prefix>;
export const idOf = (kind: ItemKind, id: string): string => `${PREFIX_OF[kind]}_${id}`;

// A handle has no underscore, so it can never be read as a prefixed id.
export const HANDLE = /^[a-z][a-z0-9-]{1,39}$/;
const BOARD = /^[a-zA-Z0-9-]{1,80}$/;

/** An id, a collection ("thesis/kept"), a board id or handle, or a pasted Strata link. */
export function parseRef(raw: string): Ref | null {
  const s = String(raw ?? "").trim();
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return null; }
    const board = u.searchParams.get("board"), resource = u.searchParams.get("resource");
    if (resource && /^[a-zA-Z0-9_-]+$/.test(resource)) return { kind: "source", id: resource };
    return board && BOARD.test(board) ? { kind: "board", board } : null;
  }
  const m = /^([a-z]+)_(.+)$/.exec(s);
  if (m && m[1] in PREFIXES && /^[A-Za-z0-9/_.-]{1,200}$/.test(m[2])) return { kind: PREFIXES[m[1] as Prefix], id: m[2] };
  const c = /^([a-zA-Z0-9-]{1,80})\/([a-z]+)$/.exec(s);
  if (c) return (COLLECTIONS as readonly string[]).includes(c[2]) ? { kind: "collection", board: c[1], name: c[2] as Collection } : null;
  return BOARD.test(s) ? { kind: "board", board: s } : null;
}
