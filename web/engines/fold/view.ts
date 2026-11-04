// The fold and the tick, drawn from values with plain DOM: the reader mounts them in its own page,
// and a live page's bridge mounts the very same view inside the page, where React can't reach.

export interface FoldReply { who: "you" | "agent"; text: string }
export interface FoldNote { kind: "note"; id: string; quote: string; text: string; editing: boolean; replies: FoldReply[] }
/** A card on a passage: its sheet is open until it is graded or closed. */
export interface FoldCard {
  kind: "card"; id: string; where: string; q: string;
  /** the host draws the card's face into a slot (maths and all); without one the question and answer are text */
  face: boolean;
  /** the card in hand: the drill's keys act on it */
  held: boolean;
  /** the answer as text, shown when turned over on a page with no slot for the face */
  a?: string;
  state: "asking" | "revealed" | "done"; got: boolean | null; mcq: boolean;
}
/** A card being written from a selection, by you: it is saved only when kept. */
export interface FoldDraft { kind: "draft"; id: string; quote: string }
/** A conversation at words: your questions and the model's answers, the one being written last. */
export interface FoldAsk {
  kind: "ask"; id: string; quote: string; turns: { who: "you" | "claude"; text: string }[];
  /** the answer as it streams in */
  writing: string | null;
  error: string;
  /** a question to put back in the line after it failed */
  again: string;
  /** answers are left as empty slots ([data-say]) for the host to draw */
  rich?: boolean;
}
export type FoldItem = FoldNote | FoldCard | FoldDraft | FoldAsk;
export interface FoldModel { where: string; count: string; items: FoldItem[] }
export interface FoldIntents {
  shut(): void;
  edit(id: string): void;
  /** the editor was left: by blur, Esc or ⌘↵; the text is whatever it holds */
  leave(id: string, text: string): void;
  remove(id: string): void;
  /** said under a note; sent at once, there are no drafts */
  reply(id: string, text: string): void;
  /** a card: turn it over, leave it for later, or grade it once turned */
  show(id: string): void;
  later(id: string): void;
  grade(id: string, got: boolean): void;
  /** a card written from a selection: kept with what its two faces hold, or let go */
  keep(id: string, front: string, back: string): void;
  discard(id: string): void;
  /** a question at an ask's words, the first or a follow-up */
  ask(id: string, text: string): void;
  /** an answer in an ask, made into a card (its question on the front) */
  capture(id: string, turn: number): void;
}
export type TickMark = "note" | "card" | "card-done" | "ask";

