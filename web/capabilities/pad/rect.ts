// Where the floating notepad sits and how big it is, kept per device.
export type Rect = { x: number; y: number; w: number; h: number };

export const MIN_W = 260, MIN_H = 160;
const DEF_W = 380, DEF_H = 360, EDGE = 14, FOOT = 64;
const KEY = "strata.pad.rect";

/** Bottom right, clear of the save chip and a floating Ask dock. */
export function cornerRect(vw: number, vh: number): Rect {
  const w = Math.min(DEF_W, vw - 2 * EDGE), h = Math.min(DEF_H, vh - FOOT - EDGE);
  return clampRect({ x: vw - w - EDGE, y: vh - h - FOOT, w, h }, vw, vh);
}

/** Never smaller than the minimum (unless the window is), never past an edge. */
export function clampRect(r: Rect, vw: number, vh: number): Rect {
  const w = Math.round(Math.max(Math.min(MIN_W, vw), Math.min(r.w, vw)));
  const h = Math.round(Math.max(Math.min(MIN_H, vh), Math.min(r.h, vh)));
  const x = Math.round(Math.max(0, Math.min(r.x, vw - w)));
  const y = Math.round(Math.max(0, Math.min(r.y, vh - h)));
  return { x, y, w, h };
}

export function readRect(raw: string | null): Rect | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<Rect>;
    return [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n)) ? (r as Rect) : null;
  } catch { return null; }
}

export function loadRect(): Rect | null {
  try { return readRect(localStorage.getItem(KEY)); } catch { return null; }
}

export function saveRect(r: Rect | null): void {
  try { if (r) localStorage.setItem(KEY, JSON.stringify(r)); else localStorage.removeItem(KEY); } catch {}
}
