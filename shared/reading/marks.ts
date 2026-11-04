// Must match the upload path's normalisation exactly; the round-trip test pins it down.
export function normalizePageText(strs: string[]): string {
  return strs.join(" ").replace(/\s+/g, " ").trim();
}

export interface PageTextItem { str?: unknown }

export interface PageIndex {
  text: string;
  loc(item: number, char: number): number;
}

// Collapsing whitespace moves characters, so the item-to-offset mapping is recorded as it is built.
export function pageIndex(items: readonly (PageTextItem | null | undefined)[] | null | undefined): PageIndex {
  const strs = (items || []).map((it) => String((it && it.str) != null ? (it as PageTextItem).str : ""));
  let text = "";
  const owners = strs.map((s) => new Int32Array(s.length + 1).fill(-1));
  let lastWasSpace = true;              // leading whitespace is dropped — same as .trim()
  for (let i = 0; i < strs.length; i++) {
    if (i > 0) {
      if (!lastWasSpace) { text += " "; lastWasSpace = true; }
    }
    const s = strs[i];
    for (let c = 0; c < s.length; c++) {
      const ws = /\s/.test(s[c]);
      if (ws) {
        owners[i][c] = text.length;     // points at wherever the collapsed run landed
        if (!lastWasSpace) { text += " "; lastWasSpace = true; }
      } else {
        owners[i][c] = text.length;
        text += s[c];
        lastWasSpace = false;
      }
    }
    owners[i][s.length] = text.length;
  }
  if (text.endsWith(" ")) text = text.slice(0, -1);
  const end = text.length;
  const clamp = (n: number) => Math.max(0, Math.min(end, n));
  return {
    text,
    loc(i: number, c: number) {
      if (i < 0 || i >= owners.length) return end;
      const row = owners[i];
      const at = Math.max(0, Math.min(row.length - 1, c | 0));
      // a collapsed character carries its run's offset; guard anyway rather than return -1
      return row[at] < 0 ? end : clamp(row[at]);
    },
  };
}

export interface QuoteRange { start: number; end: number }

// Try the hint, then the nearest exact match, then ignore spacing; a mark not found is not painted.
export function findQuote(text: string | null | undefined, quote: string | null | undefined, hint?: number | null): QuoteRange | null {
  const t = String(text || "");
  const q = String(quote || "");
  if (!q) return null;
  const at = Number.isFinite(hint) ? Math.max(0, Math.min(t.length, Math.floor(hint as number))) : 0;

  if (t.slice(at, at + q.length) === q) return { start: at, end: at + q.length };

  let best = -1;
  for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + 1)) {
    if (best < 0 || Math.abs(i - at) < Math.abs(best - at)) best = i;
  }
  if (best >= 0) return { start: best, end: best + q.length };

  /* Built as a regex over the live text so the returned offsets are real offsets into it. */
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loose = esc.trim().replace(/\s+/g, "\\s+");
  if (!loose) return null;
  let m: RegExpExecArray | null = null, bestM: RegExpExecArray | null = null;
  const re = new RegExp(loose, "g");
  while ((m = re.exec(t)) !== null) {
    if (!bestM || Math.abs(m.index - at) < Math.abs(bestM.index - at)) bestM = m;
    if (m.index === re.lastIndex) re.lastIndex++;      // zero-length guard
  }
  return bestM ? { start: bestM.index, end: bestM.index + bestM[0].length } : null;
}

export interface Box { left: number; top: number; width: number; height: number }

export type Fraction = number[];

// Page fractions survive raster scale, CSS zoom and resizes; boxes off the page are dropped, not clamped.
export function rectsToFractions(rects: Iterable<Box> | null | undefined, box: Box | null | undefined): Fraction[] {
  if (!box || !(box.width > 0) || !(box.height > 0)) return [];
  const out: Fraction[] = [];
  for (const r of rects || []) {
    const x = (r.left - box.left) / box.width;
    const y = (r.top - box.top) / box.height;
    const w = r.width / box.width;
    const h = r.height / box.height;
    if (!(w > 0) || !(h > 0)) continue;
    if (x < -0.02 || y < -0.02 || x + w > 1.02 || y + h > 1.02) continue;
    const cl = (v: number) => Math.min(1, Math.max(0, v));
    out.push([cl(x), cl(y), cl(w), cl(h)]);
  }
  return out;
}

// Merge rects that share a line so a highlight reads as one stroke and stays small to store.
export function mergeRects(fracs: Iterable<Fraction>): Fraction[] {
  const rows: Fraction[] = [];
  for (const [x, y, w, h] of fracs) {
    const row = rows.find((r) => Math.abs(r[1] - y) < h * 0.6 && Math.abs(r[3] - h) < h * 0.6);
    if (!row) { rows.push([x, y, w, h]); continue; }
    const left = Math.min(row[0], x), right = Math.max(row[0] + row[2], x + w);
    row[0] = left; row[2] = right - left;
    row[1] = Math.min(row[1], y);
    row[3] = Math.max(row[3], h);
  }
  return rows;
}
