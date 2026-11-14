// Runs inside the sandboxed page. Marks are CSS highlights; layers lie over the page, outside its body, and draw
// inside shadow roots, so the page's styles never reach them and its text walk never reads them.

import { STRATA, type Box, type FromPage, type LiveMark, type ToPage } from "./protocol.ts";
import { slugOf } from "../../../shared/reading/prose-slugs.ts";
import { findQuote } from "../../../shared/reading/quote.ts";
import { pageApi } from "./page-state.ts";
import { FOLD_CSS, clearTicks, drawTick } from "../fold/view.ts";
import { type LayerDom, type LayerItem, type Spot, THREADS, layerDrawer, tintWords } from "../fold/layers.ts";
import { compileQuote, widenQuote } from "../../../shared/reading/compile-quote.ts";

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]);
const OURS = "strata-fold, strata-layer";
const send = (m: FromPage) => parent.postMessage({ [STRATA]: m }, "*");

interface Walk { nodes: Text[]; starts: number[]; text: string }
// walked fresh each time: a page that redraws on input replaces its text nodes
function walk(): Walk {
  const nodes: Text[] = [], starts: number[] = [];
  let text = "";
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && SKIP.has(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) { nodes.push(n); starts.push(text.length); text += n.data; }
  return { nodes, starts, text };
}

function offsetOf(wk: Walk, node: Node, off: number): number {
  if (node.nodeType !== 3) {
    const point = document.createRange();
    point.setStart(node, off);
    const i = wk.nodes.findIndex((n) => point.comparePoint(n, 0) >= 0);
    return i < 0 ? wk.text.length : wk.starts[i];
  }
  const i = wk.nodes.indexOf(node as Text);
  return i < 0 ? -1 : wk.starts[i] + off;
}

function rangeAt(wk: Walk, start: number, end: number): Range | null {
  const at = (o: number, endSide: boolean): [Text, number] | null => {
    for (let i = 0; i < wk.nodes.length; i++) {
      const s = wk.starts[i], e = s + wk.nodes[i].data.length;
      if (o < e || (endSide && o === e)) return [wk.nodes[i], Math.max(0, o - s)];
    }
    return null;
  };
  const a = at(start, false), b = at(end, true);
  if (!a || !b) return null;
  const r = document.createRange();
  try { r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); } catch { return null; }
  return r;
}
const wordsAt = (wk: Walk, start: number, end: number, quote: string): Range | null => {
  const hit = wk.text.slice(start, end) === quote ? [start, end] : findQuote(wk.text, quote, start);
  return hit ? rangeAt(wk, hit[0], hit[1]) : null;
};

let marks: LiveMark[] = [], open: string | null = null;
const resolved = new Map<string, Range>();
const boxOutline = document.createElement("style");
const boxNamed = (id: string): Element | null => document.querySelector(`[data-strata-id="${CSS.escape(id)}"]`);
const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;

function paint() {
  resolved.clear();
  const wk = walk();
  const all: Range[] = [], noted: Range[] = [], on: Range[] = [];
  const boxes: string[] = [];
  for (const m of marks) {
    if (m.box) {
      if (boxNamed(m.box)) boxes.push(`[data-strata-id="${CSS.escape(m.box)}"]{outline:2px solid rgba(189,113,56,${m.id === open ? ".95" : m.note ? ".6" : ".35"});outline-offset:3px}`);
      continue;
    }
    const r = wordsAt(wk, m.start, m.end, m.quote);
    if (!r) continue;
    resolved.set(m.id, r);
    (m.id === open ? on : m.note ? noted : all).push(r);
  }
  boxOutline.textContent = boxes.join("\n");
  if (!H || !reg) return;
  reg.set("strata-mark", new H(...all));
  reg.set("strata-noted", new H(...noted));
  reg.set("strata-open", new H(...on));
}

