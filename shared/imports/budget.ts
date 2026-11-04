import { rangeText, type StudyUnit, type ImportHeading } from "./import-plan.ts";

export function sourceTokens(source: { tokens?: number | null; text?: string | null; bytes?: number; pages?: string[] }): number {
  if (source.tokens && source.tokens > 0) return source.tokens;
  return Math.ceil(Math.max((source.text?.length ?? 0) / 4,
    (source.pages ?? []).reduce((n, page) => n + page.length, 0) / 4, (source.bytes ?? 0) / 27));
}

export function studyTokens(unit: StudyUnit, pages: string[]): number {
  return Math.ceil((unit.label.length + rangeText(unit.ranges, pages).length + 200) / 4);
}

// Page boundaries are an explicit fallback when bookmarks cannot yield small enough units.
export function pageGroups(pages: string[], budget: number): { outline: ImportHeading[]; defaultStarts: number[] } {
  const outline = pages.map((_page, id) => ({ id, label: `Page ${id + 1}`, page: id + 1, offset: 0, depth: 0, parent: null }));
  const defaultStarts: number[] = [];
  let size = 0;
  for (const [i, page] of pages.entries()) {
    const tokens = Math.ceil((page.length + 30) / 4);
    if (i && size + tokens > budget * 0.8) { defaultStarts.push(i); size = 0; }
    size += tokens;
  }
  return { outline, defaultStarts };
}
