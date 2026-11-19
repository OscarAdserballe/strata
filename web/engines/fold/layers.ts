import { drawFold, drawTab, tabLabel, type FoldAsk, type FoldCard, type FoldDraft, type FoldIntents, type FoldNote, type TickMark } from "./view.ts";
import type { Anchor } from "../../../shared/reading/anchors.ts";

// One drawer for every kind of source: sheets level with their words in the margin, or tabs on the right edge without one.

/** Where a layer sits: offsets and words, a page's labelled box, or a PDF page and its lines as page fractions. */
export interface LayerAnchor {
  start: number; end: number; quote: string; box?: string | null; page?: number | null; rects?: readonly (readonly number[])[];
  /** a card made before cards kept their words: §, #slug, a time, a page or a quote, found the old way */
  legacy?: Anchor | null;
  /** the rendered block the words were picked in, while they are being written about */
  block?: number | null;
}
export type LayerItem = (FoldNote | FoldCard | FoldDraft | FoldAsk) & { anchor: LayerAnchor };
/** A passage layers hang on; `key` is stable while the passage is. `words`: the item's own words (its `tint`) are its
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
  /** the page has no margin of its own (a live page): every sheet starts as a tab on its right edge */
  rail?: boolean;
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
const SIDE_W = 300, MIN_W = 220, LEAD = 28, GAP = 8, TAB_H = 22, TAB_W = 150, HEAD = 16;

const said = (it: LayerItem) => it.kind === "note" && !!it.text.trim();
// a click on a said note's words opens it to read, like a card's; a bare highlight's opens it to write, in the reader
const handled = (it: LayerItem) => it.kind !== "note" || said(it);
const asking = (it: LayerItem) => it.kind === "card" && it.state !== "done";
const markOf = (it: LayerItem): TickMark => (it.kind === "note" ? "note" : it.kind === "ask" ? "ask" : it.kind === "card" && it.state === "done" ? "card-done" : "card");
// an ask with nothing said yet is being asked; one being answered stays open while the answer comes
const asking_ = (it: LayerItem) => it.kind === "ask" && (!it.turns.length || it.writing !== null);
const peekOf = (it: LayerItem): { kind: string; text: string } =>
  it.kind === "note" ? { kind: "note", text: it.text } : it.kind === "card" ? { kind: "card", text: it.q }
  : it.kind === "ask" ? { kind: "ask", text: it.turns[0]?.text ?? it.quote } : { kind: "card", text: it.quote };
const colourOf = (items: readonly LayerItem[]) =>
  items.some((it) => it.kind === "card" || it.kind === "draft") ? "var(--accent,#41678a)" : items.every((it) => it.kind === "ask") ? "var(--ink-soft,#58514c)" : "var(--warn,#bd7138)";
const kindOf = (items: readonly LayerItem[]) =>
  items.some((it) => it.kind === "card" || it.kind === "draft") ? "card" : items.every((it) => it.kind === "ask") ? "ask" : "note";

/** "beside": the margin right of the column holds a sheet; "rail": it doesn't, so tabs line the plane's right edge. */
export type Lay = "beside" | "rail";
export function layOf(p: Place, rail = false): Lay {
  return !rail && p.width - p.column.right >= (MIN_W + LEAD + 12) * p.unit ? "beside" : "rail";
}

/** Where an unmoved sheet lies: beside the column level with its words, or over the page on the right edge. */
export function dockOf(p: Place, lay: Lay): { x: number; y: number; w: number } {
  const u = p.unit;
  if (lay === "beside") {
    const x = p.column.right + LEAD * u;
    return { x, y: Math.max(0, p.passage.top - 4 * u), w: Math.max(MIN_W * u, Math.min(SIDE_W * u, p.width - x - 12 * u)) };
  }
  const w = Math.min(SIDE_W * u, p.width - 16 * u);
  return { x: Math.max(4 * u, p.width - w - 8 * u), y: p.dock ?? (p.hang ? p.hang.y + GAP * u : p.passage.top), w };
}

