// The layer switches in the reader's bar, and how many of each the open source holds.
// Module state, not a screen's: flipping one repaints the page's layers and the bar, never the room.

export type Layer = "notes" | "cards" | "ask";
export interface Switches { on: Readonly<Record<Layer, boolean>>; count: Readonly<Record<Layer, number>> }

const KEY = "strata.layers";
function read(): Record<Layer, boolean> {
  const all = { notes: true, cards: true, ask: true };
  try { return { ...all, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return all; }
}

let state: Switches = { on: read(), count: { notes: 0, cards: 0, ask: 0 } };
const heard = new Set<() => void>();
const tell = () => { for (const cb of [...heard]) cb(); };

export const switches = {
  subscribe(cb: () => void): () => void { heard.add(cb); return () => heard.delete(cb); },
  getSnapshot: (): Switches => state,
  on: (l: Layer): boolean => state.on[l],
  flip(l: Layer): void {
    state = { ...state, on: { ...state.on, [l]: !state.on[l] } };
    try { localStorage.setItem(KEY, JSON.stringify(state.on)); } catch { /* private mode: the switch still flips for this visit */ }
    tell();
  },
  count(l: Layer, n: number): void {
    if (state.count[l] === n) return;
    state = { ...state, count: { ...state.count, [l]: n } };
    tell();
  },
};
