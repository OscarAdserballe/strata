import type { BoardPlan, DeckSummary, Pair, ResourceMeta, Section } from "../../../shared/types/index.ts";

export interface CramDeck { slug: string; label: string; total: number; kept: number }
export interface CramSource { key: string; label: string; group: string | null; book: boolean; decks: CramDeck[] }

const stem = (f: string): string => (f || "").replace(/\.[^.]+$/, "");

export function cramSources(
  pairs: Pair[], resources: ResourceMeta[], sections: Section[], decks: DeckSummary[], plan: BoardPlan | null | undefined,
): CramSource[] {
  const bySlug = new Map(decks.map((d) => [d.slug, d]));
  const secById = new Map(sections.map((s) => [s.id, s]));
  const resById = new Map(resources.map((r) => [r.id, r]));
  const rows = new Map<string, CramSource>();
  const seenDeck = new Set<string>();
  const groups = new Set((plan?.groups || []).map((g) => g.id));
  for (const p of pairs) {
    if (!p.deck || seenDeck.has(p.deck)) continue;
    const sec = p.sectionId ? secById.get(p.sectionId) : undefined;
    if (sec && sec.kind === "apparatus") continue;
    const d = bySlug.get(p.deck);
    if (!d || !d.total) continue;
    seenDeck.add(p.deck);
    const r = p.resourceId ? resById.get(p.resourceId) : undefined;
    const key = r ? r.id : p.id;
    let row = rows.get(key);
    if (!row) {
      const g = plan?.places?.[key]?.group ?? null;
      const book = !!r && sections.filter((s) => s.resourceId === r.id).length > 1;
      row = { key, label: "", group: g && groups.has(g) ? g : null, book, decks: [] };
      rows.set(key, row);
    }
    row.decks.push({ slug: p.deck, label: (sec && sec.label) || p.label || stem(r?.filename || "") || p.deck, total: d.total, kept: d.kept || 0 });
  }
  for (const row of rows.values()) {
    const r = resById.get(row.key);
    row.label = row.book && r ? stem(r.filename) : row.decks[0].label;
  }
  const ordOf = (key: string): number => plan?.places?.[key]?.ord ?? 1e9;
  return Array.from(rows.values()).map((r, i) => [r, i] as const)
    .sort((a, b) => ordOf(a[0].key) - ordOf(b[0].key) || a[1] - b[1]).map((x) => x[0]);
}

export interface CramPrefs { decks: string[] | null; mine: boolean; kept: boolean; dropped: string[] }
export const DEFAULT_PREFS: CramPrefs = { decks: null, mine: true, kept: true, dropped: [] };
const prefsKey = (boardId: string): string => "strata.cram." + boardId;

export function loadPrefs(boardId: string): CramPrefs {
  try {
    const raw = localStorage.getItem(prefsKey(boardId));
    const p = raw ? JSON.parse(raw) : null;
    if (!p || typeof p !== "object") return { ...DEFAULT_PREFS };
    return {
      decks: Array.isArray(p.decks) ? p.decks.filter((x: unknown) => typeof x === "string") : null,
      mine: p.mine !== false, kept: p.kept !== false,
      dropped: Array.isArray(p.dropped) ? p.dropped.filter((x: unknown) => typeof x === "string") : [],
    };
  } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(boardId: string, p: CramPrefs): void {
  try { localStorage.setItem(prefsKey(boardId), JSON.stringify(p)); } catch { /* private window: forget it */ }
}

export const tickedDecks = (sources: CramSource[], p: CramPrefs): Set<string> => {
  const all = sources.flatMap((s) => s.decks.map((d) => d.slug));
  return new Set(p.decks === null ? all : all.filter((s) => p.decks!.includes(s)));
};

export const countOf = (d: CramDeck, kept: boolean): number => (kept ? d.kept : d.total);

export interface PileCard { id: string; mintOpen?: unknown; back?: unknown }

export function pileOf<C extends PileCard>(
  deckCards: { slug: string; cards: C[]; kept: Set<string> | null }[],
  mine: C[], p: CramPrefs,
): C[] {
  const out: C[] = [];
  const seen = new Set<string>(p.dropped);
  for (const d of deckCards) {
    for (const c of d.cards) {
      if (seen.has(c.id)) continue;
      if (p.kept && !(d.kept && d.kept.has(c.id))) continue;
      seen.add(c.id); out.push(c);
    }
  }
  if (p.mine) for (const c of mine) {
    if (seen.has(c.id) || c.mintOpen || !String(c.back || "").trim()) continue;
    seen.add(c.id); out.push(c);
  }
  return out;
}

export const crammableMine = <C extends PileCard>(mine: C[]): C[] => mine.filter((c) => !c.mintOpen && String(c.back || "").trim());

export function shuffled<T>(xs: T[], rand: () => number = Math.random): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function afterGrade<T extends { id: string; type?: string }>(queue: T[], got: boolean): T[] {
  if (!queue.length) return queue;
  return got || queue[0].type === "mcq" ? queue.slice(1) : queue.slice(1).concat(queue[0]);
}
