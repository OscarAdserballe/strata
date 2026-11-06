import { drawFold, type FoldAsk, type FoldCard, type FoldDraft, type FoldIntents, type FoldNote, type TickMark } from "./view.ts";
import type { Anchor } from "../../../shared/reading/anchors.ts";

// One drawer for every kind of source: a card lives on its own words and opens from them, like a reader's highlight;
// notes and questions are grouped by passage, with a tick on a shut one. Sheets lie on a plane over the page, never in it.

/** Where a layer sits: offsets and words, a page's labelled box, or a PDF page and its lines as page fractions. */
export interface LayerAnchor {
  start: number; end: number; quote: string; box?: string | null; page?: number | null; rects?: readonly (readonly number[])[];
  /** a card made before cards kept their words: §, #slug, a time, a page or a quote, found the old way */
  legacy?: Anchor | null;
  /** the rendered block the words were picked in, while they are being written about */
  block?: number | null;
}
export type LayerItem = (FoldNote | FoldCard | FoldDraft | FoldAsk) & { anchor: LayerAnchor };
/** A passage layers hang on; `key` is stable while the passage is. `words`: a card's own words (its `tint`) are its
 *  place and its handle: no tick, it opens when they are clicked. */
export interface Spot { key: string; block: HTMLElement; hidden?: boolean; tint?: Range | null; words?: boolean }
/** The words cards and questions sit on, by layer, to be washed in its colour: a card answered, and one open or under the
 *  pointer, have their own wash. */
export interface Tints { card: Range[]; ask: Range[]; "card-done"?: Range[]; "card-on"?: Range[] }
export interface Box { top: number; bottom: number; left: number; right: number }
/** Where a passage sits on the plane the sheets lie on, in the plane's own units. */
export interface Place {
  passage: Box;
  /** the column the passage reads in: an unmoved sheet lies inside it */
  column: { left: number; right: number };
  /** the plane's width, so a sheet never hangs off it */
  width: number;
  /** where an unmoved sheet's top goes when not just under the passage: a slide's sheet lies over the slide */
  dock?: number;
  /** plane units per CSS pixel of a sheet's own drawing: a live page draws its sheets at the room's scale */
  unit: number;
  /** plane units per pointer pixel, for a drag */
  perClient: number;
  /** a card's words: where its last line starts and ends, the point its sheet hangs from */
  hang?: { x: number; y: number };
}
export interface LayerDom {
  spotOf(item: LayerItem): Spot | null;
  /** where a passage is on the plane; null when it can't show (yet) */
  place(spot: Spot): Place | null;
  /** the sheet for a key, made once and kept: `host` is placed on the plane, the fold is drawn into `root` */
  sheet(key: string): { host: HTMLElement; root: HTMLElement } | null;
  closeExcept(keep: ReadonlySet<string>): void;
  /** washes the words layers sit on; called with every draw, empty lists clearing it */
  tint?(t: Tints): void;
  tick(spot: Spot, marks: readonly TickMark[], peek: { kind: string; text: string }, open: () => void): void;
  clearTicks(): void;
  /** where a click on a card's words is heard: the scroller, or a live page's document */
  surface?(): HTMLElement | Document | null;
}
export type LayerIntents = Omit<FoldIntents, "shut"> & {
  /** every draw, the host's own or one the reader made in a sheet: the faces the host draws into may have moved */
  drawn?(): void;
};

export interface LayerDrawer {
  draw(items: readonly LayerItem[], on: LayerIntents): void;
  /** draws the last items again, for when the document moved under them */
  redraw(): void;
  /** opens the sheets of these items as soon as their passages can show them */
  openFor(ids: readonly string[]): void;
  forget(): void;
}

/** The key of the sheet the threads are drawn on, under every other sheet. */
export const THREADS = "~threads";
const SHEET_W = 460, INSET = 40, GAP = 8, BRACKET = 13, PUSH = 180, CARET = 7;

