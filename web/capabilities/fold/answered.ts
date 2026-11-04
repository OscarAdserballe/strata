// Which cards of a deck were answered in the reader, kept per viewer so a reload doesn't ask them again.
// The grade itself goes through the save path; this only remembers which folds can stay shut.

const KEY = (deck: string) => "strata.answered." + deck;
const held = new Map<string, Record<string, boolean>>();
function load(deck: string): Record<string, boolean> {
  let m = held.get(deck);
  if (!m) {
    try { m = JSON.parse(localStorage.getItem(KEY(deck)) || "{}") as Record<string, boolean>; } catch { m = {}; }
    held.set(deck, m);
  }
  return m;
}

export const answered = {
  of(deck: string | null | undefined, id: string): boolean | null {
    if (!deck) return null;
    const v = load(deck)[id];
    return v === undefined ? null : v;
  },
  set(deck: string | null | undefined, id: string, got: boolean): void {
    if (!deck) return;
    const m = load(deck);
    m[id] = got;
    try { localStorage.setItem(KEY(deck), JSON.stringify(m)); } catch { /* private mode: this visit still remembers */ }
  },
};