let litTimer: ReturnType<typeof setTimeout> | undefined;
function reveal(n: number, quote: string | null, slug: string | null, box: string | null) {
  const wk = walk();
  let r: Range | null = null;
  const el = box ? boxNamed(box) : null;
  if (el) { r = document.createRange(); r.selectNodeContents(el); }
  const hit = !r && quote ? findQuote(wk.text, quote) : null;
  if (hit) r = rangeAt(wk, hit[0], hit[1]);
  if (!r && slug) {
    const h = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((el) => el.id === slug || slugOf(el.textContent || "") === slug);
    if (h) { r = document.createRange(); r.selectNodeContents(h); }
  }
  send({ t: "revealed", n, found: !!r });
  if (!r) return;
  for (let el = r.startContainer.parentElement; el; el = el.parentElement) if (el instanceof HTMLDetailsElement) el.open = true;
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  // the element, not the window: many pages scroll an inner container
  r.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  if (H && reg) {
    reg.set("strata-lit", new H(r));
    clearTimeout(litTimer);
    litTimer = setTimeout(() => reg.delete("strata-lit"), 2200);
  }
}

const boxOf = (b: DOMRect): Box => ({ left: b.left, top: b.top, width: b.width, height: b.height });

// a click on a box the page labelled offers it for a note, unless the click was meant for a control in it
const CONTROL = "a,button,input,select,textarea,label,summary,[contenteditable],[role=button]";
let pressed: { x: number; y: number; target: Element | null } | null = null;
function boxPicked(): Element | null {
  if (!pressed?.target || markAt(pressed.x, pressed.y) || pressed.target.closest(OURS)) return null;
  const el = pressed.target.closest("[data-strata-id]");
  return !el || pressed.target.closest(CONTROL) ? null : el;
}

function reportSelection() {
  if (pressed?.target?.closest(OURS)) return;
  const sel = getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !sel.toString().trim()) {
    const el = boxPicked();
    if (!el) { send({ t: "unsel" }); return; }
    const head = el.querySelector("h1,h2,h3,h4,h5,h6,b,strong");
    const label = ((head?.textContent || el.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 120) || (el.getAttribute("data-strata-id") || "");
    send({ t: "sel", start: 0, end: 0, quote: label, box: boxOf(el.getBoundingClientRect()), at: el.getAttribute("data-strata-id") });
    return;
  }
  const r = sel.getRangeAt(0), wk = walk();
  const start = offsetOf(wk, r.startContainer, r.startOffset), end = offsetOf(wk, r.endContainer, r.endOffset);
  if (start < 0 || end <= start) { send({ t: "unsel" }); return; }
  // the words a card made from this selection would sit on: grown until they are the page's alone
  const sep = blockText(wk), own = widenQuote(sep.text, sep.to(start), sep.to(end));
  send({ t: "sel", start, end, quote: wk.text.slice(start, end), box: boxOf(r.getBoundingClientRect()), own: own?.quote ?? null });
}

