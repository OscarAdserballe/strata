// Search the source text, not the DOM: most PDF pages are not drawn yet when you search.

export interface FindHit { page?: number; start: number; end: number }
export const FIND_CAP = 400;

export function findHits(q: string, from: { pages: readonly string[] } | { text: string }): FindHit[] {
  const needle = q.toLowerCase();
  const out: FindHit[] = [];
  if ("pages" in from) {
    const pages = from.pages;
    for (let p = 0; p < pages.length && out.length < FIND_CAP; p++) {
      const hay = pages[p].toLowerCase();
      for (let i = hay.indexOf(needle); i >= 0 && out.length < FIND_CAP; i = hay.indexOf(needle, i + 1)) {
        out.push({ page: p + 1, start: i, end: i + needle.length });
      }
    }
  } else {
    const hay = (from.text || "").toLowerCase();
    for (let i = hay.indexOf(needle); i >= 0 && out.length < FIND_CAP; i = hay.indexOf(needle, i + 1)) {
      out.push({ start: i, end: i + needle.length });
    }
  }
  return out;
}
