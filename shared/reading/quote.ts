// Where a highlight's words sit in a text: whitespace and case fold away, so a quote taken from a live page lands on its twin and back.

function fold(text: string): { s: string; map: number[] } {
  let s = ""; const map: number[] = []; let space = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) { if (!space) { s += " "; map.push(i); space = true; } continue; }
    s += c.toLowerCase(); map.push(i); space = false;
  }
  return { s, map };
}

/** The occurrence of quote nearest offset near, or null when it is too short to trust or not there. */
export function findQuote(text: string, quote: string, near = 0): [number, number] | null {
  const q = fold(quote).s.trim();
  if (q.length < 3) return null;
  const f = fold(text);
  let best = -1;
  for (let i = f.s.indexOf(q); i >= 0; i = f.s.indexOf(q, i + 1)) {
    if (best < 0 || Math.abs(f.map[i] - near) < Math.abs(f.map[best] - near)) best = i;
  }
  return best < 0 ? null : [f.map[best], f.map[best + q.length - 1] + 1];
}

/** Marks placed on text by their words: kept where their offsets still read their quote, moved where they don't, dropped when gone. */
export function placeByQuote<M extends { start: number; end: number; quote: string }>(text: string, marks: readonly M[]): M[] {
  const out: M[] = [];
  for (const m of marks) {
    if (text.slice(m.start, m.end) === m.quote) { out.push(m); continue; }
    const at = findQuote(text, m.quote, m.start);
    if (at) out.push({ ...m, start: at[0], end: at[1] });
  }
  return out;
}
