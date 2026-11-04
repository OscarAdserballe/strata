// The cards turned over in the reader and not yet graded, per deck. Each card's sheet keeps its own side up,
// so turning one doesn't turn another back; a grade takes it off. Kept for this visit only.

const held = new Map<string, Set<string>>();
let version = 0;
const heard = new Set<() => void>();
const tell = () => { version++; for (const cb of [...heard]) cb(); };

export const turned = {
  subscribe(cb: () => void): () => void { heard.add(cb); return () => heard.delete(cb); },
  getSnapshot: (): number => version,
  has: (deck: string | null | undefined, id: string): boolean => !!deck && !!held.get(deck)?.has(id),
  add(deck: string | null | undefined, id: string): void {
    if (!deck || held.get(deck)?.has(id)) return;
    let s = held.get(deck);
    if (!s) held.set(deck, s = new Set());
    s.add(id);
    tell();
  },
  drop(deck: string | null | undefined, id: string): void {
    if (deck && held.get(deck)?.delete(id)) tell();
  },
};
