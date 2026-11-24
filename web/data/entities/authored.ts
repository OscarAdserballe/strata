import type { BoardState } from "../../../shared/types/index.ts";
import { store as roomStore, type Store } from "../store.ts";
import { mutator as roomMutator, type Conflict, type Mutator, type Op, type SaveError } from "../mutate.ts";
import { outbox as roomOutbox, type Clash } from "../outbox.ts";
import { authoredKey, type AuthoredRow } from "./boards.ts";
import { upsertRow } from "./confirm.ts";

export const authoredLane = (mid: string): string => `authored:${mid}`;
const createLane = (board: string): string => `authored:new:${board}`;

export interface MintDraft {
  front: string;
  variant: string;
  pairId?: string | null;
  source?: string;
  meta?: Record<string, unknown>;
  opensAt?: number;
  back?: string;
  state?: "open" | "closed";
}
export interface AuthoredPatch {
  front?: string;
  back?: string;
  state?: "open" | "closed";
  meta?: Record<string, unknown>;
  opensAt?: number;
  source?: string;
}
export interface PersonalDraft { front: string; back: string; source: string; requestId: string }

const TEXT = ["front", "back"] as const;

/** FNV-1a over the draft's JSON, 8 hex chars. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
/** The draft's key plus its words: a second press replays the first card; edited words are a new request. */
export const createKey = (draftKey: string, draft: MintDraft): string => `${draftKey.slice(0, 64)}-${digest(JSON.stringify(draft))}`;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function rowOf(board: string, mid: string, s: Store = roomStore): AuthoredRow | undefined {
  return s.get<AuthoredRow[]>(authoredKey(board))?.find((m) => m.id === mid);
}

export const authoredOps = {
  /** `draftKey`: the draft's own, when it has one; otherwise the op mints a key (a probe, a tour card) */
  create(board: string, draft: MintDraft, draftKey?: string): Op<{ id: string; state: BoardState }> {
    return {
      label: "save your card",
      lanes: [createLane(board)],
      method: "POST",
      path: `/api/boards/${board}/minted`,
      body: draft,
      ...(draftKey ? { key: createKey(draftKey, draft) } : {}),
    };
  },

  update(board: string, mid: string, patch: AuthoredPatch, s: Store = roomStore, base?: number | null): Op<{ state: BoardState }> {
    const text = TEXT.some((k) => patch[k] !== undefined);
    const held = rowOf(board, mid, s);
    return {
      label: "save your card",
      lanes: [authoredLane(mid)],
      method: "PATCH",
      path: `/api/boards/${board}/minted/${mid}`,
      body: patch,
      // the text is a whole document: its base is the newest rev this room holds
      ...(text ? { base: () => base ?? finite(rowOf(board, mid, s)?.rev) } : {}),
      takeConflict: {
        key: authoredKey(board),
        // in the row's own order: the list's rev is the board read's, raised by every row taken
        rev: () => rowOf(board, mid, s)?.rev,
        fold: (list: AuthoredRow[], c: Conflict) => (c.value ? upsertRow(list, { ...(c.value as AuthoredRow), rev: c.rev }) : list),
      },
      onConflict: (c) => {
        // the row the list holds once it has taken the refusal; none when the list no longer has it
        const theirs = (c.value && rowOf(board, mid, s)) as AuthoredRow | undefined;
        if (!theirs || !held) return null;
        const untouched = TEXT.filter((k) => patch[k] !== undefined).every((k) => same(theirs[k], held[k]));
        return untouched ? authoredOps.update(board, mid, patch, s, theirs.rev) : null;
      },
    };
  },

  file(board: string, ids: string[], deck: string): Op<{ state: BoardState }> {
    return {
      label: "file your cards",
      lanes: ids.map(authoredLane),
      method: "POST",
      path: `/api/boards/${board}/minted/file`,
      body: { ids, deck },
    };
  },

  personal(draft: PersonalDraft): Op<{ id: string; mintId: string }> {
    return {
      label: "save the card to Unfiled",
      lanes: [authoredLane(`m-personal-${draft.requestId}`)],
      method: "POST",
      path: "/api/library/cards",
      body: draft,
      key: draft.requestId,
    };
  },
};

/** A card write as shelved offline: the update's base frozen at the click, so a replay can't land over a text it never saw. */
export type AuthoredAct =
  | { do: "create"; board: string; draft: MintDraft; draftKey?: string }
  | { do: "update"; board: string; mid: string; patch: AuthoredPatch; base: number | null }
  | { do: "personal"; draft: PersonalDraft };

const facesText = (v: { front?: unknown; back?: unknown } | null | undefined) => `${String(v?.front ?? "")}\n\n---\n\n${String(v?.back ?? "")}`;

export function authoredKind(s: Store) {
  return {
    build: (a: AuthoredAct): Op<any> => a.do === "create" ? authoredOps.create(a.board, a.draft, a.draftKey)
      : a.do === "update" ? authoredOps.update(a.board, a.mid, a.patch, s, a.base)
      : authoredOps.personal(a.draft),
    clash: (e: SaveError, a: AuthoredAct) => {
      if (a.do !== "update" || !e.conflict?.value) return null;
      const theirs = e.conflict.value as { front?: unknown; back?: unknown };
      const mine = { front: a.patch.front ?? theirs.front, back: a.patch.back ?? theirs.back };
      if (facesText(mine) === facesText(theirs)) return null;
      return { where: { board: a.board, source: null, passage: String(theirs.front ?? "") }, mine: facesText(mine), theirs: facesText(theirs), rev: Number(e.conflict.rev) || 0, args: a };
    },
    over: (c: Clash): AuthoredAct => ({ ...(c.args as Extract<AuthoredAct, { do: "update" }>), base: c.rev }),
    release: true,
  };
}
roomOutbox.kind<AuthoredAct>("authored", authoredKind(roomStore));

/** Ops that run out of retries release their lanes, so the next Save is not queued behind them; offline they wait on the device. */
export const authored = {
  create: (board: string, draft: MintDraft, opts: { draftKey?: string } = {}, m: Mutator = roomMutator) =>
    m === roomMutator && m.offline() ? roomOutbox.send<{ id: string; state: BoardState }>("authored", { do: "create", board, draft, draftKey: opts.draftKey } satisfies AuthoredAct)
      : m.release(authoredOps.create(board, draft, opts.draftKey)),
  update: (board: string, mid: string, patch: AuthoredPatch, m: Mutator = roomMutator, s: Store = roomStore) =>
    m === roomMutator && m.offline()
      ? roomOutbox.send<{ state: BoardState }>("authored", { do: "update", board, mid, patch, base: finite(rowOf(board, mid, s)?.rev) } satisfies AuthoredAct)
      : m.release(authoredOps.update(board, mid, patch, s)),
  file: (board: string, ids: string[], deck: string, m: Mutator = roomMutator) => m.release(authoredOps.file(board, ids, deck)),
  personal: (draft: PersonalDraft, m: Mutator = roomMutator) =>
    m === roomMutator && m.offline() ? roomOutbox.send<{ id: string; mintId: string }>("authored", { do: "personal", draft } satisfies AuthoredAct)
      : m.release(authoredOps.personal(draft)),
};
