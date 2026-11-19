// Where the reader left each sheet, how big they made it, and which notes and questions they closed, kept on this
// device by the id of the item the sheet holds. A spot means nothing on another screen, so none of it is synced.

export interface SheetLayout { x?: number; y?: number; w?: number; h?: number; closed?: boolean }

const KEY = "strata.sheets", MOST = 600;
let held: Record<string, SheetLayout> | null = null;

function all(): Record<string, SheetLayout> {
  if (!held) {
    try { held = JSON.parse(globalThis.localStorage?.getItem(KEY) || "{}") as Record<string, SheetLayout>; } catch { held = {}; }
    if (!held || typeof held !== "object") held = {};
  }
  return held;
}
function save(): void {
  const m = all(), ids = Object.keys(m);
  // the oldest go first: a key is re-added at the end each time it changes
  for (const id of ids.slice(0, Math.max(0, ids.length - MOST))) delete m[id];
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(m)); } catch { /* private mode or a sandboxed page: this visit still remembers */ }
}

export const sheetMemory = {
  get: (id: string): SheetLayout | undefined => all()[id],
  set(id: string, patch: SheetLayout): void {
    const m = all(), next = { ...m[id], ...patch };
    for (const k of Object.keys(next) as (keyof SheetLayout)[]) if (next[k] === undefined) delete next[k];
    delete m[id];
    if (Object.keys(next).length) m[id] = next;
    save();
  },
  /** for tests */
  reset(): void { held = null; },
};
