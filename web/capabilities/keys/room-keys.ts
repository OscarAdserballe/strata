import { useEffect } from "react";
import { registerKeys } from "./registry.ts";

// the handler reads through handles, not values: it is bound once and must read the present

export interface BoardKeysView {
  activeId: string | null;
  src: unknown;
  onHome: boolean;
  go: { items: Array<{ run(): void; keepOpen?: boolean }>; sel: number } | null;
  composer: unknown;
  capture: boolean;
  launcher: boolean;
  bench: unknown;
  benchEdit: unknown;
  sheetsOver: boolean;
}

export interface ReaderKeysView {
  card: any;
  done: boolean;
  revealed: boolean;
  editing: unknown;
  cardsOnly: boolean;
  solo: boolean;
  treeOpen: boolean;
  openMark: unknown;
  find: unknown;
}

type Act = (...a: any[]) => any;
export type RoomKeyActions = Record<
  | "setCapture" | "openKeysSheet" | "setGo" | "setComposer" | "setTreeOpen" | "openAsk" | "closeAsk" | "askIsOpen"
  | "setRevealed" | "setOpenMark" | "setEditing" | "setBenchEdit" | "setLauncher" | "panelOpen" | "hideShelf" | "showShelf"
  | "toggleCardsOnly" | "toggleBench" | "closeBench" | "closeTopLayer" | "openFind" | "closeFind" | "stepUi" | "stepHistory"
  | "mintCapture" | "mintOpenCard" | "move" | "answer" | "gradeCard" | "jumpToCard" | "goToCardSource" | "adoptDrift"
  | "logCard" | "openCram" | "log" | "warmKeyed",
  Act>;

export interface RoomKeysCtx {
  board(): BoardKeysView;
  reader(): ReaderKeysView;
  pageRef: { current: HTMLElement | null };
  driftRef: { readonly current: { label?: string | null } | null | undefined };
  actions: RoomKeyActions;
}

export interface RoomSheetView {
  ui: number; pz?: number;
  cardsOnly?: boolean;
  src?: { tokens: number } | null;
  board?: { budget?: { targetTokens?: number } } | null;
}
const fmtTok = (n: number) => !n ? "0" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n);

// registered once for the route's life; verbs are read from `actions`, so nothing re-registers
export function useRoomKeys(ctx: RoomKeysCtx, sheet: () => RoomSheetView): void {
  useEffect(() => registerKeys({ screen: "board", onKey: makeKeyHandler(ctx), info: () => {
    const s = sheet(), target = s.board?.budget?.targetTokens || 0;
    return {
      fill: { ui: String(Math.round(s.ui * 100)), pz: String(Math.round((s.pz || 1) * 100)) },
      foot: (s.cardsOnly ? "cards only is on for this board: every deck on it, shuffled — o puts the pages back. " : "")
        + (s.src ? `this page costs ${fmtTok(s.src.tokens)} / ${fmtTok(target)} of the context window.` : "drop files anywhere to add sources — several at once is fine."),
    };
  } }), []);
}