// an answer's markdown, built as nodes (never as HTML): paragraphs, lists, **bold**, *italic* and `code`
function mdInto(host: HTMLElement, text: string): HTMLElement {
  const doc = host.ownerDocument;
  const inline = (into: HTMLElement, s: string) => {
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
    let at = 0;
    for (const m of s.matchAll(re)) {
      if (m.index! > at) into.append(s.slice(at, m.index));
      const t = m[0];
      into.append(t.startsWith("**") ? el(doc, "b", "", t.slice(2, -2)) : t.startsWith("`") ? el(doc, "code", "", t.slice(1, -1)) : el(doc, "i", "", t.slice(1, -1)));
      at = m.index! + t.length;
    }
    if (at < s.length) into.append(s.slice(at));
  };
  for (const block of text.trim().split(/\n{2,}/)) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
      const list = el(doc, /^\s*\d/.test(lines[0]) ? "ol" : "ul", "");
      for (const l of lines) { const li = el(doc, "li", ""); inline(li, l.replace(/^\s*([-*•]|\d+[.)])\s+/, "")); list.append(li); }
      host.append(list);
    } else {
      const p = el(doc, "p", "");
      lines.forEach((l, i) => { if (i) p.append(el(doc, "br", "")); inline(p, l.replace(/^#+\s+/, "")); });
      host.append(p);
    }
  }
  return host;
}

function askTurns(doc: Document, it: FoldAsk, on: FoldIntents): HTMLElement {
  const box = el(doc, "div", "fi-turns");
  const turn = (who: "you" | "claude", text: string, cls = "", at = -1, slot = "") => {
    const t = el(doc, "div", "fi-turn " + who + cls);
    const head = el(doc, "span", "fi-who", who === "you" ? "you" : "Claude");
    if (at >= 0) { const mk = el(doc, "button", "fi-mk", "make a card"); mk.type = "button"; mk.onclick = () => on.capture(it.id, at); head.append(mk); }
    let say: HTMLElement;
    if (who === "you") say = el(doc, "p", "fi-say", text);
    else if (it.rich && slot) { say = el(doc, "div", "fi-say"); say.dataset.say = slot; }
    else say = mdInto(el(doc, "div", "fi-say md"), text);
    t.append(head, say);
    box.append(t);
  };
  it.turns.forEach((t, i) => turn(t.who, t.text, "", t.who === "claude" ? i : -1, `${it.id}:${i}`));
  if (it.writing !== null) turn("claude", it.writing || "…", " writing", -1, it.writing ? `${it.id}:w` : "");
  if (it.error) box.append(el(doc, "p", "fi-err", it.error));
  return box;
}

const el = <K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + "…" : s);

function noteItem(doc: Document, it: FoldNote, on: FoldIntents): HTMLElement {
  const box = el(doc, "div", "fi note");
  const lab = el(doc, "div", "fi-lab");
  lab.append(el(doc, "b", "", "NOTE"), el(doc, "i", "", `“${short(it.quote.replace(/\s+/g, " ").trim(), 60)}”`));
  const last = it.replies[it.replies.length - 1];
  if (last && last.who === "agent") lab.append(el(doc, "span", "fi-st", "agent replied"));
  box.append(lab);
  if (!it.editing) {
    const p = el(doc, "p", "fi-note", it.text);
    p.title = "click to edit";
    p.onclick = () => on.edit(it.id);
    box.append(p);
    for (const r of it.replies) {
      const t = el(doc, "div", "fi-turn " + r.who);
      t.append(el(doc, "span", "fi-who", r.who), el(doc, "p", "fi-say", r.text));
      box.append(t);
    }
    if (it.text.trim()) box.append(replyRow(doc, it.id, on));
    return box;
  }
  const ta = el(doc, "textarea", "fi-edit");
  ta.value = it.text;
  ta.rows = 2;
  ta.placeholder = "what do you want to say about this?";
  const bar = el(doc, "div", "fi-bar");
  const rm = el(doc, "button", "fi-rm", "remove highlight");
  // mousedown, not click: the textarea's blur leaves the editor before a click lands
  rm.onmousedown = (e) => { e.preventDefault(); on.remove(it.id); };
  bar.append(el(doc, "em", "", "esc saves"), rm);
  box.append(ta, bar);
  let left = false;
  const leave = () => { if (left) return; left = true; on.leave(it.id, ta.value); };
  ta.addEventListener("blur", leave);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) { e.preventDefault(); e.stopPropagation(); leave(); }
  });
  queueMicrotask(() => { if (!left) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); } });
  return box;
}

function replyRow(doc: Document, id: string, on: FoldIntents): HTMLElement {
  const row = el(doc, "div", "fi-reply");
  const ta = el(doc, "textarea", "fi-field");
  ta.rows = 1;
  ta.placeholder = "reply…";
  const send = el(doc, "button", "fi-send", "Send");
  const go = () => { const v = ta.value.trim(); if (!v) return; ta.value = ""; on.reply(id, v); };
  send.onclick = go;
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });
  row.append(ta, send);
  return row;
}

function cardItem(doc: Document, it: FoldCard, on: FoldIntents): HTMLElement {
  if (it.state === "done" && !it.held) {
    const line = el(doc, "div", "fi line card");
    line.append(el(doc, "span", "fi-ck", "✓"), el(doc, "span", "fi-lq", it.q), el(doc, "span", "fi-r", it.got === null ? "seen" : it.got ? "got it" : "not yet"));
    return line;
  }
  const box = el(doc, "div", "fi card" + (it.held ? " hand" : ""));
  const lab = el(doc, "div", "fi-lab");
  lab.append(el(doc, "b", "", "CARD"), el(doc, "i", "", it.where));
  box.append(lab);
  if (it.face) {
    const face = el(doc, "div", "fi-face");
    face.dataset.face = it.id;
    if (it.held) face.dataset.hand = it.id;
    box.append(face);
  } else {
    box.append(el(doc, "div", "fq", it.q));
    if (it.state === "revealed" && it.a) box.append(mdInto(el(doc, "div", "fi-a md"), it.a));
  }
  const acts = el(doc, "div", "fi-acts");
  const btn = (cls: string, text: string, fn: () => void) => { const b = el(doc, "button", cls, text); b.type = "button"; b.onclick = fn; acts.append(b); };
  if (it.state === "asking") {
    if (!it.mcq || !it.held) btn("fi-pri", "Show answer", () => on.show(it.id));
    btn("fi-lnk", "later", () => on.later(it.id));
  } else if (it.state === "revealed") {
    btn("fi-good", "Got it", () => on.grade(it.id, true));
    btn("fi-pill", "Not yet", () => on.grade(it.id, false));
  }
  if (acts.childElementCount) box.append(acts);
  return box;
}

