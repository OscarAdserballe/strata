import { useSyncExternalStore } from "react";
import type { Route } from "../../surfaces.ts";
import type { KeyGroup } from "./sheets.ts";
import { LAYERS, type LayerName } from "../../shell/layers.ts";
// overlays listen in the capture phase, so an owning screen stops a key before the room hears it

export interface KeyLayout {
  screen: Route;
  onKey: (e: KeyboardEvent) => void;
  over?: boolean;
  owns?: boolean;
  info?: () => { fill?: Record<string, string>; foot?: string };
}

const layouts: { id: number; layout: KeyLayout }[] = [];
let seq = 0;
let sheet = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export const typing = (el: EventTarget | null): boolean => {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  if (t.tagName === "TEXTAREA" || t.isContentEditable) return true;
  return t.tagName === "INPUT" && !["checkbox", "radio", "button"].includes((t as HTMLInputElement).type);
};
const isHelp = (e: KeyboardEvent) => e.key === "?" || (e.key === "/" && (e.shiftKey || e.metaKey || e.ctrlKey));

function capture(e: KeyboardEvent) {
  if (sheet) { e.preventDefault(); e.stopPropagation(); closeKeysSheet(); return; }
  const over = layouts.filter((l) => l.layout.over);
  if (!over.length) return;
  if (isHelp(e) && !typing(e.target)) { e.preventDefault(); e.stopPropagation(); openKeysSheet(); return; }
  for (let i = over.length - 1; i >= 0 && !e.cancelBubble; i--) over[i].layout.onKey(e);
}
function bubble(e: KeyboardEvent) {
  const base = layouts.filter((l) => !l.layout.over);
  base[base.length - 1]?.layout.onKey(e);
}
let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", capture, true);
  window.addEventListener("keydown", bubble);
}

export function registerKeys(layout: KeyLayout): () => void {
  install();
  const id = ++seq;
  layouts.push({ id, layout });
  return () => {
    const at = layouts.findIndex((l) => l.id === id);
    if (at >= 0) layouts.splice(at, 1);
  };
}

export function openKeysSheet(): void { if (!sheet) { sheet = true; emit(); } }
export function closeKeysSheet(): void { if (sheet) { sheet = false; emit(); } }
export const keysSheetOpen = (): boolean => sheet;
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const useKeysSheetOpen = (): boolean => useSyncExternalStore(subscribe, keysSheetOpen, () => false);

export function sheetNow(sheets: Partial<Record<Route, readonly KeyGroup[]>>, everywhere: readonly KeyGroup[]): { groups: KeyGroup[]; foot: string } {
  // the room may register again under a screen laid over it: over stays on top
  const stack = [...layouts.filter((l) => !l.layout.over), ...layouts.filter((l) => l.layout.over)].map((l) => l.layout);
  const shown: KeyLayout[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    shown.push(stack[i]);
    if (stack[i].owns || !stack[i].over) break;
  }
  const fill: Record<string, string> = {};
  let foot = "";
  for (const l of shown) {
    const got = l.info?.() ?? {};
    Object.assign(fill, got.fill);
    if (!foot && got.foot) foot = got.foot;
  }
  const put = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => fill[k] ?? m);
  const groups: KeyGroup[] = [];
  for (const l of shown) for (const [title, rows] of sheets[l.screen] ?? []) groups.push([title, rows.map(([k, w]) => [k, put(w)] as const)]);
  groups.push(...everywhere);
  return { groups, foot };
}

export const layoutsNow = (): readonly KeyLayout[] => layouts.map((l) => l.layout);

export interface LayerCloser { open(): boolean; close(): void }
export type LayerClosers = Partial<Record<LayerName, LayerCloser>>;
const ladders: { id: number; read: () => LayerClosers | undefined }[] = [];

export function registerLadder(read: () => LayerClosers | undefined): () => void {
  const id = ++seq;
  ladders.push({ id, read });
  return () => {
    const at = ladders.findIndex((l) => l.id === id);
    if (at >= 0) ladders.splice(at, 1);
  };
}

export function closeTopLayer(): boolean {
  for (let i = LAYERS.length - 1; i >= 0; i--) {
    for (const l of ladders) {
      const c = l.read()?.[LAYERS[i][0]];
      if (c?.open()) { c.close(); return true; }
    }
  }
  return false;
}
