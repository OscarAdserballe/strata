/* Explicit chapters stay separate; other outline entries are batched into study units. */
import { isChapterLabel } from "./pdf-chapters.ts";

export interface SectionSpan { label: string; firstPage: number; lastPage: number }

export const MIN_SECTION_WORDS = 20_000;
const SCANNED_PAGE_WORDS = 500;

const words = (s: string): number => s.match(/\S+/g)?.length ?? 0;

function labelOf(parts: SectionSpan[]): string {
  if (parts.length === 1) return parts[0].label;
  return `${parts[0].label} – ${parts.at(-1)!.label}`.slice(0, 200);
}

/** Merge adjacent non-chapter sections until each split has `minimum` words; [] keeps one section. */
export function batchSections(
  sections: SectionSpan[],
  pageText: string[] | undefined,
  minimum = MIN_SECTION_WORDS,
): SectionSpan[] {
  if (sections.length < 2) return [];
  if (sections.some(s => isChapterLabel(s.label))) return sections;

  const maxPage = Math.max(pageText?.length ?? 0, ...sections.map((s) => s.lastPage || s.firstPage));
  const extracted = (pageText ?? []).map(words);
  const readablePages = extracted.filter(Boolean).length;
  // Use the page fallback only when extraction failed on almost the whole document; sparse pages stay sparse.
  const scan = !pageText?.length || readablePages < Math.max(1, Math.ceil(pageText.length / 5));
  const pageWords = Array.from({ length: maxPage }, (_x, i) => scan ? SCANNED_PAGE_WORDS : (extracted[i] ?? 0));
  const weight = (s: SectionSpan): number => {
    const last = s.lastPage || maxPage;
    let total = 0;
    for (let p = Math.max(1, s.firstPage); p <= Math.min(last, maxPage); p++) total += pageWords[p - 1] ?? 0;
    return total;
  };

  // Two sections below the floor cannot exist until there are two floors' worth of source.
  if (sections.reduce((n, s) => n + weight(s), 0) < minimum * 2) return [];

  const groups: SectionSpan[][] = [];
  let open: SectionSpan[] = [];
  let openWords = 0;
  for (const section of sections) {
    open.push(section);
    openWords += weight(section);
    if (openWords >= minimum) { groups.push(open); open = []; openWords = 0; }
  }
  if (open.length) {
    if (groups.length) groups.at(-1)!.push(...open); // an undersized tail folds backward
    else groups.push(open);
  }
  if (groups.length < 2) return [];

  return groups.map((parts) => ({
    label: labelOf(parts),
    firstPage: parts[0].firstPage,
    lastPage: parts.at(-1)!.lastPage,
  }));
}