function draftItem(doc: Document, it: FoldDraft, on: FoldIntents): HTMLElement {
  const box = el(doc, "div", "fi card draft");
  const lab = el(doc, "div", "fi-lab");
  lab.append(el(doc, "b", "", "NEW CARD"), el(doc, "i", "", `“${short(it.quote.replace(/\s+/g, " ").trim(), 60)}”`));
  const face = (cls: string, hint: string) => { const t = el(doc, "textarea", "fi-edit " + cls); t.rows = 2; t.placeholder = hint; return t; };
  const front = face("fi-front", "the question this passage answers");
  const back = face("fi-back", "its answer");
  const bar = el(doc, "div", "fi-acts");
  const keep = el(doc, "button", "fi-pri fi-keep", "Keep");
  const drop = el(doc, "button", "fi-lnk fi-drop", "discard");
  keep.type = drop.type = "button";
  const go = () => { if (front.value.trim()) on.keep(it.id, front.value.trim(), back.value.trim()); else front.focus(); };
  keep.onclick = go;
  drop.onclick = () => on.discard(it.id);
  const keys = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); }
    else if (e.key === "Escape" && !front.value.trim() && !back.value.trim()) { e.preventDefault(); on.discard(it.id); }
  };
  front.addEventListener("keydown", keys);
  back.addEventListener("keydown", keys);
  bar.append(keep, drop, el(doc, "em", "fi-hint", "⌘↵ keeps"));
  box.append(lab, front, back, bar);
  queueMicrotask(() => { if (!box.contains(doc.activeElement)) front.focus({ preventScroll: true }); });
  return box;
}

function askItem(doc: Document, it: FoldAsk, on: FoldIntents): HTMLElement {
  const box = el(doc, "div", "fi asked");
  const lab = el(doc, "div", "fi-lab");
  lab.append(el(doc, "b", "", "ASK"), el(doc, "i", "", `“${short(it.quote.replace(/\s+/g, " ").trim(), 60)}”`));
  const row = el(doc, "div", "fi-reply");
  const ta = el(doc, "textarea", "fi-field fi-q");
  ta.rows = 1;
  ta.placeholder = it.turns.length || it.writing !== null ? "ask a follow-up…" : "ask about these words…";
  ta.value = it.again;
  const send = el(doc, "button", "fi-send", "Send");
  send.type = "button";
  const go = () => { const v = ta.value.trim(); if (!v) return; ta.value = ""; on.ask(it.id, v); };
  send.onclick = go;
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); }
    else if (e.key === "Escape" && !ta.value.trim() && !box.querySelector(".fi-turn")) { e.preventDefault(); on.discard(it.id); }
  });
  row.append(ta, send);
  box.append(lab, askTurns(doc, it, on), row);
  if (!it.turns.length && it.writing === null) queueMicrotask(() => { if (!box.contains(doc.activeElement)) ta.focus({ preventScroll: true }); });
  return box;
}

// a draft's faces are the reader's until kept: its values never redraw it
const signature = (it: FoldItem) => (it.kind === "draft" ? it.id + it.quote : JSON.stringify(it));