const said = (it: LayerItem) => it.kind === "note" && !!it.text.trim();
const asking = (it: LayerItem) => it.kind === "card" && it.state !== "done";
const markOf = (it: LayerItem): TickMark => (it.kind === "note" ? "note" : it.kind === "ask" ? "ask" : it.kind === "card" && it.state === "done" ? "card-done" : "card");
// an ask with nothing said yet is being asked; one being answered stays open while the answer comes
const asking_ = (it: LayerItem) => it.kind === "ask" && (!it.turns.length || it.writing !== null);
const peekOf = (it: LayerItem): { kind: string; text: string } =>
  it.kind === "note" ? { kind: "note", text: it.text } : it.kind === "card" ? { kind: "card", text: it.q }
  : it.kind === "ask" ? { kind: "ask", text: it.turns[0]?.text ?? it.quote } : { kind: "card", text: it.quote };
const colourOf = (items: readonly LayerItem[]) =>
  items.some((it) => it.kind === "card" || it.kind === "draft") ? "var(--accent,#41678a)" : items.every((it) => it.kind === "ask") ? "var(--ink-soft,#58514c)" : "var(--warn,#bd7138)";

/** Where an unmoved sheet lies: under its words, starting where their last line does, or else inside its passage's
 *  column just under the passage; never off the plane. */
export function dockOf(p: Place): { x: number; y: number; w: number } {
  const u = p.unit, col = p.column.right - p.column.left;
  const w = Math.max(Math.min(SHEET_W * u, col - 16 * u, p.width - 8 * u), Math.min(220 * u, p.width - 8 * u));
  let x = p.column.left + Math.max(0, Math.min(INSET * u, col - w));
  if (p.hang) x = Math.max(p.column.left - 20 * u, Math.min(p.hang.x - 24 * u, p.column.right + 20 * u - w));
  x = Math.max(4 * u, Math.min(x, p.width - w - 4 * u));
  return { x, y: p.hang ? p.hang.y + (GAP + 2) * u : p.dock ?? p.passage.bottom + GAP * u, w };
}

/** A bracket beside the passage on the side nearer its sheet, and a thread from it to the sheet's corner; a card's sheet
 *  under its words points at them with a caret instead, and is tied to them by a thread only once moved away. */
export function threadOf(p: Place, at: { x: number; y: number; w: number }): { bracket: string; thread: string; from: [number, number]; to: [number, number]; caret: string } {
  const u = p.unit;
  if (p.hang) {
    const h = p.hang, cx = Math.max(at.x + 16 * u, Math.min(h.x + 12 * u, at.x + at.w - 16 * u)), below = at.y - h.y;
    if (below >= 0 && below <= (GAP + 2 + CARET) * u * 2 && Math.abs(cx - (h.x + 12 * u)) < 2 * u)
      return { bracket: "", thread: "", from: [cx, h.y], to: [cx, at.y], caret: `M${cx - CARET * u} ${at.y + 1 * u} L${cx} ${at.y - CARET * u} L${cx + CARET * u} ${at.y + 1 * u} Z` };
    const tx = at.x + Math.min(Math.max(h.x - at.x, 14 * u), at.w - 14 * u), ty = at.y, dy = ty - h.y;
    return { bracket: "", thread: `M${h.x} ${h.y} C${h.x} ${h.y + dy * 0.5} ${tx} ${ty - dy * 0.5} ${tx} ${ty}`, from: [h.x, h.y], to: [tx, ty], caret: "" };
  }
  const mid = (p.column.left + p.column.right) / 2, right = at.x + at.w / 2 > mid + (p.column.right - p.column.left) * 0.3;
  const bx = right ? p.column.right + BRACKET * u : p.column.left - BRACKET * u, s = right ? -4 * u : 4 * u;
  const top = p.passage.top + 2 * u, bot = Math.max(top + 6 * u, p.passage.bottom - 2 * u);
  const tx = right ? at.x + at.w - 14 * u : at.x + 14 * u, ty = at.y;
  // a sheet lying over its own passage (a slide's) is tied from beside it, not from the passage's end
  const fy = Math.min(bot, Math.max(top, ty)), dx = tx - bx, dy = ty - fy;
  const c1 = [bx + dx * 0.4, fy + Math.max(0, dy) * 0.6], c2 = [tx, ty - Math.min(18 * u, Math.abs(dy) * 0.5 + 6 * u)];
  return {
    bracket: `M${bx + s} ${top} H${bx} V${bot} H${bx + s}`,
    thread: `M${bx} ${fy} C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${tx} ${ty}`,
    from: [bx, fy], to: [tx, ty], caret: "",
  };
}

