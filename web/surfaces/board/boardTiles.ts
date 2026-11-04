export interface Resource {
  id: string; kind: string; filename?: string; read?: unknown;
  createdAt?: number; lastReadAt?: number; doneAt?: number | null; originUrl?: string | null;
}
export interface Section {
  id: string; resourceId?: string | null; kind?: string; label?: string;
  firstPage?: number; lastPage?: number | null;
}
export interface Pair {
  id: string; isHome?: boolean; resourceId?: string | null; sectionId?: string | null; label?: string;
  deck: string;
}
export interface DeckRow { slug: string; total: number; ignored?: number; kept?: number; benched?: boolean }
export interface Touch { seen?: number; done?: number; last?: number }
export interface TreeRow { status?: string }
export interface BoardState {
  board?: { title?: string } | null;
  sections?: Section[]; resources?: Resource[]; marks?: { resourceId: string }[];
  touched?: Record<string, Touch>; trees?: Record<string, TreeRow>;
}
export interface QGroup { kind?: string; name: string; cards: { mintOpen?: unknown }[] }
export interface Aside { slugs: string[]; live: number; out: number }
export interface Kept { kept: number; total: number; benched: boolean }

export interface Tile {
  key: string; boardId?: string | null; kind?: string; label?: string; meta?: string; title?: string;
  cover?: string; cvTitle?: string; text?: string;
  gap?: string; root?: boolean;
  enter?: string; keepBoard?: boolean;
  pdf?: boolean; rid?: string | null; page?: number; pages?: number | null; sections?: number;
  pair?: number; cur?: boolean; at?: boolean; dim?: boolean | null; busy?: boolean; read?: unknown;
  cards?: number; seen?: number; done?: number; last?: number;
  aside?: Aside | null; kp?: Kept | null; keep?: string | null; del?: { res?: string; pair?: string };
  qgroup?: QGroup; ignoredPile?: boolean; add?: "file" | "link";
  addedAt?: number; readAt?: number; doneAt?: number | null; file?: string; origin?: string | null; marksN?: number;
}

export interface BoardTileInputs {
  board: BoardState | null;
  touchLive: Record<string, Touch> | null;
  decks: DeckRow[];
  pairs: Pair[];
  pairIdx: number;
  bookView: { rid?: string; top?: boolean } | null;
  qDeck: { kind?: string; name?: string } | null;
  solo: boolean;
  activeId: string | null;
  driftSection: { id: string } | null;
  notes: string;
  qGroups: QGroup[];
  pageCount?: (rid: string) => number | undefined;
}