/** Draws a fold into its host; items whose values didn't change are left alone, and an editor being typed in is never rebuilt. */
export function drawFold(host: HTMLElement, m: FoldModel, on: FoldIntents): void {
  const doc = host.ownerDocument;
  let inner = host.querySelector<HTMLElement>(":scope > .fold-in");
  if (!inner) {
    inner = el(doc, "div", "fold-in");
    const hd = el(doc, "div", "fold-hd");
    const shut = el(doc, "button", "fold-shut", "×");
    shut.type = "button";
    shut.title = "close to its tick";
    shut.setAttribute("aria-label", "close");
    const grip = el(doc, "i", "fold-grip");
    grip.setAttribute("aria-hidden", "true");
    hd.title = "drag to move · double-click to put back";
    hd.append(grip, el(doc, "span", "fold-where"), el(doc, "span", "fold-grow"), el(doc, "span", "fold-count"), shut);
    inner.append(hd);
    host.append(inner);
  }
  host.classList.add("fold");
  (inner.querySelector(".fold-where") as HTMLElement).textContent = m.where;
  const count = inner.querySelector(".fold-count") as HTMLElement;
  count.textContent = m.count;
  const cards = m.items.some((it) => it.kind === "card" || it.kind === "draft"), asks = m.items.every((it) => it.kind === "ask");
  count.classList.toggle("cards", cards);
  count.classList.toggle("asks", asks);
  host.dataset.kind = cards ? "card" : asks ? "ask" : "note";
  (inner.querySelector(".fold-shut") as HTMLButtonElement).onclick = () => on.shut();
  const kept = new Map<string, HTMLElement>();
  for (const c of inner.querySelectorAll<HTMLElement>(":scope > .fi")) kept.set(c.dataset.id || "", c);
  let prev: Element = inner.firstElementChild as Element;
  for (const it of m.items) {
    const was = kept.get(it.id);
    kept.delete(it.id);
    // a note being written, or a reply being typed, is never rebuilt under the caret
    const typing = it.kind === "note" && !!was && was.contains(doc.activeElement) && !!doc.activeElement && doc.activeElement.tagName === "TEXTAREA"
      && (it.editing ? !!was.querySelector(".fi-edit") : !!was.querySelector(".fi-field") && (doc.activeElement as HTMLTextAreaElement).value.trim() !== "");
    let node = was;
    // a conversation redraws its turns as the answer streams, never the line being typed in
    if (it.kind === "ask" && was && was.classList.contains("asked") && was.dataset.sig !== signature(it)) {
      was.querySelector(".fi-turns")?.replaceWith(askTurns(doc, it, on));
      const ta = was.querySelector<HTMLTextAreaElement>(".fi-q");
      if (ta && it.again && !ta.value) ta.value = it.again;
      if (ta) ta.placeholder = it.turns.length || it.writing !== null ? "ask a follow-up…" : "ask about these words…";
      was.dataset.sig = signature(it);
    } else if (!was || (!typing && was.dataset.sig !== signature(it))) {
      node = it.kind === "card" ? cardItem(doc, it, on) : it.kind === "draft" ? draftItem(doc, it, on) : it.kind === "ask" ? askItem(doc, it, on) : noteItem(doc, it, on);
      node.dataset.id = it.id;
      node.dataset.sig = signature(it);
      if (was) was.replaceWith(node);
    }
    if (prev.nextElementSibling !== node) prev.after(node!);
    prev = node!;
  }
  for (const stale of kept.values()) stale.remove();
}

/** A shut fold: a few marks at the end of its passage, and the line it would open to, shown on hover. */
export function drawTick(block: HTMLElement, key: string, marks: readonly TickMark[], peek: { kind: string; text: string }, open: () => void): void {
  const doc = block.ownerDocument;
  block.classList.add("fold-anchor");
  const t = el(doc, "button", "ftick");
  t.dataset.tick = key;
  t.type = "button";
  t.setAttribute("aria-label", `open what is under this passage (${marks.length})`);
  for (const k of marks) t.append(el(doc, "i", "fmk " + k));
  t.onclick = (e) => { e.stopPropagation(); open(); };
  const p = el(doc, "span", "fpeek");
  p.dataset.tick = key;
  p.append(el(doc, "b", "fpeek-k " + peek.kind, "▸ " + peek.kind), el(doc, "span", "fpeek-t", peek.text));
  block.append(t, p);
}

export function clearTicks(root: ParentNode): void {
  root.querySelectorAll(".ftick, .fpeek").forEach((n) => n.remove());
}