function markAt(x: number, y: number): string | null {
  for (const [id, r] of resolved) {
    for (const b of r.getClientRects()) if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return id;
  }
  for (const m of marks) {
    if (!m.box || !m.note) continue;
    const b = boxNamed(m.box)?.getBoundingClientRect();
    if (b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return m.id;
  }
  return null;
}

// ---- layers: the reader's notes and cards, laid over the page by the words they sit on ----

const TOKENS = `.strata-root{--ink:#2a241f;--ink-soft:#58514c;--ink-faint:#857f7a;--line:#e2ded7;--card-bg:#fffdfa;--accent:#41678a;--warn:#bd7138;--good:#587c5f;--fold-sunk:#f3f0e9;
--serif:"Spectral",Georgia,"Times New Roman",serif;--sans:"IBM Plex Sans",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace;
font:13px/1.4 var(--sans);color:var(--ink);text-align:left;letter-spacing:normal;text-transform:none;white-space:normal;}
.strata-root.fold{position:relative;}`;
let scale = 1;
// the page can't tell our elements from its own by tag alone, so its styles are kept out by the shadow root
function shadowHost(tag: string): { host: HTMLElement; root: HTMLElement } {
  const host = document.createElement(tag);
  host.style.cssText = "display:block;margin:0;padding:0;border:0;background:none;";
  const sh = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = FOLD_CSS + TOKENS;
  const root = document.createElement("div");
  root.className = "strata-root";
  sh.append(style, root);
  // typing in a fold must not reach the page's own shortcuts
  for (const ev of ["keydown", "keyup", "keypress"]) host.addEventListener(ev, (e) => e.stopPropagation());
  return { host, root };
}

interface PageSpot extends Spot { kind: "row" | "line" | "block" | "tab" | "app"; anchor: Element; lineEnd?: { node: Text; at: number } | null }
const keyOf = new WeakMap<Element, string>();
let keys = 0;
const keyFor = (el: Element) => { let k = keyOf.get(el); if (!k) keyOf.set(el, k = "p" + (++keys)); return k; };
const fillsWindow = () => document.documentElement.scrollHeight <= innerHeight + 2 && getComputedStyle(document.body).overflow === "hidden";

function hiddenPanel(n: Node): HTMLElement | null {
  for (let e: HTMLElement | null = n.nodeType === 1 ? n as HTMLElement : n.parentElement; e && e !== document.body; e = e.parentElement) {
    if (e.hidden || getComputedStyle(e).display === "none") return e;
  }
  return null;
}
function lineEnd(r: Range, pre: Element): { node: Text; at: number } | null {
  const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  let n = r.endContainer.nodeType === 3 ? r.endContainer as Text : null, from = n ? r.endOffset : 0;
  if (!n) { w.currentNode = r.endContainer; n = w.nextNode() as Text | null; }
  else w.currentNode = n;
  for (; n; n = w.nextNode() as Text | null, from = 0) { const i = n.data.indexOf("\n", from); if (i >= 0) return { node: n, at: i + 1 }; }
  return null;
}
// where the page may part: under a table row, after a line of code, or after the nearest block that stacks in its column
function boundary(r: Range): PageSpot | null {
  let el: Element | null = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer as Element : r.commonAncestorContainer.parentElement;
  if (!el) return null;
  const tr = el.closest("tr");
  if (tr) return { key: keyFor(tr), block: tr as HTMLElement, kind: "row", anchor: tr };
  const pre = el.closest("pre");
  if (pre) {
    const upTo = document.createRange(); upTo.setStart(pre, 0); upTo.setEnd(r.endContainer, r.endOffset);
    return { key: keyFor(pre) + ":" + upTo.toString().split("\n").length, block: pre as HTMLElement, kind: "line", anchor: pre, lineEnd: lineEnd(r, pre) };
  }
  const svg = el.closest("svg");
  if (svg) el = svg;
  for (; el && el !== document.body; el = el.parentElement) {
    const p = el.parentElement;
    if (!p) break;
    const cs = getComputedStyle(el), ps = getComputedStyle(p), pd = ps.display;
    const blocky = !cs.display.startsWith("inline") && cs.position !== "absolute" && cs.position !== "fixed" && cs.float === "none";
    const stacks = pd === "block" || pd === "flow-root" || pd === "list-item" || (pd.includes("flex") && ps.flexDirection.startsWith("column")) || (pd.includes("grid") && ps.gridTemplateColumns.split(" ").length < 2);
    if (blocky && stacks && el.tagName !== "SUMMARY") return { key: keyFor(el), block: el as HTMLElement, kind: "block", anchor: el };
  }
  return null;
}

// a card names its place by a quote or a heading's slug; one that names neither sits at the page's first words
// a card sits on its quote, compiled against the page's words like everywhere else, and nowhere if it doesn't compile
function cardRange(quote: string): Range | null {
  const wk = walk(), sep = blockText(wk), r = compileQuote(quote, { text: sep.text });
  return r.ok ? rangeAt(wk, sep.back(r.at.start), sep.back(r.at.end)) : null;
}

// the walk joins text nodes as they stand, so "<h1>Curve</h1><p>Each" reads "CurveEach": a quote is read with blocks apart
const BLOCKS = "p,li,dt,dd,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,caption,figcaption,div,section,article,header,footer,aside,nav,main,summary,label,button,option";
function blockText(wk: Walk): { text: string; back: (at: number) => number; to: (at: number) => number } {
  const starts: number[] = [];
  let text = "", last: Element | null = null;
  wk.nodes.forEach((n, i) => {
    const b = n.parentElement?.closest(BLOCKS) ?? null;
    if (i && b !== last) text += "\n";
    last = b; starts.push(text.length); text += n.data;
  });
  const back = (at: number): number => {
    let i = starts.length - 1;
    while (i > 0 && starts[i] > at) i--;
    return i < 0 ? at : wk.starts[i] + Math.min(at - starts[i], wk.nodes[i].data.length);
  };
  const to = (at: number): number => {
    let i = wk.starts.length - 1;
    while (i > 0 && wk.starts[i] > at) i--;
    return i < 0 ? at : starts[i] + (at - wk.starts[i]);
  };
  return { text, back, to };
}

const sheets = new Map<string, { host: HTMLElement; root: HTMLElement }>();
let overlay: { host: HTMLElement; root: HTMLElement } | null = null;
function ticksRoot(): HTMLElement {
  if (!overlay || !overlay.host.isConnected) {
    overlay = shadowHost("strata-layer");
    overlay.host.style.cssText += "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483000;";
    document.documentElement.append(overlay.host);
  }
  return overlay.root;
}
// the sheets lie on their own plane over the page, in the document's coordinates, so they scroll with it
let plane: HTMLElement | null = null;
function planeEl(): HTMLElement {
  if (!plane || !plane.isConnected) {
    plane = document.createElement("strata-layer");
    plane.style.cssText = "display:block;position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483001;";
    document.documentElement.append(plane);
  }
  return plane;
}

const pageDom: LayerDom = {
  spotOf(it: LayerItem): PageSpot | null {
    let r: Range | null = null;
    const boxEl = it.anchor.box ? boxNamed(it.anchor.box) : null;
    if (boxEl) { r = document.createRange(); r.selectNode(boxEl); }
    else if (it.kind === "card") r = cardRange(it.anchor.quote);
    else r = wordsAt(walk(), it.anchor.start, it.anchor.end, it.anchor.quote);
    if (!r) return null;
    const tint = (it.kind === "card" || it.kind === "ask") && !boxEl ? r : null;
    const hp = hiddenPanel(r.startContainer.nodeType === 1 && boxEl ? boxEl : r.startContainer);
    if (hp) {
      const tab = hp.id ? document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(hp.id)}"]`) : null;
      return tab ? { key: "tab:" + hp.id, block: tab, kind: "tab", anchor: tab, hidden: true, tint } : null;
    }
    if (fillsWindow()) {
      const at = boxEl ?? (r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer as Element : r.commonAncestorContainer.parentElement!);
      return { key: "app:" + keyFor(at), block: at as HTMLElement, kind: "app", anchor: at, tint };
    }
    if (boxEl) return { key: keyFor(boxEl), block: boxEl as HTMLElement, kind: "block", anchor: boxEl };
    const at = boundary(r);
    // a card lives on its own words: they are its place and open it
    if (at && it.kind === "card") return { ...at, key: "w:" + it.id, tint, words: true };
    return at ? { ...at, tint } : null;
  },
  place(s: Spot) {
    const spot = s as PageSpot, z = scale || 1, X = scrollX, Y = scrollY;
    const b = spot.block.getBoundingClientRect();
    if (spot.words && spot.tint) {
      const rs = [...spot.tint.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rs.length) return null;
      const bottom = Math.max(...rs.map((r) => r.bottom)), last = rs.filter((r) => r.bottom > bottom - 2);
      const wide = b.width >= 320 * z ? b : (spot.block.parentElement ?? spot.block).getBoundingClientRect();
      return {
        passage: { top: Math.min(...rs.map((r) => r.top)) + Y, bottom: bottom + Y, left: Math.min(...rs.map((r) => r.left)) + X, right: Math.max(...rs.map((r) => r.right)) + X },
        column: { left: wide.left + X, right: wide.right + X },
        hang: { x: Math.min(...last.map((r) => r.left)) + X, y: bottom + Y },
        width: document.documentElement.clientWidth, unit: z, perClient: 1,
      };
    }
    let bottom = b.bottom;
    // a card on a heading asks about the section under it: its sheet lies after that text, not over it
    if (/^H[1-6]$/.test(spot.block.tagName)) {
      let end: Element = spot.block;
      for (let n = spot.block.nextElementSibling; n && !/^H[1-6]$/.test(n.tagName); n = n.nextElementSibling) if (!n.matches(OURS)) end = n;
      if (end !== spot.block) bottom = end.getBoundingClientRect().bottom;
    }
    // a line of code: the sheet lies under that line, not under the whole block
    if (spot.kind === "line" && spot.lineEnd) {
      const at = document.createRange();
      at.setStart(spot.lineEnd.node, Math.min(spot.lineEnd.at, spot.lineEnd.node.length)); at.collapse(true);
      const lr = at.getClientRects()[0];
      if (lr && lr.top > b.top) bottom = lr.top;
    }
    const wide = spot.kind === "row" ? spot.block.closest("table") : b.width >= 320 * z ? null : spot.block.parentElement;
    const c = wide && wide !== document.documentElement ? wide.getBoundingClientRect() : b;
    const width = document.documentElement.clientWidth;
    return {
      passage: { top: b.top + Y, bottom: bottom + Y, left: b.left + X, right: b.right + X },
      column: { left: c.left + X, right: c.right + X },
      width, unit: z, perClient: 1,
      // a page that fills the window doesn't scroll: its sheet stays where it can be seen
      dock: spot.kind === "app" ? Math.min(bottom + 8 * z, innerHeight * 0.55) + Y : undefined,
    };
  },
  sheet(key) {
    const had = sheets.get(key);
    if (had && had.host.isConnected) { if (key !== THREADS) had.root.style.zoom = String(scale); return had; }
    const made = shadowHost("strata-fold");
    made.host.style.cssText += "position:absolute;left:0;top:0;";
    if (key !== THREADS) made.root.style.zoom = String(scale);
    planeEl().append(made.host);
    sheets.set(key, made);
    return made;
  },
  closeExcept(keep) {
    for (const [k, g] of sheets) if (!keep.has(k)) { g.host.remove(); sheets.delete(k); }
  },
  tint: (t) => tintWords(document, t),
  tick(s, kinds, peek, openIt) {
    const spot = s as PageSpot, root = ticksRoot(), z = scale || 1;
    root.style.zoom = String(z);
    const b = spot.block.getBoundingClientRect();
    const wrap = document.createElement("div");
    root.append(wrap);
    drawTick(wrap, spot.key, kinds, peek, () => { if (spot.kind === "tab") spot.block.click(); openIt(); });
    // a passage's tick hangs off its column's edge; a tab's or a box's sits on its corner
    const edge = spot.kind === "tab" || spot.kind === "app" ? b.right + 30 : Math.max(b.right, spot.block.parentElement?.getBoundingClientRect().right ?? b.right);
    wrap.style.cssText = `position:absolute;left:${(b.left + scrollX) / z}px;top:${(b.top + scrollY) / z}px;width:${Math.max(1, edge - b.left) / z}px;height:${b.height / z}px;pointer-events:none;`;
    for (const t of wrap.querySelectorAll<HTMLElement>(".ftick")) {
      t.style.pointerEvents = "auto";
      if (spot.kind === "tab" || spot.kind === "app") { t.style.bottom = "auto"; t.style.top = "-6px"; }
    }
  },
  clearTicks() { if (overlay) { clearTicks(overlay.root); overlay.root.replaceChildren(); } },
  surface: () => document,
};
const drawer = layerDrawer(pageDom);
let layerItems: LayerItem[] = [];
const intents = {
  edit: (id: string) => send({ t: "layer", intent: "edit", id }),
  leave: (id: string, text: string) => send({ t: "layer", intent: "leave", id, text }),
  remove: (id: string) => send({ t: "layer", intent: "remove", id }),
  reply: (id: string, text: string) => send({ t: "layer", intent: "reply", id, text }),
  show: (id: string) => send({ t: "layer", intent: "show", id }),
  later: (id: string) => send({ t: "layer", intent: "later", id }),
  grade: (id: string, got: boolean) => send({ t: "layer", intent: "grade", id, got }),
  keep: (id: string, text: string, back: string) => send({ t: "layer", intent: "keep", id, text, back }),
  discard: (id: string) => send({ t: "layer", intent: "discard", id }),
  ask: (id: string, text: string) => send({ t: "layer", intent: "ask", id, text }),
  capture: (id: string, turn: number) => send({ t: "layer", intent: "capture", id, text: String(turn) }),
};
// our own sheets going in or out must not wake the observer that redraws them
let redrawing = false;
function drawLayers() {
  redrawing = true;
  try { drawer.draw(layerItems, intents); } finally { queueMicrotask(() => { redrawing = false; }); }
}

