// A source's delete waits behind an Undo before it is sent; leaving the page sends what is still waiting.
import { useSyncExternalStore } from "react";
import { mutator, type Mutator } from "../../data/mutate.ts";
import { toast } from "../../shell/layers.ts";

export const UNDO_MS = 8000;

interface Waiting { timer: ReturnType<typeof setTimeout>; send(): void }

export interface Deleting {
  /** the source's id, hidden from here on; send runs once, after UNDO_MS or as the page goes */
  soon(rid: string, name: string, send: () => void): void;
  undo(rid: string): boolean;
  has(rid: string): boolean;
  ids(): ReadonlySet<string>;
  subscribe(cb: () => void): () => void;
}

export function makeDeleting(m: Pick<Mutator, "onLeave"> = mutator, say: typeof toast = toast, wait = UNDO_MS): Deleting {
  const waiting = new Map<string, Waiting>();
  const heard = new Set<() => void>();
  let ids: ReadonlySet<string> = new Set();
  const tell = () => { ids = new Set(waiting.keys()); for (const cb of [...heard]) cb(); };
  const self: Deleting = {
    soon(rid, name, send) {
      if (waiting.has(rid)) return;
      const go = () => { const w = waiting.get(rid); if (!w) return; clearTimeout(w.timer); waiting.delete(rid); tell(); send(); };
      waiting.set(rid, { timer: setTimeout(go, wait), send: go });
      tell();
      say(`Deleted “${name}”`, wait, { label: "Undo", run: () => { if (self.undo(rid)) say(`“${name}” is back`); } });
    },
    undo(rid) {
      const w = waiting.get(rid);
      if (!w) return false;
      clearTimeout(w.timer);
      waiting.delete(rid);
      tell();
      return true;
    },
    has: (rid) => waiting.has(rid),
    ids: () => ids,
    subscribe(cb) { heard.add(cb); return () => { heard.delete(cb); }; },
  };
  // the save path flushes on pagehide right after its leavers run, so a delete started here goes with keepalive
  m.onLeave(() => { for (const w of [...waiting.values()]) w.send(); });
  return self;
}

export const deleting = makeDeleting();

const NONE: ReadonlySet<string> = new Set();
export const useDeleting = (): ReadonlySet<string> => useSyncExternalStore(deleting.subscribe, deleting.ids, () => NONE);

const n = (count: number, one: string, many = one + "s") => `${count} ${count === 1 ? one : many}`;

/** What the confirm says: what goes with the source, and that kept cards stay in Review. */
export function deleteAsk(marks = 0, kept = 0): string {
  return ["Delete this source?",
    marks ? `${n(marks, "highlight or note", "highlights and notes")} go${marks === 1 ? "es" : ""} with it.` : "",
    kept ? `${n(kept, "kept card")} stay${kept === 1 ? "s" : ""} in Review.` : ""].filter(Boolean).join(" ");
}