/** Where a tab lies: where its sheet would, level with its words; on the rail, its right end on the plane's edge. */
export function tabOf(p: Place, lay: Lay): { x: number; y: number; w: number } {
  const u = p.unit, y = Math.max(0, p.passage.top - 2 * u);
  return lay === "beside" ? { x: p.column.right + LEAD * u, y, w: TAB_W * u } : { x: p.width - (TAB_W + 8) * u, y, w: TAB_W * u };
}

/** The leader from the column's edge at the words' first line to the sheet's strip, bent when the sheet is not level. */
export function leaderOf(p: Place, at: { x: number; y: number; w: number }): { d: string; from: [number, number]; to: [number, number] } {
  const u = p.unit, line = p.passage.top + Math.min(10 * u, Math.max(0, (p.passage.bottom - p.passage.top) / 2));
  const fx = p.column.right + 6 * u, left = at.x + at.w / 2 < fx;
  const tx = left ? at.x + at.w : at.x, ty = at.y + HEAD * u;
  const d = Math.abs(ty - line) < 1 && !left ? `M${fx} ${line} H${tx}` : `M${fx} ${line} C${fx + (tx - fx) * 0.5} ${line} ${fx + (tx - fx) * 0.5} ${ty} ${tx} ${ty}`;
  return { d, from: [fx, line], to: [tx, ty] };
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
  // beside the column a sheet is open unless shut (shrunk to a tab); on the rail only once pinned (opened) or wanted
  const pinned = new Set<string>(), wanted = new Set<string>(), shut = new Set<string>();
  // cards opened on the rail while still to answer: their sheet goes back to its tab once they are graded
  const asked = new Set<string>();
  // the card words on the page that open a sheet, and the ones under the pointer
  let targets: { key: string; range: Range; ids: string[] }[] = [];
  let hover: string | null = null, tints: Tints = { card: [], ask: [] };
  // the card in hand: when the drill's keys move it, it opens; when a sheet's own buttons moved it, nothing opens by itself
  let hand: string | null = null, bySheet = 0;
  const heard = new WeakSet<object>();
  // where the reader dropped or sized a sheet, kept while this source is open; and which sheet is on top
  const moved = new Map<string, { x: number; y: number }>(), sized = new Map<string, { w: number; h: number }>();
  let order: string[] = [];
  type Shown = { key: string; place: Place; lay: Lay; dock: number; at: { x: number; y: number; w: number }; colour: string; host: HTMLElement; tab: boolean };
  let shown: Shown[] = [];
  let last: { items: readonly LayerItem[]; on: LayerIntents } | null = null;
  // each sheet's and tab's height, as its observer last reported it: read after layout, never forced
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
  // sheets and tabs left where they landed lie, in reading order, below any they would cover; true when one moved
  function settle(): boolean {
    const free = shown.filter((s) => !moved.has(s.key)).sort((a, b) => a.dock - b.dock || (a.tab ? 1 : 0) - (b.tab ? 1 : 0));
    const laid: { x: number; w: number; top: number; bottom: number }[] = [...shown.filter((s) => moved.has(s.key)).map((s) => ({ x: s.at.x, w: s.at.w, top: s.at.y, bottom: s.at.y + (tall.get(s.key) ?? 0) }))];
    let any = false;
    for (const s of free) {
      const h = tall.get(s.key) ?? (s.tab ? TAB_H * s.place.unit : 0), gap = 6 * s.place.unit;
      let y = s.dock;
      for (let again = true, n = 0; again && n < 50; n++) {
        again = false;
        for (const p of laid) if (s.at.x < p.x + p.w && p.x < s.at.x + s.at.w && y < p.bottom + gap && y + h + gap > p.top) { y = p.bottom + gap; again = true; }
      }
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
    // a sheet beside the column has a leader from its words' line; one over the page on the rail needs none
    for (const s of shown) {
      if (s.tab || s.lay !== "beside") continue;
      const l = leaderOf(s.place, s.at), u = s.place.unit;
      const e = doc.createElementNS(SVG, "path");
      e.setAttribute("d", l.d); e.setAttribute("fill", "none"); e.setAttribute("stroke", s.colour); e.setAttribute("stroke-width", String(1.2 * u));
      e.setAttribute("stroke-linecap", "round"); e.setAttribute("opacity", ".7");
      svg.append(e);
    }
  }

  // a sheet is lifted by its strip and lies where it is dropped, sized by its corner; a double-click puts it back
  function grip(key: string, host: HTMLElement, root: HTMLElement): void {
    const hd = root.querySelector<HTMLElement>(".fold-hd"), rs = root.querySelector<HTMLElement>(".fold-rs");
    if (!hd || hd.dataset.grip) return;
    hd.dataset.grip = "1";
    const drag = (on: HTMLElement, e: PointerEvent, cls: string, step: (s: Shown, dx: number, dy: number, from: { x: number; y: number; w: number; h: number }) => void) => {
      const s = shown.find((x) => x.key === key);
      if (!s) return;
      e.preventDefault();
      const per = s.place.perClient, from = { cx: e.clientX, cy: e.clientY, x: s.at.x, y: s.at.y, w: s.at.w, h: tall.get(key) ?? host.offsetHeight };
      on.setPointerCapture(e.pointerId);
      root.classList.add(cls);
      const move = (m: PointerEvent) => { step(s, (m.clientX - from.cx) * per, (m.clientY - from.cy) * per, from); threads(); };
      const up = () => { root.classList.remove(cls); on.removeEventListener("pointermove", move); on.removeEventListener("pointerup", up); on.removeEventListener("pointercancel", up); };
      on.addEventListener("pointermove", move); on.addEventListener("pointerup", up); on.addEventListener("pointercancel", up);
    };
    hd.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest("button"))) return;
      drag(hd, e, "lifted", (s, dx, dy, from) => {
        const at = { x: Math.max(0, Math.min(from.x + dx, s.place.width - s.at.w)), y: Math.max(0, from.y + dy) };
        moved.set(key, at);
        s.at = { ...s.at, ...at };
        host.style.left = at.x + "px"; host.style.top = at.y + "px";
      });
    });
    rs?.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      drag(rs, e, "sizing", (s, dx, dy, from) => {
        const u = s.place.unit, w = Math.max(200 * u, Math.min(from.w + dx, s.place.width - s.at.x - 4 * u)), h = Math.max(60 * u, from.h + dy);
        sized.set(key, { w, h });
        s.at = { ...s.at, w };
        host.style.width = w + "px";
        fit(root, sized.get(key), s.place);
      });
    });
    hd.addEventListener("dblclick", (e) => { if (e.target instanceof Element && e.target.closest("button")) return; moved.delete(key); redraw(); });
    host.addEventListener("pointerdown", () => raise(key), true);
  }
  function fit(root: HTMLElement, size: { w: number; h: number } | undefined, place: Place): void {
    const inner = root.querySelector<HTMLElement>(":scope > .fold-in");
    if (!inner) return;
    inner.style.height = size ? size.h / place.unit + "px" : "";
    inner.style.maxHeight = size ? "none" : "";
  }

  function draw(items: readonly LayerItem[], on: LayerIntents): void {
    last = { items, on };
    listen();
    const held = items.find((it) => it.kind === "card" && it.held)?.id ?? null;
    if (held !== hand) {
      if (hand !== null && held !== null && Date.now() - bySheet > 1500) wanted.add(held);
      hand = held;
    }
    const groups = new Map<string, { spot: Spot; items: LayerItem[] }>();
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
    const byWords = [...groups.values()].filter((g) => g.spot.words && g.spot.tint && g.items.every(handled));
    for (let a = 0; a < byWords.length; a++) for (let b = a + 1; b < byWords.length; b++) {
      const x = byWords[a], y = byWords[b];
      if (!groups.has(y.spot.key) || !groups.has(x.spot.key) || !overlaps(x.spot.tint!, y.spot.tint!)) continue;
      x.items.push(...y.items);
      groups.delete(y.spot.key);
    }
    // read every place before anything is drawn, so drawing one sheet never makes the next read wait on layout
    const places = new Map<string, Place | null>();
    for (const [key, g] of groups) if (!g.spot.hidden) places.set(key, dom.place(g.spot));
    targets = [];
    const shows = new Set<string>(), open = new Set<string>(), was = new Set(shown.map((s) => s.key));
    for (const [key, g] of groups) {
      if (g.spot.words && g.spot.tint && !g.spot.hidden && g.items.some(handled)) targets.push({ key, range: g.spot.tint, ids: g.items.filter(handled).map((it) => it.id) });
      const place = places.get(key), beside = !!place && layOf(place, dom.rail) === "beside";
      for (const it of g.items) {
        if (it.kind === "card" && it.state === "done" && asked.has(it.id)) { asked.delete(it.id); pinned.delete(it.id); }
        // an ask stays open once asked, so its answer and the next question have somewhere to be
        if (it.kind === "ask" && it.writing !== null && !shut.has(it.id) && !g.spot.hidden) pinned.add(it.id);
        const writing = (it.kind === "note" && it.editing) || it.kind === "draft" || (asking_(it) && !shut.has(it.id));
        if (!g.spot.hidden && wanted.has(it.id)) { opened(it); wanted.delete(it.id); }
        if (!g.spot.hidden && (writing || pinned.has(it.id) || (beside && !shut.has(it.id)))) { shows.add(it.id); open.add(key); }
      }
    }
    for (const [key, g] of groups) if (open.has(key) && g.spot.words && g.spot.tint && g.items.some((it) => it.kind === "card")) wash["card-on"]!.push(g.spot.tint);
    dom.clearTicks();
    const now: Shown[] = [];
    const strip = (xs: LayerItem[]) => xs.map(({ anchor: _a, ...it }) => it as FoldNote | FoldCard | FoldDraft | FoldAsk);
    for (const [key, g] of groups) {
      const place = places.get(key) ?? null;
      if (!place) {
        // a passage in a panel the page keeps shut: a tick on the panel's tab opens the panel, then the sheet
        if (g.spot.hidden) dom.tick(g.spot, g.items.map(markOf), peekOf(g.items[0]), () => {
          for (const it of g.items) { shut.delete(it.id); wanted.add(it.id); }
          draw(items, on);
        });
        continue;
      }
      const lay = layOf(place, dom.rail), u = place.unit;
      const vis = g.items.filter((it) => shows.has(it.id)), hid = g.items.filter((it) => !shows.has(it.id));
      // what isn't open is a tab level with its words, and opens into a sheet
      const tk = "t:" + key, tab = hid.length ? dom.sheet(tk) : null;
      if (tab) {
        drawTab(tab.root, kindOf(hid), tabLabel(strip(hid)), () => { for (const it of hid) { shut.delete(it.id); opened(it); } raise(key); draw(items, on); });
        const at = tabOf(place, lay);
        // a tab on the rail is held by its right end, so it needs no measuring
        tab.host.style.left = (lay === "rail" ? place.width - 8 * u : at.x) + "px";
        tab.host.style.transform = lay === "rail" ? "translateX(-100%)" : "";
        tab.host.style.top = at.y + "px";
        tab.host.dataset.fold = tk;
        tab.host.classList.add("ftab-at");
        watch(tk, tab.host);
        if (!was.has(tk) || !order.includes(tk)) order = [...order.filter((k) => k !== tk), tk];
        now.push({ key: tk, place, lay, dock: at.y, at, colour: colourOf(hid), host: tab.host, tab: true });
      }
      const sheet = vis.length ? dom.sheet(key) : null;
      if (!sheet) continue;
      const n = vis.filter(said).length, cards = vis.filter((it) => it.kind === "card");
      const next = cards.findIndex(asking);
      const asks = vis.filter((it) => it.kind === "ask");
      const talks = asks.filter((it) => it.kind === "ask" && it.turns.length).length;
      sheet.host.dataset.fold = key;
      drawFold(sheet.root, {
        // each item names itself; the strip says only what a single item can't
        where: "",
        count: cards.length > 1 ? `${next >= 0 ? next + 1 : cards.length} of ${cards.length}` : n > 1 ? `${n} notes` : talks > 1 ? `${talks} conversations` : "",
        items: strip(vis),
      }, {
        ...on,
        // an item's buttons outlive this draw: they redraw whatever was drawn last
        later: (id) => { bySheet = Date.now(); shut.add(id); pinned.delete(id); on.later(id); redraw(); },
        grade: (id, got) => { bySheet = Date.now(); on.grade(id, got); },
        show: (id) => { bySheet = Date.now(); on.show(id); },
        // shrinks the sheet to its tab: it stays a tab until opened again
        shut: () => {
          for (const it of g.items) { pinned.delete(it.id); shut.add(it.id); }
          const mine = g.items.find((it) => it.kind === "note" && it.editing) as FoldNote | undefined;
          const draft = g.items.find((it) => it.kind === "draft");
          // words picked to ask about and never asked are let go with their sheet
          for (const it of g.items) if (it.kind === "ask" && !it.turns.length && it.writing === null) on.discard(it.id);
          // a card being written keeps its sheet open unless nothing was written yet
          if (draft) { const f = [...sheet.root.querySelectorAll<HTMLTextAreaElement>(".fi.draft textarea")]; if (f.every((t) => !t.value.trim())) on.discard(draft.id); else { shut.delete(draft.id); pinned.add(draft.id); draw(items, on); } }
          else if (mine) on.leave(mine.id, sheet.root.querySelector<HTMLTextAreaElement>(".fi-edit")?.value ?? mine.text);
          else draw(items, on);
        },
      });
      grip(key, sheet.host, sheet.root);
      const size = sized.get(key);
      const at = { ...dockOf(place, lay), ...(size ? { w: size.w } : {}), ...(moved.get(key) ?? {}) };
      // a sheet dropped near an edge stays reachable when the window narrows
      at.x = Math.max(0, Math.min(at.x, place.width - at.w));
      sheet.host.style.left = at.x + "px"; sheet.host.style.top = at.y + "px"; sheet.host.style.width = at.w + "px";
      fit(sheet.root, size, place);
      // a sheet is never taller than most of the window, at whatever scale it is drawn
      const win = sheet.root.ownerDocument.defaultView;
      if (win) sheet.root.style.setProperty("--fold-max", Math.round(win.innerHeight * 0.72 * place.perClient / place.unit) + "px");
      watch(key, sheet.host);
      if (!was.has(key) || !order.includes(key)) order = [...order.filter((k) => k !== key), key];
      now.push({ key, place, lay, dock: at.y, at, colour: colourOf(vis), host: sheet.host, tab: false });
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
  // a click on a card's or a note's words opens its sheet, the way a reader's highlight does; it stays open until shrunk
  function listen(): void {
    const at = dom.surface?.();
    if (!at || heard.has(at)) return;
    heard.add(at);
    const doc = "defaultView" in at ? at : at.ownerDocument;
    const inSheet = (e: Event) => e.composedPath().some((n) => n instanceof Element && (n.classList.contains("fold") || n.classList.contains("ftab-at") || n.classList.contains("ftick") || n.classList.contains("fpeek") || n.tagName === "STRATA-FOLD"));
    at.addEventListener("click", (ev) => {
      const e = ev as MouseEvent;
      if (!last || e.button !== 0 || inSheet(e)) return;
      if (doc.getSelection()?.isCollapsed === false) return;
      const hits = hitAt(e.clientX, e.clientY);
      if (!hits.length) return;
      const ids = new Set(hits.flatMap((h) => h.ids));
      for (const it of last.items) if (ids.has(it.id)) { shut.delete(it.id); opened(it); }
      raise(hits[0].key);
      draw(last.items, last.on);
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
  }
  function redraw(): void { if (last) draw(last.items, last.on); }
  return {
    draw,
    redraw,
    openFor: (ids) => { for (const id of ids) { wanted.add(id); shut.delete(id); } redraw(); },
    forget: () => {
      pinned.clear(); wanted.clear(); shut.clear(); asked.clear(); moved.clear(); sized.clear(); tall.clear(); order = []; shown = []; last = null;
      targets = []; hover = null; tints = { card: [], ask: [] }; hand = null; bySheet = 0;
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