const style = document.createElement("style");
style.textContent = `::highlight(strata-mark){background-color:rgba(255,214,64,.42)}
::highlight(strata-card){background-color:rgba(64,120,200,.13);text-decoration:underline dotted 2px rgba(65,103,138,.75)}
::highlight(strata-card-done){text-decoration:underline solid 2px rgba(88,124,95,.6)}
::highlight(strata-card-on){background-color:rgba(64,120,200,.26);text-decoration:underline solid 2px rgba(43,80,114,.95)}
::highlight(strata-ask){background-color:rgba(42,36,31,.09)}
::highlight(strata-noted){background-color:rgba(255,224,110,.45);text-decoration:underline 2px rgba(214,170,40,.8)}
::highlight(strata-open){background-color:rgba(255,206,60,.62);text-decoration:underline 2px rgba(170,120,20,.95)}
::highlight(strata-lit){background-color:rgba(90,150,255,.35)}
[data-strata-id]:hover{outline:1px dashed rgba(189,113,56,.45);outline-offset:3px}`;
document.head.appendChild(style);
document.head.appendChild(boxOutline);

// opened on its own (no reader around it) the page has nowhere to keep state
const state = pageApi(parent !== window ? send : null);
(window as Window & { strata?: unknown }).strata = state.api;

addEventListener("message", (e: MessageEvent) => {
  if (e.source !== parent) return;
  const m = (e.data || {})[STRATA] as ToPage | undefined;
  if (!m) return;
  if (state.hear(m)) return;
  if (m.t === "marks") { marks = m.marks; open = m.open; paint(); drawLayers(); }
  else if (m.t === "layers") { layerItems = m.items; scale = m.scale || 1; if (m.fresh) drawer.forget(); drawLayers(); }
  else if (m.t === "reveal") reveal(m.n, m.quote, m.slug, m.box ?? null);
  else if (m.t === "clear") getSelection()?.removeAllRanges();
});

