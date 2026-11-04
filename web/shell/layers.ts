// One ordered list of overlay layers, published as CSS custom properties (layers.css).
export const LAYERS = [
  ["page-layers", 15], // the sheets notes, cards and asks lie on, over the page (inside .page)
  ["desk", 20],        // the board page and the book room, over card and page (inside .panes)
  ["bench", 30],       // the keeps opened from the room (inside .panes)
  ["room-ask", 40],
  ["selmenu", 60],
  ["menu", 70],
  ["veil", 80],
  ["bench-lib", 85],   // the keeps opened from the library: over the library's veil
  ["saving", 88],
  ["toast", 90],
  ["ask-dock", 95],    // the Ask a screen laid over the room mounts (library, review, cram, keeps)
  ["capture", 100],
  ["sheet", 110],
  ["imports", 120],
  ["imports-pop", 130],
  ["banner", 500],     // offline: over everything but the receipt of an import
  ["receipt", 12000],
] as const;
export type LayerName = (typeof LAYERS)[number][0];

// Toast state lives here, not in a screen, so showing one re-renders only the Toast component.
let said = "";
let timer: ReturnType<typeof setTimeout> | undefined;
const heard = new Set<() => void>();
const tell = () => { for (const cb of [...heard]) cb(); };
export function toast(text: string, ms?: number): void {
  said = text;
  clearTimeout(timer);
  timer = setTimeout(() => { said = ""; tell(); }, ms || 1300);
  tell();
}
export const toastNow = (): string => said;
export const subscribeToast = (cb: () => void): (() => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
