import { BUDGET_TEXT_CHARS } from "../../platform/config.ts";
import { SECTION_TO_END } from "../../platform/db/schema.ts";
import { q } from "../repo.ts";
import type { SectionRow, ResourceRow } from "../../platform/db/rows.ts";
import { sectionsCount, sectionSource, sourceOfResource } from "../sources/blobs.ts";
import { cardLine, placeLine } from "./prompts.ts";

export function sourceForTurn(boardId: string, sectionId?: string | null, focusId?: string | null): { files: { mimeType: string; data: string }[]; sources: string } {
  const none = { files: [], sources: "" };
  const s = sectionId ? (q.section.get(sectionId) as SectionRow | undefined) : undefined;
  // A section id from another board must not be read.
  if (sectionId && (!s || s.board_id !== boardId)) return none;
  const rid = s ? s.resource_id : focusId;
  if (!rid) return none;
  const r = q.resource.get(boardId, rid) as ResourceRow | undefined;
  if (!r || r.included === 0) return none;

  const total = sectionsCount(rid);
  const cut = s ? sectionSource(r, s, total) : sourceOfResource(r);
  if (cut.file) return { files: [cut.file], sources: "" };
  const t = cut.text ?? "";
  if (!t.trim()) return none;
  const clipped = t.length > BUDGET_TEXT_CHARS ? t.slice(0, BUDGET_TEXT_CHARS) + "\n…(truncated — over the context budget)" : t;
  const what = s && (total > 1 || s.content_ranges) ? `THE SECTION THEY HAVE OPEN` : `THE SOURCE THEY HAVE OPEN`;
  return { files: [], sources: `${what} (this is all you have been given of it):\n\n=== ${r.filename ?? "resource"} ===\n${clipped}` };
}

export interface Here { surface?: string | null; sectionId?: string | null; page?: number | null; card?: { prompt?: string; revealed?: boolean; shownMs?: number | null; role?: "subject" | "scenery" } | null; onHome?: boolean; onBoard?: boolean; thread?: string | null }
export function whereBlock(boardId: string, here: Here, words: string | null = null): string {
  const lines: string[] = [];
  if (words) lines.push(`They are asking about these words of the source: "${words.replace(/\s+/g, " ").trim().slice(0, 600)}"`);
  const s = here.sectionId ? (q.section.get(here.sectionId) as SectionRow | undefined) : undefined;
  if (s && s.board_id === boardId) {
    const r = q.resource.get(boardId, s.resource_id) as ResourceRow | undefined;
    const file = r?.filename ?? "the source";
    const total = sectionsCount(s.resource_id);
    lines.push(total > 1
      ? `Reading "${s.label}" (pages ${s.first_page}–${s.last_page === SECTION_TO_END ? "end" : s.last_page} of ${file}).`
      : `Reading ${file}.`);
    if (here.page) lines.push(`On page ${here.page}.`);
  } else {
    const place = placeLine(here.surface, here.onHome, here.onBoard !== false);
    if (place) lines.push(place);
  }
  if (here.card && here.card.prompt) {
    lines.push(cardLine(String(here.card.prompt), here.card.shownMs));
  }
  return lines.length ? `WHERE THEY ARE\n${lines.join("\n")}` : "";
}