export const FOLD_CSS = `
.fold{display:block;list-style:none;margin:0;padding:0;position:absolute;z-index:40;box-sizing:border-box;animation:fold-land .16s ease-out;}
@keyframes fold-land{from{opacity:0;transform:translateY(-5px) scale(.985);}}
.fold-in{position:relative;box-sizing:border-box;background:var(--card-bg,#fffdfa);border:1px solid var(--line,#e2ded7);border-radius:7px;padding:0 13px 13px 23px;display:flex;flex-direction:column;gap:9px;max-height:var(--fold-max,min(72vh,560px));overflow:auto;overscroll-behavior:contain;
  box-shadow:0 1px 2px oklch(0.35 0.03 60 / 0.06),0 7px 17px -6px oklch(0.35 0.03 60 / 0.20),0 21px 43px -17px oklch(0.35 0.03 60 / 0.28);transition:box-shadow .14s,transform .14s;}
.fold-in::before{content:"";position:sticky;top:0;display:block;margin:0 -13px -9px -23px;height:2.6px;flex:none;background:var(--accent,#41678a);z-index:2;}
.fold[data-kind="note"] .fold-in::before{background:var(--warn,#bd7138);}
.fold[data-kind="ask"] .fold-in::before{background:var(--ink-soft,#58514c);}
.fold.lifted .fold-in{transform:rotate(-.6deg) scale(1.01);box-shadow:0 2px 3px oklch(0.35 0.03 60 / 0.08),0 15px 28px -7px oklch(0.35 0.03 60 / 0.28),0 36px 64px -21px oklch(0.35 0.03 60 / 0.34);}
.fold-hd{position:sticky;top:2.6px;z-index:1;height:0;margin:0 -13px -9px -23px;font:500 9px/1.2 var(--mono,ui-monospace,monospace);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint,#857f7a);cursor:grab;user-select:none;-webkit-user-select:none;touch-action:none;}
.fold-hd::before{content:"";position:absolute;left:0;right:0;top:0;height:27px;}
.fold-hd + .fi{margin-top:13px;}
.fold-hd + .fi .fi-lab,.fold-hd + .fi.line{margin-right:58px;}
.fold-where:empty{display:none;}
.fold.lifted .fold-hd{cursor:grabbing;}
.fold-grip{position:absolute;left:8px;top:9px;width:7px;height:11px;opacity:.7;background-image:radial-gradient(circle,var(--ink-faint,#857f7a) .95px,transparent 1.15px);background-size:3.6px 3.6px;}
.fold-grow{display:none;}
.fold-count{position:absolute;right:31px;top:9px;color:var(--warn,#bd7138);letter-spacing:0;text-transform:none;font-size:9.3px;}
.fold-count.cards{color:var(--accent,#41678a);}
.fold-count.asks{color:var(--ink-soft,#58514c);}
.fold-shut{position:absolute;right:6px;top:4px;width:19px;height:19px;display:inline-flex;align-items:center;justify-content:center;background:none;border:0;border-radius:4px;padding:0;cursor:pointer;color:inherit;font:400 14px/1 var(--sans,system-ui,sans-serif);letter-spacing:0;text-transform:none;}
.fold-shut:hover{color:var(--ink,#2a241f);background:var(--fold-sunk,oklch(0.955 0.009 85));}
.fold-threads{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;z-index:39;}
.fold .fi{border:0;box-shadow:none;background:transparent;border-radius:0;padding:0;}
.fold .fi + .fi{border-top:1px solid var(--line,#e2ded7);padding-top:9px;}
.fold .fi.line{padding:2px 0;}
.fi{background:var(--card-bg,#fffdfa);border:1px solid var(--line,#e2ded7);border-left:2.5px solid var(--accent,#41678a);border-radius:5px;padding:10px 13px 12px 12px;box-shadow:0 1px 2px oklch(0.4 0.02 70 / 0.04);}
.fi.note{border-left-color:var(--warn,#bd7138);}
.fi-lab{display:flex;align-items:baseline;gap:7px;margin-bottom:5px;font:500 9.3px var(--mono,ui-monospace,monospace);letter-spacing:.06em;color:var(--accent,#41678a);}
.fi.note .fi-lab{color:var(--warn,#bd7138);}
.fi-lab b{font-weight:500;}
.fi-lab i{font:italic 10.5px var(--serif,Georgia,serif);color:var(--ink-faint,#857f7a);letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.fi .fi-note{margin:0;font:italic 14.3px/1.47 var(--serif,Georgia,serif);color:var(--ink,#2a241f);cursor:text;white-space:pre-wrap;}
.fi-edit{display:block;width:100%;box-sizing:border-box;border:1px solid var(--line,#e2ded7);border-radius:4px;background:#fff;padding:6px 8px;font:italic 14.3px/1.47 var(--serif,Georgia,serif);color:var(--ink,#2a241f);resize:vertical;outline:none;min-height:52px;}
.fi-edit:focus{border-color:var(--warn,#bd7138);}
.fi-bar{display:flex;justify-content:space-between;align-items:center;margin-top:7px;font:500 9.3px var(--mono,ui-monospace,monospace);color:var(--ink-faint,#857f7a);}
.fi-bar em{font-style:normal;}
.fi-rm{background:none;border:0;padding:0;cursor:pointer;font:inherit;color:inherit;}
.fi-rm:hover{color:oklch(0.55 0.15 30);}
.fi.draft .fi-edit{font:15px/1.4 var(--serif,Georgia,serif);font-style:normal;margin-top:6px;min-height:40px;}
.fi.draft .fi-edit:focus{border-color:var(--accent,#41678a);}
.fi.draft .fi-back{font-size:13.5px;color:var(--ink-soft,#58514c);}
.fi-hint{margin-left:auto;font:500 9.3px var(--mono,ui-monospace,monospace);font-style:normal;color:var(--ink-faint,#857f7a);}
.fi.card .fi-face .q,.fi.card .fq{font:16.8px/1.4 var(--serif,Georgia,serif);color:var(--ink,#2a241f);}
.fi.card .fi-a{margin-top:8px;background:oklch(0.965 0.006 85);border-radius:4px;padding:8px 10px;font:13.5px/1.5 var(--serif,Georgia,serif);color:var(--ink-soft,#58514c);}
.fi.card .fi-a p{margin:0 0 6px;} .fi.card .fi-a p:last-child{margin-bottom:0;}
.fi.card .fi-face .a{margin-top:8px;background:oklch(0.965 0.006 85);border-radius:4px;padding:8px 10px;font:13.5px/1.5 var(--serif,Georgia,serif);color:var(--ink-soft,#58514c);}
.fi.card .fi-face .opts{display:flex;flex-direction:column;gap:4px;margin-top:8px;}
.fi-acts{display:flex;align-items:center;gap:10px;margin-top:9px;}
.fi-pri{background:var(--accent,#41678a);color:var(--card-bg,#fffdfa);border:0;border-radius:3.4px;padding:4px 10px;font:500 11.3px var(--sans,system-ui,sans-serif);cursor:pointer;}
.fi-lnk{background:none;border:0;padding:0;color:var(--ink-faint,#857f7a);font:500 9.7px var(--mono,ui-monospace,monospace);cursor:pointer;}
.fi-good{background:oklch(0.95 0.03 150);color:var(--good,#587c5f);border:0;border-radius:10px;padding:2.5px 10px;font:500 10px var(--mono,ui-monospace,monospace);cursor:pointer;}
.fi-pill{background:none;color:var(--ink-soft,#58514c);border:1px solid var(--line,#e2ded7);border-radius:10px;padding:2.5px 10px;font:500 10px var(--mono,ui-monospace,monospace);cursor:pointer;}
.fi.line{display:flex;align-items:center;gap:8px;padding:6px 10px;font:11px var(--sans,system-ui,sans-serif);color:var(--ink-soft,#58514c);}
.fi-ck{color:var(--accent,#41678a);font:500 9.3px var(--mono,ui-monospace,monospace);}
.fi-lq{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.fi-r{margin-left:auto;font:500 9.3px var(--mono,ui-monospace,monospace);color:var(--ink-faint,#857f7a);white-space:nowrap;}
.fi-st{margin-left:auto;font:500 9px var(--mono,ui-monospace,monospace);letter-spacing:0;color:var(--warn,#bd7138);}
.fi-turn{margin-top:7px;}
.fi-who{display:block;font:500 9.3px var(--mono,ui-monospace,monospace);color:var(--ink-faint,#857f7a);margin-bottom:1px;}
.fi-turn.agent .fi-who{color:var(--good,#587c5f);}
.fi .fi-say,.fi .fi-say p,.fi .fi-say li{margin:0;font:12.3px/1.52 var(--sans,system-ui,sans-serif);color:var(--ink,#2a241f);white-space:pre-wrap;}
.fi-reply{display:flex;gap:7px;margin-top:9px;align-items:stretch;}
.fi-field{flex:1;resize:none;border:1px solid var(--line,#e2ded7);border-radius:4px;background:#fff;padding:6px 8px;font:12px/1.4 var(--sans,system-ui,sans-serif);color:var(--ink,#2a241f);min-height:29px;outline:none;box-sizing:border-box;}
.fi-field:focus{border-color:var(--warn,#bd7138);}
.fi-send{background:var(--warn,#bd7138);color:var(--card-bg,#fffdfa);border:0;border-radius:3.4px;padding:0 10px;font:500 11px var(--sans,system-ui,sans-serif);cursor:pointer;}
.fi.asked{border-left-color:var(--ink-soft,#58514c);}
.fi.asked .fi-lab{color:var(--ink,#2a241f);}
.fi.asked .fi-turn{margin-top:9px;}
.fi.asked .fi-turn.claude .fi-who{color:var(--good,#587c5f);}
.fi.asked .fi-turn.writing .fi-say{color:var(--ink-soft,#58514c);}
.fi.asked .fi-field:focus{border-color:var(--ink-soft,#58514c);}
.fi.asked .fi-send{background:var(--ink-soft,#58514c);}
.fi-say.md,.fi .fi-say[data-say]{white-space:normal;}
.fi .fi-say[data-say] p{margin:0 0 6px;}
.fi .fi-say[data-say] p:last-child{margin-bottom:0;}
.fi .fi-say.md p{margin:0 0 6px;}
.fi .fi-say.md p:last-child{margin-bottom:0;}
.fi-say.md ul,.fi-say.md ol{margin:0 0 6px;padding-left:18px;}
.fi-say.md code{font:11.5px var(--mono,ui-monospace,monospace);background:oklch(0.955 0.009 85);padding:0 3px;border-radius:2px;}
.fi-mk{margin-left:8px;background:none;border:0;padding:0;cursor:pointer;font:500 9.3px var(--mono,ui-monospace,monospace);color:var(--ink-faint,#857f7a);opacity:0;transition:opacity .12s;}
.fi-turn:hover .fi-mk,.fi-mk:focus-visible{opacity:1;}
.fi-err{margin:7px 0 0;font:12px/1.45 var(--sans,system-ui,sans-serif);color:oklch(0.55 0.15 30);}
.fold-anchor{position:relative;}
.ftick{position:absolute;right:-32px;bottom:2px;display:flex;gap:3.4px;padding:3.4px 4.2px;border:1px solid transparent;border-radius:3.4px;background:transparent;cursor:pointer;line-height:0;}
.ftick:hover,.ftick:focus-visible{background:var(--fold-sunk,oklch(0.955 0.009 85));border-color:var(--line,#e2ded7);outline:none;}
.fmk{display:block;width:6.7px;height:6.7px;border-radius:1.7px;box-sizing:border-box;}
.fmk.note{background:var(--warn,#bd7138);}
.fmk.card{background:var(--accent,#41678a);}
.fmk.card-done{border:1.2px solid var(--accent,#41678a);}
.fmk.ask{background:var(--ink-soft,#58514c);}
.fpeek{position:absolute;left:0;right:0;top:100%;z-index:3;display:flex;align-items:center;gap:8px;margin-top:4px;padding:5px 10px;background:var(--card-bg,#fffdfa);border:1px solid var(--line,#e2ded7);border-radius:5px;box-shadow:0 6px 16px -6px oklch(0.35 0.03 60 / 0.22);font:italic 13px/1.4 var(--serif,Georgia,serif);color:var(--ink-soft,#58514c);white-space:nowrap;overflow:hidden;opacity:0;pointer-events:none;transform:translateY(-3px);transition:opacity .12s,transform .12s;}
.ftick:hover + .fpeek{opacity:1;transform:none;}
.fpeek-k{font:500 9px var(--mono,ui-monospace,monospace);font-style:normal;letter-spacing:.06em;text-transform:uppercase;flex:none;}
.fpeek-k.note{color:var(--warn,#bd7138);}
.fpeek-k.card{color:var(--accent,#41678a);}
.fpeek-k.ask{color:var(--ink-soft,#58514c);}
.fpeek-t{overflow:hidden;text-overflow:ellipsis;}
`;

/** Styles go in once per document or shadow root that shows a fold. */
export function ensureFoldStyle(root: Document | ShadowRoot): void {
  const head = root instanceof Document ? root.head : root;
  if (head.querySelector("style[data-fold]")) return;
  const doc = root instanceof Document ? root : root.ownerDocument;
  const s = doc.createElement("style");
  s.dataset.fold = "";
  s.textContent = FOLD_CSS;
  head.append(s);
}
