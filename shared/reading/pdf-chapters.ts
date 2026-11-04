export interface PdfSection {
  label: string;
  firstPage: number;
  lastPage: number;
  firstOffset?: number;
  lastOffset?: number;
}

interface PdfLine { text: string; offset: number }
export interface PdfPageText { text: string; lines: PdfLine[] }

export function extractPdfPage(items: { str?: string; hasEOL?: boolean }[]): PdfPageText {
  const lines: PdfLine[] = [];
  let text = "", line: string[] = [];
  const flush = () => {
    const value = line.join(" ").replace(/\s+/g, " ").trim();
    if (value) {
      if (text) text += " ";
      lines.push({ text: value, offset: text.length });
      text += value;
    }
    line = [];
  };
  for (const item of items) { line.push(item.str ?? ""); if (item.hasEOL) flush(); }
  flush();
  return { text, lines };
}

const chapter = /^(?:CHAPTER|Chapter)\s+(\d+|[IVXLCDM]+)\b[.:]?\s*(.*)$/;
export const isChapterLabel = (label: string): boolean => chapter.test(label);

function numberOf(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  return [...value].reduce((n, c, i) => n + (digits[c] < (digits[value[i + 1]] ?? 0) ? -digits[c] : digits[c]), 0);
}

/** A conservative fallback: numbered heading lines in sequence, never TOC entries. */
export function detectChapterSections(pages: PdfPageText[]): PdfSection[] {
  const chapters: { label: string; page: number; offset: number; number: number }[] = [];
  const extras: { label: string; page: number; offset: number }[] = [];
  for (const [p, page] of pages.entries()) {
    const headings = page.lines.flatMap((line, i) => {
      const match = chapter.exec(line.text);
      if (!match) return [];
      const title = match[2] || page.lines[i + 1]?.text || "";
      // Inline page numbers/dot leaders and multiple headings identify contents pages.
      if (!/^[\p{Lu}\d]/u.test(title) || title.length > 140 || /(?:\.{2,}|\s\d+$|[.!?]$)/.test(title)) return [];
      let offset = line.offset;
      const previous = page.lines[i - 1];
      if (previous && /^(?:Part|PART)\s+[IVXLCDM\d]+\b/.test(previous.text)) offset = previous.offset;
      return [{ label: `Chapter ${match[1]} ${title}`, page: p + 1, offset, number: numberOf(match[1]) }];
    });
    if (headings.length > 1 || /\bTABLE OF CONTENTS\b/i.test(page.text)) continue;
    if (headings.length === 1) {
      const heading = headings[0];
      const previous = chapters.at(-1);
      if (previous?.label === heading.label) continue; // repeated running header
      chapters.push(heading);
    }
    for (const line of page.lines) {
      if (/^(?:preface|introduction|index|bibliography|references)$/i.test(line.text)) {
        extras.push({ label: line.text, page: p + 1, offset: line.offset });
      }
    }
  }
  // Require a complete sequence, allowing a new book to restart at chapter one.
  if (chapters.length < 2 || chapters[0].number !== 1 || chapters.some((c, i) =>
    i > 0 && c.number !== chapters[i - 1].number + 1 && !(c.number === 1 && chapters[i - 1].number > 1))) return [];

  const starts = [...chapters, ...extras].sort((a, b) => a.page - b.page || a.offset - b.offset);
  if (starts[0].page > 1 || starts[0].offset > 0) starts.unshift({ label: "Front matter", page: 1, offset: 0 });
  return starts.map((start, i) => {
    const next = starts[i + 1];
    const lastPage = next ? (next.offset === 0 ? next.page - 1 : next.page) : pages.length;
    return {
      label: start.label, firstPage: start.page, firstOffset: start.offset, lastPage,
      lastOffset: next && next.offset > 0 ? next.offset : pages[lastPage - 1].text.length,
    };
  });
}

/** A page shared by two chapters cannot disambiguate a user's explicit deck selection. */
export function sectionAtPage<T extends PdfSection & { id: string }>(sections: T[], page: number, preferredId?: string): T | null {
  const matches = sections.filter((s) => page >= s.firstPage && (!s.lastPage || page <= s.lastPage));
  return matches.find((s) => s.id === preferredId) ?? matches.at(-1) ?? null;
}
