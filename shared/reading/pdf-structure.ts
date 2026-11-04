import { extractPdfPage, detectChapterSections, type PdfPageText } from "./pdf-chapters.ts";
import { batchSections } from "./sections.ts";
import type { ImportHeading } from "../imports/import-plan.ts";

export interface PdfStructure {
  sections: { label: string; firstPage: number; lastPage: number }[];
  pageText: string[];
  outline: ImportHeading[];
  defaultStarts: number[];
}
interface PdfBookmark { title?: string; dest: unknown; items?: PdfBookmark[] }
export interface PdfDocLike {
  numPages: number;
  getOutline(): Promise<PdfBookmark[] | null>;
  getDestination(name: string): Promise<unknown>;
  getPageIndex(ref: unknown): Promise<number>;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: ({ str?: string; transform?: number[]; hasEOL?: boolean } | { type: string })[] }> }>;
}

export async function extractPdfStructure(bytes: Uint8Array, minimum: number, runtime: { getDocument(o: { data: Uint8Array }): { promise: Promise<PdfDocLike>; destroy(): Promise<void> } }, progress?: (page: number, total: number) => void): Promise<PdfStructure> {
  const task = runtime.getDocument({ data: bytes });
  try {
    const doc = await task.promise;
    const pageText: string[] = [];
    const pages: PdfPageText[] = [];
    const positions: { offset: number; y: number }[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      progress?.(n, doc.numPages);
      try {
        const content = await (await doc.getPage(n)).getTextContent();
        let text = "";
        const runs: { offset: number; y: number }[] = [];
        const items = content.items.filter((item): item is { str: string; transform?: number[]; hasEOL?: boolean } => "str" in item);
        for (const item of items) {
          const word = (item.str ?? "").replace(/\s+/g, " ").trim();
          if (!word) continue;
          if (text) text += " ";
          if (item.transform) runs.push({offset:text.length,y:item.transform[5]});
          text += word;
        }
        pages.push(extractPdfPage(items));
        pageText.push(text); positions.push(runs);
      } catch (error) { throw new Error(`Could not read PDF page ${n}: ${(error as Error).message}`); }
    }
    const bookmarks = await doc.getOutline();
    const pointOf = async (item: PdfBookmark): Promise<{page:number;offset:number} | null> => {
      try {
        const d = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
        if (Array.isArray(d) && d[0] !== null && d[0] !== undefined) {
          const page = (typeof d[0] === "number" ? d[0] : await doc.getPageIndex(d[0])) + 1;
          if (page >= 1 && page <= doc.numPages) {
            const mode = d[1]?.name;
            const y = mode === "XYZ" ? d[3] : mode === "FitH" || mode === "FitBH" ? d[2] : null;
            const offset = typeof y === "number" && positions[page-1].length
              ? (positions[page-1].find(run => run.y <= y + 2)?.offset ?? pageText[page-1].length) : 0;
            return {page,offset};
          }
        }
      } catch { /* an outline container can still inherit its first child's destination */ }
      for (const child of item.items ?? []) { const point = await pointOf(child); if (point) return point; }
      return null;
    };
    const outline: ImportHeading[] = [];
    const walk = async (items: PdfBookmark[], depth = 0, parent: number | null = null): Promise<void> => {
      for (const item of items) {
        const point = await pointOf(item);
        const label = String(item.title ?? "").replace(/\s+/g," ").replace(/``/g,"“").replace(/''/g,"”").trim().slice(0,300);
        if (!point || !label) { await walk(item.items ?? [],depth,parent); continue; }
        const prior = outline.at(-1);
        // Out-of-order navigation links aren't forward content boundaries.
        if (prior && (point.page < prior.page || (point.page === prior.page && point.offset < prior.offset))) continue;
        const id = outline.length;
        outline.push({id,label,...point,depth,parent});
        await walk(item.items ?? [],depth+1,id);
      }
    };
    await walk(bookmarks ?? []);
    if (outline.length < 2) {
      const detected = detectChapterSections(pages);
      if (detected.length) {
        const headings = detected.map((s, id) => ({ id, label: s.label, page: s.firstPage, offset: s.firstOffset ?? 0, depth: 0, parent: null }));
        return { sections: detected, pageText, outline: headings, defaultStarts: headings.slice(1).map(row => row.id) };
      }
    }
    const top = outline.filter(row => row.depth === 0);
    const sections = top.map((row,i) => ({label:row.label,firstPage:row.page,lastPage:i+1<top.length ? Math.max(row.page,top[i+1].page-1) : doc.numPages}));
    const grouped = batchSections(sections,pageText,minimum);
    const defaultStarts = grouped.slice(1).map(group => top.find(row => row.page === group.firstPage)!.id);
    return {sections,pageText,outline,defaultStarts};
  } finally { try { await task.destroy(); } catch { /* failed load */ } }
};

