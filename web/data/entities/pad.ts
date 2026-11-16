// The notepad: one Markdown document for stray frictions, written whole over the rev it was based on.
import { mutate, type Op } from "../mutate.ts";
import { store as roomStore, useQuery, type Fetcher, type Store } from "../store.ts";
import { fetched } from "../api.ts";

export interface Pad { text: string; rev: number }
export const PAD_KEY = "dashboard-pad";
const padRead: Fetcher<Pad> = () => fetched<Pad>("/api/dashboard/pad", (v) => v.rev);
export const usePad = (): Pad | undefined => useQuery<Pad>(PAD_KEY, padRead, { tags: [PAD_KEY] });

const lines = (t: string): string[] => t.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());

/** Two tabs wrote at once: keep yours as it is and add their lines you don't have, so neither loses a line. */
export function mergePad(mine: string, theirs: string): string {
  if (mine === theirs || !theirs.trim()) return mine;
  const have = new Map<string, number>();
  for (const l of lines(mine)) have.set(l, (have.get(l) ?? 0) + 1);
  const extra = lines(theirs).filter((l) => { const n = have.get(l) ?? 0; if (n) have.set(l, n - 1); return !n; });
  if (!extra.length) return mine;
  return `${mine.replace(/\s+$/, "")}${mine.trim() ? "\n" : ""}${extra.join("\n")}\n`;
}

export const padOps = {
  /** The newest unsent text goes; a 409 sends yours merged with theirs, over their rev. */
  save(text: string, s: Store = roomStore): Op<Pad> {
    return {
      label: "save the notepad",
      lanes: [PAD_KEY],
      coalesce: PAD_KEY,
      method: "PUT",
      path: "/api/dashboard/pad",
      body: { text },
      base: () => s.entry<Pad>(PAD_KEY)?.base?.rev ?? 0,
      optimistic: [{ key: PAD_KEY, apply: (held: Pad | undefined) => ({ rev: 0, ...held, text }) }],
      takeConflict: { key: PAD_KEY, fold: (_held, c) => ({ text: String((c.value as { text?: unknown } | null)?.text ?? ""), rev: c.rev }) },
      onConflict: (c) => padOps.save(mergePad(text, String((c.value as { text?: unknown } | null)?.text ?? "")), s),
      confirm: (res, meta) => { s.apply(PAD_KEY, res.rev, res, "wire", { epoch: meta.epoch, stamp: meta.rev }); },
      flush: true,
    };
  },
};

export const pad = { save: (text: string) => mutate(padOps.save(text)) };