/** Whether two ranges share any words: two cards on overlapping words open as one sheet. */
function overlaps(a: Range, b: Range): boolean {
  try { return a.compareBoundaryPoints(Range.START_TO_END, b) > 0 && a.compareBoundaryPoints(Range.END_TO_START, b) < 0; } catch { return false; }
}

/** Whether a client point is on a range's words, with a little slack between lines. */
export function onWords(rects: ArrayLike<{ left: number; right: number; top: number; bottom: number }>, x: number, y: number, slack = 2): boolean {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.left - slack && x <= r.right + slack && y >= r.top - slack && y <= r.bottom + slack) return true;
  }
  return false;
}

const SVG = "http://www.w3.org/2000/svg";

export function layerDrawer(dom: LayerDom): LayerDrawer {
  // pinned: items the reader opened (by their words or their passage's tick) or asked; wanted: items to open once their
  // passage can show
  const pinned = new Set<string>(), wanted = new Set<string>();
  // an ask's sheet is open once asked, and a card's once turned over, unless the reader closed it or put it off
  const shut = new Set<string>();
  // cards opened while still to answer: their sheet shuts again once they are graded
  const asked = new Set<string>();
  // the card words on the page that open a sheet, and the ones under the pointer
  let targets: { key: string; range: Range; ids: string[] }[] = [];
  let hover: string | null = null, tints: Tints = { card: [], ask: [] };
  const heard = new WeakSet<object>();
  // where the reader dropped a sheet, kept while this source is open; and which sheet is on top
  const moved = new Map<string, { x: number; y: number }>();
  let order: string[] = [];
  let shown: { key: string; place: Place; dock: number; at: { x: number; y: number; w: number }; colour: string; host: HTMLElement }[] = [];
  let last: { items: readonly LayerItem[]; on: LayerIntents } | null = null;
  // each sheet's height, as its observer last reported it: read after layout, never forced
  const tall = new Map<string, number>();
  let watcher: ResizeObserver | null = null;
  function watch(key: string, host: HTMLElement): void {
    if (!watcher) {
      const RO = host.ownerDocument.defaultView?.ResizeObserver;
      if (!RO) return;
      watcher = new RO((seen) => {
        let moved_ = false;
        for (const e of seen) {
          const k = (e.target as HTMLElement).dataset.fold || "", h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
          if (tall.get(k) !== h) { tall.set(k, h); moved_ = true; }
        }
        if (moved_ && settle()) threads();
      });
    }
    if (host.dataset.watched !== key) { host.dataset.watched = key; watcher.observe(host); }
  }
  // sheets left where they landed don't cover one another: in reading order, each lies below any it would,
  // unless that takes it far from its words; then it stays by them, on top. True when a sheet moved
  function settle(): boolean {
    const free = shown.filter((s) => !moved.has(s.key)).sort((a, b) => a.dock - b.dock);
    const laid: { x: number; w: number; top: number; bottom: number }[] = [];
    let any = false;
    for (const s of free) {
      const h = tall.get(s.key) ?? 0, gap = 6 * s.place.unit;
      let y = s.dock;
      for (const p of laid) if (s.at.x < p.x + p.w && p.x < s.at.x + s.at.w && y < p.bottom + gap && y + h > p.top) y = p.bottom + gap;
      if (y - s.dock > PUSH * s.place.unit) y = s.dock;
      if (y !== s.at.y) { s.at = { ...s.at, y }; s.host.style.top = y + "px"; any = true; }
      laid.push({ x: s.at.x, w: s.at.w, top: y, bottom: y + h });
    }
    return any;
  }

  function stack(): void { shown.forEach((s) => { s.host.style.zIndex = String(41 + Math.max(0, order.indexOf(s.key))); }); }
  function raise(key: string): void { order = [...order.filter((k) => k !== key), key]; stack(); }

  function threads(): void {
    const t = shown.length ? dom.sheet(THREADS) : null;
    if (!t) return;
    t.host.classList.add("fold-threads");
    const doc = t.root.ownerDocument;
    let svg = t.root.querySelector<SVGSVGElement>(":scope > svg");
    if (!svg) { svg = doc.createElementNS(SVG, "svg") as SVGSVGElement; svg.setAttribute("style", "position:absolute;left:0;top:0;overflow:visible;"); svg.setAttribute("width", "1"); svg.setAttribute("height", "1"); t.root.append(svg); }
    svg.replaceChildren();
    const path = (d: string, colour: string, width: number, opacity: string) => {
      const e = doc.createElementNS(SVG, "path");
      e.setAttribute("d", d); e.setAttribute("fill", "none"); e.setAttribute("stroke", colour); e.setAttribute("stroke-width", String(width));
      e.setAttribute("stroke-linecap", "round"); e.setAttribute("stroke-linejoin", "round"); e.setAttribute("opacity", opacity);
      svg!.append(e);
    };
    for (const s of shown) {
      const th = threadOf(s.place, s.at), u = s.place.unit;
      if (th.caret) {
        const c = doc.createElementNS(SVG, "path");
        c.setAttribute("d", th.caret); c.setAttribute("fill", s.colour); c.setAttribute("stroke", "none");
        svg.append(c);
        continue;
      }
      if (th.bracket) path(th.bracket, s.colour, 2 * u, ".85");
      if (Math.hypot(th.to[0] - th.from[0], th.to[1] - th.from[1]) > 8 * u) path(th.thread, s.colour, 1.2 * u, ".5");
      const dot = doc.createElementNS(SVG, "circle");
      dot.setAttribute("cx", String(th.from[0])); dot.setAttribute("cy", String(th.from[1])); dot.setAttribute("r", String(2.6 * u)); dot.setAttribute("fill", s.colour);
      svg.append(dot);
    }
  }

  // a sheet is lifted by its strip and lies where it is dropped; a double-click puts it back on its passage
  function grip(key: string, host: HTMLElement, root: HTMLElement): void {
    const hd = root.querySelector<HTMLElement>(".fold-hd");
    if (!hd || hd.dataset.grip) return;
    hd.dataset.grip = "1";
    hd.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest("button"))) return;
      const s = shown.find((x) => x.key === key);
      if (!s) return;
      e.preventDefault();
      const per = s.place.perClient, from = { cx: e.clientX, cy: e.clientY, x: s.at.x, y: s.at.y };
      hd.setPointerCapture(e.pointerId);
      root.classList.add("lifted");
      const move = (m: PointerEvent) => {
        const x = from.x + (m.clientX - from.cx) * per, y = from.y + (m.clientY - from.cy) * per;
        const at = { x: Math.max(0, Math.min(x, s.place.width - s.at.w)), y: Math.max(0, y) };
        moved.set(key, at);
        s.at = { ...s.at, ...at };
        host.style.left = at.x + "px"; host.style.top = at.y + "px";
        threads();
      };
      const up = () => { root.classList.remove("lifted"); hd.removeEventListener("pointermove", move); hd.removeEventListener("pointerup", up); hd.removeEventListener("pointercancel", up); };
      hd.addEventListener("pointermove", move); hd.addEventListener("pointerup", up); hd.addEventListener("pointercancel", up);
    });
    hd.addEventListener("dblclick", (e) => { if (e.target instanceof Element && e.target.closest("button")) return; moved.delete(key); redraw(); });
    host.addEventListener("pointerdown", () => raise(key), true);
  }

  function draw(items: readonly LayerItem[], on: LayerIntents): void {
    last = { items, on };
    listen();
    const groups = new Map<string, { spot: Spot; items: LayerItem[] }>();
    // what shows: a card the reader opened from its words or turned over, what is being written or asked, and what the
    // reader opened; a sheet holds only what shows
    const open = new Set<string>(), shows = new Set<string>(), was = new Set(shown.map((s) => s.key));
    const wash: Tints = { card: [], ask: [], "card-done": [], "card-on": [] };
    for (const it of items) {
      const spot = dom.spotOf(it);
      if (!spot) continue;
      if (spot.tint && it.kind === "ask") wash.ask.push(spot.tint);
      if (spot.tint && it.kind === "card") (it.state === "done" ? wash["card-done"]! : wash.card).push(spot.tint);
      let g = groups.get(spot.key);
      if (!g) groups.set(spot.key, g = { spot, items: [] });
      g.items.push(it);
    }
    // cards whose words overlap are one place: a click on the shared words opens them together
    const byWords = [...groups.values()].filter((g) => g.spot.words && g.spot.tint);
    for (let a = 0; a < byWords.length; a++) for (let b = a + 1; b < byWords.length; b++) {
      const x = byWords[a], y = byWords[b];
      if (!groups.has(y.spot.key) || !groups.has(x.spot.key) || !overlaps(x.spot.tint!, y.spot.tint!)) continue;
      x.items.push(...y.items);
      groups.delete(y.spot.key);
    }
    targets = [];
    for (const [key, g] of groups) {
      if (g.spot.words && g.spot.tint && !g.spot.hidden) targets.push({ key, range: g.spot.tint, ids: g.items.map((it) => it.id) });
      for (const it of g.items) {
        if (it.kind === "card" && it.state === "done" && asked.has(it.id)) { asked.delete(it.id); pinned.delete(it.id); }
        const turned = it.kind === "card" && it.state === "revealed" && !shut.has(it.id);
        // an ask stays open once asked, so its answer and the next question have somewhere to be
        if (it.kind === "ask" && it.writing !== null && !shut.has(it.id) && !g.spot.hidden) pinned.add(it.id);
        const writing = (it.kind === "note" && it.editing) || it.kind === "draft" || (asking_(it) && !shut.has(it.id));
        if (!g.spot.hidden && wanted.has(it.id)) { opened(it); wanted.delete(it.id); }
        if (!g.spot.hidden && (turned || writing || pinned.has(it.id))) { open.add(key); shows.add(it.id); }
      }
    }
    for (const [key, g] of groups) if (open.has(key) && g.spot.words && g.spot.tint) wash["card-on"]!.push(g.spot.tint);
    // read every place before anything is drawn, so drawing one sheet never makes the next read wait on layout
    const places = new Map<string, Place | null>();
    for (const [key, g] of groups) if (open.has(key) && !g.spot.hidden) places.set(key, dom.place(g.spot));
    dom.clearTicks();
    const now: typeof shown = [];
    for (const [key, g] of groups) {
      const place = places.get(key) ?? null;
      const sheet = place ? dom.sheet(key) : null;
      if (!place || !sheet) {
        // a card's words are its own handle: nothing is added beside them
        if (g.spot.words) continue;
        const first = g.items[0];
        dom.tick(g.spot, g.items.map(markOf), peekOf(first), () => {
          // everything on the passage opens; a card still to answer shuts again once it is graded
          for (const it of g.items) { shut.delete(it.id); if (g.spot.hidden) wanted.add(it.id); else opened(it); }
          if (!g.spot.hidden) raise(key);
          draw(items, on);
        });
        continue;
      }
      const vis = g.items.filter((it) => shows.has(it.id)), hid = g.items.filter((it) => !shows.has(it.id));
      // what the open sheet doesn't hold is still marked beside its passage, and opens into the sheet
      if (hid.length && !g.spot.words) dom.tick(g.spot, hid.map(markOf), peekOf(hid[0]), () => { for (const it of hid) { shut.delete(it.id); opened(it); } raise(key); draw(items, on); });
      const n = vis.filter(said).length, cards = vis.filter((it) => it.kind === "card");
      const next = cards.findIndex(asking);
      const asks = vis.filter((it) => it.kind === "ask");
      const talks = asks.filter((it) => it.kind === "ask" && it.turns.length).length;
      sheet.host.dataset.fold = key;
      drawFold(sheet.root, {
        // each item names itself; the strip says only what a single item can't
        where: "",
        count: cards.length > 1 ? `${next >= 0 ? next + 1 : cards.length} of ${cards.length}` : n > 1 ? `${n} notes` : talks > 1 ? `${talks} conversations` : "",
        items: vis.map(({ anchor: _a, ...it }) => it as FoldNote | FoldCard | FoldDraft | FoldAsk),
      }, {
        ...on,
        // an item's buttons outlive this draw: they redraw whatever was drawn last
        later: (id) => { shut.add(id); pinned.delete(id); on.later(id); redraw(); },
        shut: () => {
          for (const it of g.items) pinned.delete(it.id);
          for (const it of g.items) if (it.kind === "card" || it.kind === "ask") shut.add(it.id);
          const mine = g.items.find((it) => it.kind === "note" && it.editing) as FoldNote | undefined;
          const draft = g.items.find((it) => it.kind === "draft");
          // words picked to ask about and never asked are let go with their sheet
          for (const it of g.items) if (it.kind === "ask" && !it.turns.length && it.writing === null) on.discard(it.id);
          // a card being written keeps its sheet open unless nothing was written yet
          if (draft) { const f = [...sheet.root.querySelectorAll<HTMLTextAreaElement>(".fi.draft textarea")]; if (f.every((t) => !t.value.trim())) on.discard(draft.id); else { pinned.add(draft.id); draw(items, on); } }
          else if (mine) on.leave(mine.id, sheet.root.querySelector<HTMLTextAreaElement>(".fi-edit")?.value ?? mine.text);
          else draw(items, on);
        },
      });
      grip(key, sheet.host, sheet.root);
      const at = { ...dockOf(place), ...(moved.get(key) ?? {}) };
      // a sheet dropped near an edge stays reachable when the window narrows
      at.x = Math.max(0, Math.min(at.x, place.width - at.w));
      sheet.host.style.left = at.x + "px"; sheet.host.style.top = at.y + "px"; sheet.host.style.width = at.w + "px";
      // a sheet is never taller than most of the window, at whatever scale it is drawn
      const win = sheet.root.ownerDocument.defaultView;
      if (win) sheet.root.style.setProperty("--fold-max", Math.round(win.innerHeight * 0.72 * place.perClient / place.unit) + "px");
      watch(key, sheet.host);
      if (!was.has(key) || !order.includes(key)) order = [...order.filter((k) => k !== key), key];
      now.push({ key, place, dock: at.y, at, colour: colourOf(vis), host: sheet.host });
    }
    shown = now;
    settle();
    order = order.filter((k) => shown.some((s) => s.key === k));
    stack();
    const keep = new Set(shown.map((s) => s.key));
    if (shown.length) keep.add(THREADS);
    dom.closeExcept(keep);
    tints = wash;
    paintTints();
    threads();
    on.drawn?.();
  }
  function opened(it: LayerItem): void {
    pinned.add(it.id);
    if (it.kind === "card" && it.state !== "done") asked.add(it.id);
  }
  function paintTints(): void {
    const on = hover ? targets.find((t) => t.key === hover)?.range : null;
    dom.tint?.(on ? { ...tints, "card-on": [...(tints["card-on"] ?? []), on] } : tints);
  }
  function hitAt(x: number, y: number): typeof targets {
    return targets.filter((t) => onWords(t.range.getClientRects(), x, y));
  }
  // a click on a card's words opens it, the way a reader's highlight does; a click on the page shuts the card sheets
  // that were opened that way and not moved; Esc does the same
  function listen(): void {
    const at = dom.surface?.();
    if (!at || heard.has(at)) return;
    heard.add(at);
    const doc = "defaultView" in at ? at : at.ownerDocument;
    const inSheet = (e: Event) => e.composedPath().some((n) => n instanceof Element && (n.classList.contains("fold") || n.classList.contains("ftick") || n.classList.contains("fpeek") || n.tagName === "STRATA-FOLD"));
    at.addEventListener("click", (ev) => {
      const e = ev as MouseEvent;
      if (!last || e.button !== 0 || inSheet(e)) return;
      if (doc.getSelection()?.isCollapsed === false) return;
      const hits = hitAt(e.clientX, e.clientY);
      if (hits.length) {
        const ids = new Set(hits.flatMap((h) => h.ids));
        for (const it of last.items) if (ids.has(it.id)) { shut.delete(it.id); opened(it); }
        raise(hits[0].key);
        draw(last.items, last.on);
        return;
      }
      if (shutWords()) draw(last.items, last.on);
    });
    let frame = 0, px = 0, py = 0;
    at.addEventListener("pointermove", (ev) => {
      const e = ev as PointerEvent;
      px = e.clientX; py = e.clientY;
      if (frame || e.pointerType === "touch") return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const hit = inSheet(e) ? null : hitAt(px, py)[0]?.key ?? null;
        if (hit === hover) return;
        hover = hit;
        const el = "defaultView" in at ? at.documentElement : at;
        el.style.cursor = hit ? "pointer" : "";
        paintTints();
      });
    });
    doc.addEventListener("keydown", (e) => { if (e.key === "Escape" && last && shutWords()) draw(last.items, last.on); });
  }
  function shutWords(): boolean {
    if (!last) return false;
    const words = new Set(targets.map((t) => t.key)), ids = new Set<string>();
    for (const s of shown) if (words.has(s.key) && !moved.has(s.key)) for (const t of targets) if (t.key === s.key) t.ids.forEach((id) => ids.add(id));
    for (const id of ids) { pinned.delete(id); shut.add(id); }
    return ids.size > 0;
  }
  function redraw(): void { if (last) draw(last.items, last.on); }
  return {
    draw,
    redraw,
    openFor: (ids) => { for (const id of ids) { wanted.add(id); shut.delete(id); } redraw(); },
    forget: () => {
      pinned.clear(); wanted.clear(); shut.clear(); asked.clear(); moved.clear(); tall.clear(); order = []; shown = []; last = null;
      targets = []; hover = null; tints = { card: [], ask: [] };
      watcher?.disconnect(); watcher = null;
      dom.closeExcept(new Set()); dom.clearTicks(); dom.tint?.({ card: [], ask: [], "card-done": [], "card-on": [] });
    },
  };
}

/** The words a card or a question sits on, washed in its layer's colour: highlights, so the page's DOM is not touched. */
export function tintWords(doc: Document | null, t: Tints): void {
  const reg = doc?.defaultView?.CSS?.highlights, H = doc?.defaultView?.Highlight;
  if (!reg || !H) return;
  for (const [kind, ranges] of Object.entries(t)) {
    if (!ranges?.length) { reg.delete("strata-" + kind); continue; }
    const h = new H(...ranges);
    // the open card's wash lies over the others
    if (kind === "card-on") h.priority = 2;
    reg.set("strata-" + kind, h);
  }
}
