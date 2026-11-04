// Normalise every maths delimiter form models use to $…$ and $$…$$.
export function texify(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/\\\[([\s\S]*?)\\\]/g, "$$$$$1$$$$")     // \[ … \] → $$ … $$; \( … \) → $…$ on one line, as the inline rule needs.
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, t: string) => `$${t.trim().replace(/\s*\n\s*/g, " ")}$`)
    // a bare align/equation/gather block is display maths that forgot to say so
    .replace(/(^|[^$])(\\begin\{(?:align|aligned|equation|gather|cases|matrix|bmatrix|pmatrix)\*?\}[\s\S]*?\\end\{(?:align|aligned|equation|gather|cases|matrix|bmatrix|pmatrix)\*?\})/g, "$1$$$$$2$$$$");
}

// Inline $…$ follows Pandoc's rule so currency like "$5 and $10" stays prose.
export type MathSpan = { start: number; end: number; tex: string; display: boolean };
export function mathSpans(s: string): MathSpan[] {
  const out: MathSpan[] = [];
  let i = 0;
  while ((i = s.indexOf("$", i)) !== -1) {
    if (s[i - 1] === "\\") { i++; continue; }
    if (s[i + 1] === "$") {
      const close = s.indexOf("$$", i + 2);
      if (close === -1) { i += 2; continue; }
      if (s.slice(i + 2, close).trim()) out.push({ start: i, end: close + 2, tex: s.slice(i + 2, close).trim(), display: true });
      i = close + 2; continue;
    }
    let close = -1;
    for (let j = i + 1; j < s.length && j <= i + 301 && s[j] !== "\n"; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === "$") { close = j; break; }
    }
    if (close === -1) { i++; continue; }
    const tex = s.slice(i + 1, close);
    const tight = /^\S/.test(tex) && /\S$/.test(tex) && !/\d/.test(s[close + 1] ?? "");
    if (tight || (/\\[A-Za-z]/.test(tex) && tex.trim())) {
      out.push({ start: i, end: close + 1, tex, display: false });
      i = close + 1;
    } else i = close;
  }
  return out;
}

// Un-escape literal "\n" only outside maths, where it starts \nabla, \neq, \nu.
export function unliteralize(v: unknown): string {
  const s = String(v == null ? "" : v);
  const prose = (t: string) => t.replace(/\\r\\n|\\n/g, "\n");
  let out = "", at = 0;
  for (const m of mathSpans(s)) { out += prose(s.slice(at, m.start)) + s.slice(m.start, m.end); at = m.end; }
  return out + prose(s.slice(at));
}

export const tex = (s: unknown): string => unliteralize(texify(s));

// Maths is swapped for private-use slots before markdown parsing, since _ * \ | are markdown syntax.
export const MATH_SLOT = /(\d+)/g;
export function shieldMath(s: string): { text: string; spans: MathSpan[] } {
  const spans = mathSpans(s);
  let text = "", at = 0;
  spans.forEach((m, k) => { text += s.slice(at, m.start) + `${k}`; at = m.end; });
  return { text: text + s.slice(at), spans };
}
export const unshieldMath = (s: string, src: string, spans: MathSpan[]): string =>
  s.replace(MATH_SLOT, (all, k) => (spans[k] ? src.slice(spans[k].start, spans[k].end) : all));