export function makeKeyHandler(ctx: RoomKeysCtx): (e: KeyboardEvent) => void {
  const { board, reader, pageRef, driftRef, actions: a } = ctx;
  return function onKey(e) {
    const k = (e.key || "").toLowerCase();
    const b = board();
    const g = b.go;
    const el = e.target as HTMLElement | null;
    if (b.capture) { if (k === "escape") { e.preventDefault(); a.setCapture(null); } return; }
    const r = reader();
    // the editor owns the keyboard: every bare key behind it grades, moves or navigates
    if (r.editing) { if (k === "escape") { e.preventDefault(); a.setEditing(null); } return; }
    if (b.benchEdit) { if (k === "escape") { e.preventDefault(); a.setBenchEdit(null); } return; }
    if (g) {
      if (k === "escape") { e.preventDefault(); a.setGo(null); }
      else if (k === "arrowdown" || k === "j") { e.preventDefault(); a.setGo((x: NonNullable<BoardKeysView["go"]>) => ({ ...x, sel: (x.sel + 1) % x.items.length })); }
      else if (k === "arrowup" || k === "k") { e.preventDefault(); a.setGo((x: NonNullable<BoardKeysView["go"]>) => ({ ...x, sel: (x.sel - 1 + x.items.length) % x.items.length })); }
      else if (k === "enter") { e.preventDefault(); const it = g.items[g.sel]; if (!it) return; if (!it.keepOpen) a.setGo(null); it.run(); }
      return;
    }
    // typing beats every shortcut, including ?
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    // the first key warms the lazy chunks r and x need
    a.warmKeyed();
    if (k === "escape" && b.composer) { e.preventDefault(); a.setComposer(null); return; }
    if (e.key === "?" || (e.key === "/" && (e.shiftKey || e.metaKey || e.ctrlKey))) { e.preventDefault(); a.panelOpen("keys"); a.openKeysSheet(); return; }
    if (k === "escape" && b.launcher) { e.preventDefault(); a.closeTopLayer(); return; }
    const c = r.card, isDone = r.done, sc = pageRef.current;
    if (k === "c" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); a.mintCapture(); return; }
    if (k === "e" && c && !c.mintOpen && !e.metaKey && !e.ctrlKey) { e.preventDefault(); a.setEditing(c.id); return; }
    if (k === "h") { e.preventDefault(); if (b.sheetsOver) a.hideShelf(); else a.showShelf(true); return; }
    if (k === "b") { e.preventDefault(); a.panelOpen("launcher"); a.setLauncher(true); return; }
    if (k === "r" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); a.toggleBench(); return; }
    // the native find cannot see pages the reader has not drawn yet
    if (k === "f" && b.src && !b.onHome && !r.cardsOnly && !r.treeOpen) { e.preventDefault(); a.openFind(); return; }
    if (k === "o") { e.preventDefault(); a.toggleCardsOnly(); return; }
    if (k === "x") { e.preventDefault(); a.openCram(); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); a.stepUi(-1); return; }
    if (e.key === "=" || e.key === "+") { e.preventDefault(); a.stepUi(1); return; }
    if (k === "t" && !b.onHome && b.src && !r.cardsOnly) { e.preventDefault(); a.panelOpen("tree", !r.treeOpen); a.setTreeOpen((v: boolean) => !v); return; }
    if ((e.metaKey || e.ctrlKey) && k === "z") { e.preventDefault(); void a.stepHistory(!e.shiftKey); return; }
    if ((e.metaKey || e.ctrlKey) && k === "y") { e.preventDefault(); void a.stepHistory(false); return; }
    // esc closes the innermost thing first: the note, then the find bar, then the sheets
    if (k === "escape" && r.openMark) { e.preventDefault(); a.setOpenMark(null); return; }
    if (k === "escape" && r.find) { e.preventDefault(); a.closeFind(); return; }
    if (k === "escape" && b.sheetsOver) { e.preventDefault(); a.hideShelf(); return; }
    if (k === "escape" && r.treeOpen) { e.preventDefault(); a.setTreeOpen(false); return; }
    if (k === "escape" && a.askIsOpen()) { e.preventDefault(); a.closeAsk(); return; }
    // the thread lies over the workbench, so the bench closes only after the chat
    if (k === "escape" && b.bench) { e.preventDefault(); a.closeBench(); return; }
    if (k === "escape" && r.cardsOnly) { e.preventDefault(); a.toggleCardsOnly(false); return; }
    if (k === "/") { e.preventDefault(); a.panelOpen("ask"); a.openAsk(); return; }
    if (k === "j") { e.preventDefault(); sc && sc.scrollBy({ top: 84 }); }
    else if (k === "k") { e.preventDefault(); sc && sc.scrollBy({ top: -84 }); }
    else if (k === "d" && e.ctrlKey) { e.preventDefault(); sc && sc.scrollBy({ top: sc.clientHeight * 0.5 }); }
    else if (k === "u" && e.ctrlKey) { e.preventDefault(); sc && sc.scrollBy({ top: -sc.clientHeight * 0.5 }); }
    else if (k === " " && c && c.mintOpen && !e.shiftKey) { e.preventDefault(); a.mintOpenCard(c); }
    // space never walks past a card: the grade is what moves you on
    else if (k === " ") { e.preventDefault(); a.hideShelf(); if (e.shiftKey) a.move(-1); else if (!isDone && c && c.type !== "mcq") { a.setRevealed(true); a.logCard("card_reveal"); } else if (c) { /* graded, not spaced, past */ } else a.move(1); }
    else if (k === "n") a.move(1);
    else if (k === "p") a.move(-1);
    else if (k === "enter") {
      if (driftRef.current && !(isDone && c)) { a.log("drift_adopt", { board: b.activeId, to: driftRef.current.label || null }); a.adoptDrift(); return; }
      if (isDone && c) {
        a.log("jump_to_source", { board: b.activeId, card: c.id, solo: !!r.solo });
        if (r.solo) a.goToCardSource(c); else a.jumpToCard();
      }
    }
    else if (k >= "1" && k <= "4" && c && c.type === "mcq" && r.done === false) a.answer(+k - 1);
    // !e.repeat: a held answer key must not answer and then grade in one press
    else if ((k === "1" || k === "2") && c && isDone && !e.repeat) { e.preventDefault(); a.gradeCard(k === "2"); }
    else if ((k === "1" || k === "2") && c && c.type !== "mcq" && !c.mintOpen && !r.revealed && !e.repeat) { e.preventDefault(); a.hideShelf(); a.setRevealed(true); a.logCard("card_reveal"); }
  };
}
