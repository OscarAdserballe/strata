import { compileImportPlan, type ContentRange, type ImportHeading, type StudyUnit } from "../../../shared/imports/import-plan.ts";
import { pageGroups } from "../../../shared/imports/budget.ts";
import { BUDGET_TOKENS } from "../../platform/config.ts";
import { SECTION_TO_END } from "../../platform/db/schema.ts";
import { q } from "../repo.ts";
import { genId, now, parseJson } from "../../platform/db/sql.ts";
import type { PairRow, ResourceRow, SectionRow } from "../../platform/db/rows.ts";
import { bytesOf, pagesOf } from "../sources/blobs.ts";
import { pairForResource } from "../sources/ingest.ts";
import { readOutline } from "../imports/outline.ts";
import { genSlug } from "../decks/decks.ts";

type Shape = Pick<SectionRow, "first_page" | "last_page" | "content_ranges">;

/** The text a section covers: its own ranges, or its whole pages. */
export function coverage(s: Shape, pages: string[]): ContentRange[] {
  if (s.content_ranges) return parseJson<ContentRange[]>(s.content_ranges, []);
  const last = s.last_page === SECTION_TO_END ? pages.length : Math.min(s.last_page, pages.length);
  const out: ContentRange[] = [];
  for (let p = Math.max(1, s.first_page); p <= last; p++) if (pages[p - 1]?.length) out.push({ page: p, start: 0, end: pages[p - 1].length });
  return out;
}

export const sameText = (a: ContentRange[], b: ContentRange[]): boolean => JSON.stringify(a) === JSON.stringify(b);

export function overlap(a: ContentRange[], b: ContentRange[]): number {
  let n = 0;
  for (const x of a) for (const y of b) if (x.page === y.page) n += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
  return n;
}

export interface Match {
  /** per new unit: the old section whose id it continues, or null for a new one */
  from: (number | null)[];
  /** per new unit: it covers exactly the old section's text */
  same: boolean[];
  /** per old section: the new unit its kept cards go to */
  home: number[];
}

/** Each old id is used once: by the unit covering the same text, else by the unit sharing the most text with it. */
export function matchSections(was: ContentRange[][], now: ContentRange[][]): Match {
  const from: (number | null)[] = now.map(() => null), same = now.map(() => false), taken = new Set<number>();
  now.forEach((n, j) => {
    const i = was.findIndex((w, k) => !taken.has(k) && sameText(w, n));
    if (i >= 0) { from[j] = i; same[j] = true; taken.add(i); }
  });
  const shared: { i: number; j: number; n: number }[] = [];
  was.forEach((w, i) => now.forEach((u, j) => { const n = overlap(w, u); if (n > 0) shared.push({ i, j, n }); }));
  shared.sort((a, b) => b.n - a.n || a.i - b.i || a.j - b.j);
  for (const { i, j } of shared) if (!taken.has(i) && from[j] === null) { from[j] = i; taken.add(i); }
  const at = (r: ContentRange[]) => r[0]?.page ?? 0;
  const home = was.map((w, i) => {
    const own = from.indexOf(i);
    if (own >= 0) return own;
    let best = 0, score = -Infinity;
    now.forEach((u, j) => {
      const n = overlap(w, u), s = n > 0 ? n : -1 - Math.abs(at(u) - at(w));
      if (s > score) { score = s; best = j; }
    });
    return best;
  });
  return { from, same, home };
}

/** The sections as choices over an outline: where each unit starts, and the rows no section covers. */
export function splitOf(outline: ImportHeading[], covers: ContentRange[][], pages: string[]): { starts: number[]; excluded: number[] } {
  const owner: number[] = outline.map(() => -1);
  const end = { page: pages.length, offset: pages.at(-1)?.length ?? 0 };
  for (let i = outline.length - 1; i >= 0; i--) {
    const next = outline[i + 1] ?? end;
    let { page, offset } = outline[i];
    while (page < next.page && offset >= (pages[page - 1]?.length ?? 0)) { page++; offset = 0; }
    // a row with no text of its own (a part title right above its first chapter) goes with the row after it
    if (page > next.page || (page === next.page && offset >= next.offset)) { owner[i] = owner[i + 1] ?? -1; continue; }
    owner[i] = covers.findIndex((rs) => rs.some((r) => r.page === page && r.start <= offset && offset < r.end));
  }
  const starts: number[] = [], excluded: number[] = [];
  let prev = -1;
  owner.forEach((o, i) => {
    if (o < 0) { excluded.push(i); return; }
    if (prev >= 0 && o !== prev) starts.push(i);
    prev = o;
  });
  return { starts, excluded };
}

/** The outline as the stored text can hold it, or none. */
function fit(outline: ImportHeading[], pages: string[]): ImportHeading[] {
  const held = outline.map((h) => ({ ...h, offset: Math.min(h.offset, pages[h.page - 1]?.length ?? 0) }));
  try { compileImportPlan({ outline: held, starts: [], excluded: [] }, pages); return held; } catch { return []; }
}

async function outlineOf(rid: string): Promise<ImportHeading[]> {
  const stored = q.outlineOf.get(rid)?.outline;
  if (stored != null) return parseJson<ImportHeading[]>(stored, []);
  const bytes = bytesOf(rid);
  if (!bytes) return [];
  try {
    const outline = await readOutline(bytes);
    q.setOutline.run(JSON.stringify(outline), rid);
    return outline;
  } catch (e) {
    console.error(`[sections ${rid}]`, e instanceof Error ? e.message : e);
    return [];
  }
}

