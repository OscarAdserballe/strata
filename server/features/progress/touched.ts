import type { Touched } from "../../../shared/types/index.ts";
import { progressRepo as q } from "./repo.ts";

// Separate from boardState: these numbers move while a board is open, and the client re-asks just this.
export function touchedFor(id: string): Touched {
  const touched: Touched = {};
  for (const r of q.deckSeenOf.all(id)) (touched[r.slug] ??= { seen: 0, done: 0 }).seen += r.n;
  for (const r of q.deckDoneOf.all(id)) (touched[r.slug] ??= { seen: 0, done: 0 }).done += r.n;
  for (const r of q.deckLastOf.all(id) as { slug: string; card: string }[]) (touched[r.slug] ??= { seen: 0, done: 0 }).last = r.card;
  return touched;
}

export function seenFor(id: string): { seen: string[]; done: string[] } {
  return {
    seen: q.seenCardsOf.all(id).map((r) => r.id),
    done: q.doneCardsOf.all(id).map((r) => r.id),
  };
}
