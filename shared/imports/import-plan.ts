export interface Heading { id: number; label: string; page: number | null; depth: number; parent: number | null }
export interface Example { key: string; title: string; subtitle: string; board: string; short: string; pages: number; words: number; defaultStarts: number[]; outline: Heading[] }

export function subtree(outline: Heading[], index: number): Heading[] {
  const end = outline.findIndex((row, i) => i > index && row.depth <= outline[index].depth);
  return outline.slice(index, end < 0 ? outline.length : end);
}

export function units(outline: Heading[], starts: number[], excluded: Set<number>) {
  const boundaries = [0, ...new Set(starts.filter(n => n > 0 && n < outline.length))].sort((a, b) => a - b);
  return boundaries.map((start, i) => ({
    start,
    rows: outline.slice(start, boundaries[i + 1] ?? outline.length).filter(row => !excluded.has(row.id)),
  })).filter(unit => unit.rows.length);
}

export function unitTitle(rows: Heading[]): string {
  const depth = Math.min(...rows.map(row => row.depth));
  const main = rows.filter(row => row.depth === depth);
  return main.length > 1 ? `${main[0].label} → ${main.at(-1)!.label}` : main[0].label;
}

export interface ImportHeading extends Heading { page: number; offset: number }
export interface ImportPlan { outline: ImportHeading[]; starts: number[]; excluded: number[] }
export interface ContentRange { page: number; start: number; end: number }
export interface StudyUnit { label: string; firstPage: number; lastPage: number; ranges: ContentRange[] }

/** Validate before any resource is written; ranges are derived, never accepted from the wire. */
export function compileImportPlan(input: unknown, pages: string[]): StudyUnit[] {
  const fail = (): never => { throw new Error("The source grouping is invalid. Please add the file again."); };
  if (!input || typeof input !== "object" || !pages.length) return fail();
  const { outline, starts, excluded } = input as ImportPlan;
  if (!Array.isArray(outline) || !outline.length || outline.length > 10000 || !Array.isArray(starts) || !Array.isArray(excluded)) return fail();
  const ancestors: number[] = [];
  for (const [i, row] of outline.entries()) {
    if (!row || row.id !== i || typeof row.label !== "string" || !row.label.trim() || row.label.length > 300 ||
        !Number.isInteger(row.page) || row.page < 1 || row.page > pages.length ||
        !Number.isInteger(row.offset) || row.offset < 0 || row.offset > pages[row.page-1].length ||
        !Number.isInteger(row.depth) || row.depth < 0 || row.depth > ancestors.length ||
        row.parent !== (row.depth ? ancestors[row.depth-1] : null)) return fail();
    const prior = outline[i-1];
    if (prior && (row.page < prior.page || (row.page === prior.page && row.offset < prior.offset))) return fail();
    ancestors.length = row.depth; ancestors.push(i);
  }
  for (const list of [starts, excluded]) {
    if (list.length > outline.length || new Set(list).size !== list.length || list.some(n => !Number.isInteger(n) || n < 0 || n >= outline.length)) return fail();
  }
  if (starts.includes(0)) return fail();
  const omitted = new Set(excluded);
  const groups = units(outline, starts, omitted);
  if (!groups.length) throw new Error("Include at least one section to study.");
  const span = (from: {page:number;offset:number}, to: {page:number;offset:number}): ContentRange[] => {
    const result: ContentRange[] = [];
    for (let page=from.page; page<=to.page; page++) {
      const start = page === from.page ? from.offset : 0;
      const end = page === to.page ? to.offset : pages[page-1].length;
      if (end > start) result.push({page,start,end});
    }
    return result;
  };
  const end = {page:pages.length,offset:pages.at(-1)!.length};
  return groups.map((group,index) => {
    // Abstract/title pages before the first bookmark stay with the first selected unit.
    const ranges = index === 0 ? span({page:1,offset:0},outline[0]) : [];
    for (const row of group.rows) ranges.push(...span(outline[row.id],outline[row.id+1] ?? end));
    const merged: ContentRange[] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && last.page === range.page && last.end === range.start) last.end = range.end;
      else merged.push({...range});
    }
    if (!merged.some(r => pages[r.page-1].slice(r.start,r.end).trim())) throw new Error("A selected group has no readable text. Join it with the next group.");
    return {label:unitTitle(group.rows).slice(0,200),firstPage:merged[0].page,lastPage:merged.at(-1)!.page,ranges:merged};
  });
}

export function rangeText(ranges: ContentRange[], pages: string[]): string {
  return ranges.map(r => `[page ${r.page}]\n${pages[r.page-1].slice(r.start,r.end)}`).join("\n\n");
}