export const splitRevOf = (rid: string): number => q.splitRev.get(rid)?.rev ?? 0;
export const splitBrief = (rid: string) => ({
  sections: (q.sectionsOf.all(rid) as SectionRow[]).map((s) => ({ id: s.id, label: s.label, firstPage: s.first_page, lastPage: s.last_page })),
});

/** What the section editor opens on: the outline, the text it measures, and the current split as choices over it. */
export async function splitChoice(r: ResourceRow) {
  const pages = pagesOf(r.id);
  const bookmarks = fit(await outlineOf(r.id), pages);
  // read after the await, so the split and its rev are the same moment's
  const covers = (q.sectionsOf.all(r.id) as SectionRow[]).map((s) => coverage(s, pages));
  const rev = splitRevOf(r.id);
  const byPages = pageGroups(pages, BUDGET_TOKENS).outline;
  const options = [...(bookmarks.length > 1 ? [{ outline: bookmarks, pages: false }] : []), { outline: byPages, pages: true }];
  let best: { outline: ImportHeading[]; pages: boolean; starts: number[]; excluded: number[]; kept: number } | null = null;
  for (const o of options) {
    const split = splitOf(o.outline, covers, pages);
    let kept = -1;
    try { kept = compileImportPlan({ outline: o.outline, ...split }, pages).filter((u) => covers.some((c) => sameText(c, u.ranges))).length; }
    catch { /* not expressible over this outline */ }
    if (!best || kept > best.kept) best = { ...o, ...split, kept };
  }
  const outline = options[0].outline;
  return {
    title: (r.filename ?? "source").replace(/\.[^.]+$/, ""), outline, defaultStarts: splitOf(outline, covers, pages).starts,
    pageText: pages, budgetTokens: BUDGET_TOKENS, hasBookmarks: bookmarks.length > 1, startByPages: best!.pages && bookmarks.length > 1,
    plan: { outline: best!.outline, starts: best!.starts, excluded: best!.excluded }, rev,
  };
}

export interface Resplit { ids: string[]; changed: string[]; kept: number; removed: number; refiled: number }

/** One synchronous write: sections keep their ids where the text allows, and a removed section's kept cards move to its heir. */
export function applySplit(boardId: string, r: ResourceRow, units: StudyUnit[], pages: string[]): Resplit {
  const old = q.sectionsOf.all(r.id) as SectionRow[];
  const m = matchSections(old.map((s) => coverage(s, pages)), units.map((u) => u.ranges));
  const base = (r.filename ?? "source").replace(/\.[^.]+$/, "").slice(0, 160) || "untitled";
  const pairName = (label: string) => `${base} · ${label}`.slice(0, 200);
  const ids = units.map((_u, j) => { const i = m.from[j]; return i === null ? "s" + genId() : old[i].id; });
  const changed: string[] = [];
  units.forEach((u, j) => {
    const i = m.from[j], sid = ids[j];
    const tokens = Math.ceil(u.ranges.reduce((n, x) => n + x.end - x.start + 12, 0) / 4);
    if (i === null) {
      q.insSection.run(sid, r.id, boardId, j, u.label, u.firstPage, u.lastPage, now(), tokens);
      q.setSectionRanges.run(JSON.stringify(u.ranges), sid);
      changed.push(sid);
      return;
    }
    const was = old[i];
    if (m.same[j]) { q.reshapeSection.run(j, was.label, was.first_page, was.last_page, was.content_ranges ?? null, was.tokens, null, sid); return; }
    q.reshapeSection.run(j, u.label, u.firstPage, u.lastPage, JSON.stringify(u.ranges), tokens, "work", sid);
    if (u.label !== was.label) q.relabelSectionPair.run(pairName(u.label), boardId, sid, pairName(was.label));
    changed.push(sid);
  });
  let refiled = 0;
  const heirs = new Set<string>();
  old.forEach((s, i) => {
    if (m.from.includes(i)) return;
    const from = genSlug(s.id), heir = ids[m.home[i]], to = genSlug(heir);
    const n = q.keepsOf.all(from).length;
    if (n) {
      if (!q.course.get(to)) q.upsertCourse.run(to, units[m.home[i]].label, null, now());
      q.refileEdits.run(from, to); q.refileThreads.run(from, to); q.refileCards.run(from, to); q.refileKeeps.run(from, to);
      refiled += n;
      heirs.add(heir);
    }
    q.delCourseCards.run(from); q.delCourse.run(from);
    for (const p of q.pairsOf.all(boardId) as PairRow[]) if (p.section_id === s.id) { q.delPlace.run(boardId, p.id); q.delPair.run(boardId, p.id); }
    q.delTree.run(s.id); q.delSection.run(s.id);
  });
  pairForResource(boardId, base, r.id);
  const mine = (q.pairsOf.all(boardId) as PairRow[]).filter((p) => p.resource_id === r.id);
  const place = new Map(ids.map((id, j) => [id, j]));
  const slots = mine.map((p) => p.ord).sort((a, b) => a - b);
  [...mine].sort((a, b) => (place.get(a.section_id ?? "") ?? Infinity) - (place.get(b.section_id ?? "") ?? Infinity))
    .forEach((p, k) => {
      if (p.ord !== slots[k]) q.setPairOrd.run(slots[k], boardId, p.id);
      if (!p.deck && p.section_id && heirs.has(p.section_id)) q.updPair.run(p.label, p.resource_id, genSlug(p.section_id), boardId, p.id);
    });
  q.delSourceTree.run(r.id);
  return { ids, changed, kept: m.same.filter(Boolean).length, removed: old.length - m.from.filter((i) => i !== null).length, refiled };
}