addEventListener("pointerdown", (e) => {
  pressed = null;
  if (!(e.target instanceof Element && e.target.closest(OURS))) send({ t: "press" });
}, true);
addEventListener("mouseup", (e) => { pressed = { x: e.clientX, y: e.clientY, target: e.target instanceof Element ? e.target : null }; setTimeout(reportSelection, 0); });
let selT: ReturnType<typeof setTimeout> | undefined;
// touch has no mouseup: follow the handles, and speak once they settle
document.addEventListener("selectionchange", () => { clearTimeout(selT); selT = setTimeout(reportSelection, 320); });
addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest(OURS)) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  const id = markAt(e.clientX, e.clientY);
  if (id) send({ t: "mark", id });
});
// a redraw after input can move the words a mark sits on
let redraw: ReturnType<typeof setTimeout> | undefined;
const ours = (n: Node) => n.nodeType === 3 || (n.nodeType === 1 && ((n as Element).matches(OURS) || !!(n as Element).querySelector(OURS)));
new MutationObserver((ms) => {
  if (!marks.length && !layerItems.length) return;
  if (redrawing && ms.every((m) => m.type === "attributes" || [...m.addedNodes, ...m.removedNodes].every(ours))) return;
  clearTimeout(redraw);
  redraw = setTimeout(() => { paint(); drawLayers(); }, 150);
}).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "open", "aria-selected"] });
let resized: ReturnType<typeof setTimeout> | undefined;
addEventListener("resize", () => { clearTimeout(resized); resized = setTimeout(drawLayers, 120); });

// the page's own height, never the frame's, so a host may fit the frame to it without a loop
let tall = 0;
new ResizeObserver(() => {
  const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
  if (h !== tall) { tall = h; send({ t: "height", h }); }
}).observe(document.documentElement);

send({ t: "ready", words: walk().text.split(/\s+/).filter(Boolean).length });