export function boardTiles({ board, touchLive, decks, pairs, pairIdx, bookView, qDeck, solo, activeId, driftSection, notes, qGroups, pageCount }: BoardTileInputs): Tile[] {
  const out: Tile[] = [];
  if (!board) return out;
  const secs = board.sections || [];
  const res = board.resources || [];
  const touched = touchLive || board.touched || {};
  const tr = board.trees || {};
  // a just-uploaded source has no tree row until classify finishes
  const distilState = (sid: string | null | undefined, r: Resource | null | undefined): string | null => {
    const t = sid ? tr[sid] : null;
    if (!t) return null;
    if (t.status === "preparing") return "preparing…";
    if (t.status === "queued" || t.status === "running" || t.status === "carding") return "distilling…";
    if (t.status === "error") return "distil failed";
    return null;
  };
  const busyMeta = (ds: string | null) => ds === "distilling…" || ds === "preparing…";
  const marksBy: Record<string, number> = {};
  for (const m of board.marks || []) marksBy[m.resourceId] = (marksBy[m.resourceId] || 0) + 1;
  const whenOf = (r: Resource | null | undefined) => (r ? { addedAt: r.createdAt || 0, readAt: r.lastReadAt || 0, doneAt: r.doneAt || null,
    file: r.filename || "", origin: r.originUrl || null, marksN: marksBy[r.id] || 0 } : {});
  // measured uncapped (`full`, not `total`): ignoring is a judgment on the whole deck
  const asideOf = (slugs: string[]): Aside | null => {
    const list = Array.from(new Set((slugs || []).filter(Boolean)));
    let live = 0, out = 0;
    for (const sl of list) {
      const d = decks.find((x) => x.slug === sl);
      if (!d) continue;
      live += d.total || 0; out += d.ignored || 0;
    }
    return list.length ? { slugs: list, live, out } : null;
  };
  const keepOf = (slugs: string[]): Kept | null => {
    const list = Array.from(new Set((slugs || []).filter(Boolean)));
    let kept = 0, total = 0, benched = false, any = false;
    for (const sl of list) {
      const d = decks.find((x) => x.slug === sl);
      if (!d || !d.total) continue;
      any = true; kept += d.kept || 0; total += d.total || 0; benched = benched || !!d.benched;
    }
    return any ? { kept, total, benched } : null;
  };
  const asideAlone = (a: Aside | null) => (a && !a.live && a.out ? a.out + " set aside" : "");
  const asideSaid = (a: Aside | null) => (asideAlone(a) ? " · " + asideAlone(a) : "");
  const followRid = (() => {
    const p = pairs[pairIdx];
    if (!p || p.isHome || !p.resourceId) return null;
    const r = res.find((x) => x.id === p.resourceId);
    if (!r || r.kind !== "pdf") return null;
    return secs.filter((s) => s.resourceId === r.id).length > 1 ? r.id : null;
  })();
  const intoRid = bookView === null ? followRid
    : bookView.rid && res.some((x) => x.id === bookView.rid) ? bookView.rid : null;

  if (intoRid) {
    const r = res.find((x) => x.id === intoRid)!;
    const name = (r.filename || "").replace(/\.[^.]+$/, "");
    out.push({ key: "gap:" + r.id, gap: name, root: true });
    let first = true;
    pairs.forEach((p, i) => {
      if (p.isHome || p.resourceId !== intoRid) return;
      const sec = p.sectionId ? secs.find((s) => s.id === p.sectionId) : null;
      const d = decks.find((x) => x.slug === p.deck);
      const n = d ? d.total : 0;
      const ds = !n ? distilState(p.sectionId, r) : null;
      const here = i === pairIdx && !qDeck && !solo;
      const app = sec && sec.kind === "apparatus";
      const aside = asideOf([p.deck]);
      out.push({
        key: p.id, boardId: activeId, pdf: true, rid: r.id, page: sec ? sec.firstPage : 1,
        kind: "pdf", label: (sec ? sec.label : p.label) || r.filename, aside, busy: !app && busyMeta(ds),
        keep: !app && n ? p.deck : null, kp: app ? null : keepOf([p.deck]),
        meta: app ? "apparatus" : "p. " + (sec ? sec.firstPage : 1) + (n ? " · " + n + " cards" : ds ? " · " + ds : asideSaid(aside)),
        title: (sec ? sec.label : p.label) + " — pages " + (sec ? sec.firstPage : 1) + "–" + ((sec && sec.lastPage) || "end"),
        cards: app ? 0 : n, dim: app, read: first ? r.read : null, pair: i, cur: here,
        seen: app ? 0 : (touched[p.deck] || {}).seen || 0, done: app ? 0 : (touched[p.deck] || {}).done || 0,
        at: !!(driftSection && sec && driftSection.id === sec.id),
      });
      first = false;
    });
    return out;
  }

  out.push({ key: "home", boardId: activeId, kind: "log", label: "home", meta: "the log",
    cover: "the log", cvTitle: (board.board && board.board.title) || "the board", text: notes, pair: 0,
    cur: pairIdx === 0 && !qDeck && !solo, title: "the board's running log" });
  const srcs: (Tile & { cards: number })[] = [];
  const seenBook = new Set<string>();
  pairs.forEach((p, i) => {
    if (p.isHome) return;
    const r = p.resourceId ? res.find((x) => x.id === p.resourceId) : null;
    const kin = p.resourceId ? secs.filter((s) => s.resourceId === p.resourceId) : [];
    const d = decks.find((x) => x.slug === p.deck);
    const n = d ? d.total : 0;
    const ds = !n ? distilState(p.sectionId, r) : null;
    const here = i === pairIdx && !qDeck && !solo;
    if (r && r.kind === "pdf" && kin.length > 1) {
      if (seenBook.has(r.id)) return;
      seenBook.add(r.id);
      const inIt = pairs.some((p2, i2) => p2.resourceId === r.id && i2 === pairIdx) && !qDeck && !solo;
      const name = (r.filename || "").replace(/\.[^.]+$/, "");
      const agg = { cards: 0, seen: 0, done: 0, last: 0 };
      for (const p2 of pairs) {
        if (p2.resourceId !== r.id) continue;
        const s2 = p2.sectionId ? secs.find((x) => x.id === p2.sectionId) : null;
        if (s2 && s2.kind === "apparatus") continue;
        const d2 = decks.find((x) => x.slug === p2.deck);
        agg.cards += d2 ? d2.total : 0;
        const t2 = touched[p2.deck] || {};
        agg.seen += t2.seen || 0; agg.done += t2.done || 0;
        agg.last = Math.max(agg.last, t2.last || 0);
      }
      let busyK = 0, readyK = 0, errK = 0, workK = 0;
      for (const s2 of kin) {
        if (s2.kind === "apparatus") continue;
        workK++;
        const t2 = tr[s2.id]; if (!t2) continue;
        if (t2.status === "queued" || t2.status === "running" || t2.status === "carding") busyK++;
        else if (t2.status === "ready") readyK++;
        else if (t2.status === "error") errK++;
      }
      const preparing = kin.some(s => (tr[s.id] || {}).status === "preparing");
      const aside = asideOf(pairs.filter((p2) => p2.resourceId === r.id).map((p2) => p2.deck));
      srcs.push({
        key: "fold:" + r.id, boardId: activeId, pdf: true, rid: r.id, page: 1, kind: "pdf", keepBoard: true,
        label: name, aside, kp: keepOf(pairs.filter((p2) => p2.resourceId === r.id).map((p2) => p2.deck)),
        busy: !!(busyK || preparing), ...whenOf(r),
        meta: busyK ? "distilling · " + readyK + "/" + workK
          : preparing ? kin.length + " sections · preparing…"
          : errK ? kin.length + " sections · distil failed"
          : kin.length + " sections" + asideSaid(aside),
        title: name + " — " + kin.length + " sections; click to step inside",
        enter: r.id, del: { res: r.id }, sections: kin.length,
        cards: agg.cards, seen: agg.seen, done: agg.done, last: agg.last, read: r.read, cur: inIt,
      });
      return;
    }
    if (r && r.kind === "pdf") {
      const total = pageCount ? pageCount(r.id) : 0;
      const name = (p.label || r.filename || "untitled").replace(/\.[^.]+$/, "");
      const aside = asideOf([p.deck]);
      srcs.push({
        key: p.id, boardId: activeId, pdf: true, rid: r.id, page: 1, kind: "pdf", aside,
        keep: n ? p.deck : null, kp: keepOf([p.deck]),
        label: name, meta: (total ? total + " pages" : "pdf") + (n ? " · " + n + " cards" : ds ? " · " + ds : asideSaid(aside)),
        busy: busyMeta(ds), ...whenOf(r), pages: total || null,
        title: r.filename, cards: n, read: r.read, pair: i, cur: here, del: { res: r.id }, sections: 1,
        seen: (touched[p.deck] || {}).seen || 0, done: (touched[p.deck] || {}).done || 0,
        last: (touched[p.deck] || {}).last || 0,
      });
      return;
    }
    const aside = asideOf([p.deck]);
    srcs.push({
      key: p.id, boardId: activeId, rid: r ? r.id : null, kind: r ? r.kind : "deck", aside, sections: r ? 1 : 0,
      keep: n ? p.deck : null, kp: keepOf([p.deck]),
      label: (p.label || (r && r.filename) || "untitled").replace(/\.[^.]+$/, ""),
      meta: r ? (r.kind + (n ? " · " + n + " cards" : ds ? " · " + ds : asideSaid(aside)))
             : (n ? n + " cards" : (asideAlone(aside) || "no deck")),
      cover: r ? r.kind : "cards only", title: (r && r.filename) || p.label || "",
      busy: !!r && busyMeta(ds), ...whenOf(r),
      cards: n, read: r ? r.read : null, pair: i, cur: here,
      del: r ? { res: r.id } : { pair: p.id },
      seen: (touched[p.deck] || {}).seen || 0, done: (touched[p.deck] || {}).done || 0,
      last: (touched[p.deck] || {}).last || 0,
    });
  });
  const doneSrc = (t: { cards: number; seen?: number }) => (t.cards || 0) > 0 && (t.seen || 0) >= t.cards;
  for (const t of srcs) if (!doneSrc(t)) out.push(t);
  for (const t of srcs) if (doneSrc(t)) out.push(t);
  for (const g2 of qGroups) {
    if (g2.kind === "ignored") continue;
    const openN = g2.cards.filter((c) => c.mintOpen).length;
    out.push({
      key: "q:" + g2.name, boardId: activeId, kind: "mine", label: g2.name,
      meta: openN ? openN + " open" : g2.cards.length + " cards", cover: "yours",
      cards: g2.cards.length, qgroup: g2, cur: !!(qDeck && qDeck.name === g2.name),
    });
  }
  const ignoredN = Array.from(new Set(pairs.map((p2) => p2.deck).filter(Boolean)))
    .reduce((s2, sl) => { const d2 = decks.find((x) => x.slug === sl); return s2 + ((d2 && d2.ignored) || 0); }, 0);
  if (ignoredN) out.push({
    key: "q:ignored", boardId: activeId, kind: "mine", label: "ignored",
    meta: ignoredN + (ignoredN === 1 ? " card" : " cards") + " set aside", cover: "set aside",
    cards: ignoredN, ignoredPile: true, cur: !!(qDeck && qDeck.kind === "ignored"),
  });
  out.push({ key: "add:file", boardId: activeId, kind: "add", label: "+ a source", meta: "pdf / md / txt", cover: "add", add: "file" });
  out.push({ key: "add:link", boardId: activeId, kind: "add", label: "+ from a link", meta: "youtube / article", cover: "add", add: "link" });
  return out;
}
