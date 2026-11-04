import { useSyncExternalStore } from "react";
import { StrataAPI } from "../data/api.ts";
import { begin as journey } from "../platform/rum.ts";
import { boardNow } from "../surfaces/board/handle.ts";
import { boardPage } from "../surfaces/board/summon.ts";
import { readerNow } from "../surfaces/reader/handle.ts";
import { type KeepsFrame, type RoomRoute, keepsRoute, navigate, navigation, routeSearch } from "./routes.ts";
import { room } from "./room.ts";
export interface KeepsEditing { id: string; side: string }
export interface Screens {
  library: boolean;
  review: boolean;
  cram: boolean;
  keeps: readonly KeepsFrame[];
  keepsEditing: KeepsEditing | null;
  libraryQuery: string;
}
const NONE: readonly KeepsFrame[] = Object.freeze([]);
let now: Screens = { library: false, review: false, cram: false, keeps: NONE, keepsEditing: null, libraryQuery: "" };
const heard = new Set<() => void>();
function put(patch: Partial<Screens>): void {
  now = { ...now, ...patch };
  for (const cb of [...heard]) cb();
}
export const screensNow = (): Screens => now;
export function subscribeScreens(cb: () => void): () => void {
  heard.add(cb);
  return () => { heard.delete(cb); };
}
export const useScreens = (): Screens => useSyncExternalStore(subscribeScreens, screensNow, screensNow);

/** Bits only, so pushing a keeps frame or typing a query doesn't re-render App or the room. */
export const LIBRARY = 1, REVIEW = 2, CRAM = 4, KEEPS = 8;
const upNow = (): number => (now.library ? LIBRARY : 0) | (now.review ? REVIEW : 0) | (now.cram ? CRAM : 0) | (now.keeps.length ? KEEPS : 0);
export const useScreensUp = (): number => useSyncExternalStore(subscribeScreens, upNow, upNow);

export function showLibrary(on: boolean): void { if (now.library !== on) put({ library: on }); }
export function showReview(on: boolean): void { if (now.review !== on) put({ review: on }); }
export function showCram(on: boolean): void { if (now.cram !== on) put({ cram: on }); }
export function setLibraryQuery(q: string): void { if (now.libraryQuery !== q) put({ libraryQuery: q }); }
export function setKeepsEditing(e: KeepsEditing | null): void { if (now.keepsEditing !== e) put({ keepsEditing: e }); }

// The address bar follows the keeps stack; it pushes only when the route actually differs.
export function setKeeps(next: readonly KeepsFrame[] | ((was: readonly KeepsFrame[]) => readonly KeepsFrame[])): void {
  const frames = typeof next === "function" ? next(now.keeps) : next;
  const had = now.keeps.length > 0;
  if (frames === now.keeps || (!frames.length && !had)) return;
  put({ keeps: frames.length ? frames : NONE, keepsEditing: null });
  const route = navigation.route;
  if (frames.length) {
    const want = keepsRoute(frames, room.activeId());
    if (routeSearch(want) !== routeSearch(route)) navigate(want, "push", true);
  } else if (route.kind === "keeps") navigate(now.library ? { kind: "library" } : roomRoute(), "push", true);
}
export const closeKeeps = (): void => setKeeps((frames) => frames.slice(0, -1));
export const descendKeeps = (frame: KeepsFrame & { title?: string }): void => setKeeps((frames) => frames.concat([frame]));
export const putKeepsAway = (): void => setKeeps(NONE);

export function setLibrary(on: boolean | ((was: boolean) => boolean)): void {
  const show = typeof on === "function" ? on(now.library) : on;
  if (show) navigate({ kind: "library" });
  else if (room.activeId()) navigate(roomRoute());
  showLibrary(show);
}
export function setReviewing(on: boolean): void {
  navigate({ kind: on ? "review" : "library" });
  showReview(on);
  showLibrary(true);
}
export function closeCram(): void {
  showCram(false);
  navigate(roomRoute(), "push", true);
}

export function roomRoute(): RoomRoute {
  const b = boardNow(), id = b.activeId, p = b.pair;
  if (!id) return { kind: "library" };
  if (now.cram) return { kind: "cram", board: id };
  if (now.keeps.length && !now.keeps[0].library) return keepsRoute(now.keeps, id);
  return { kind: "board", board: id, ...(p && !p.isHome ? { pair: p.id, resource: p.resourceId || undefined } : {}) };
}

export function openCram(): void {
  const { board, activeId } = boardNow();
  if (!board || !activeId) return;
  journey("cram.open"); navigate({ kind: "cram", board: activeId }, "push", true); showCram(true);
}

export function panelOpen(what: string, on?: boolean): void {
  StrataAPI.log("panel_open", { board: boardNow().activeId, what, ...(on === undefined ? {} : { on }) });
}
export function openLibrary(): void { panelOpen("launcher"); setLibrary(true); }

export function showBoardPage(force?: boolean): void { boardPage.show(force); putKeepsAway(); panelOpen("shelf"); }
export function hideBoardPage(): void { boardPage.hide(); putKeepsAway(); }

export function toggleKeeps(): void {
  const b = boardNow(), r = readerNow(), pair = b.pair, c = r.card;
  if (now.keeps.length) { setKeeps(NONE); return; }
  if (now.library) { setKeeps([{ library: true }]); return; }
  if (b.onHome && !r.solo && !r.qDeck) { hideBoardPage(); setKeeps([{ board: true }]); return; }
  const own = !r.qDeck && !r.solo && pair;
  const slug = own && pair.deck ? pair.deck : c && c.deck ? String(c.deck).split("/")[0] : null;
  if (!slug) return;
  hideBoardPage();
  setKeeps([{ slug, title: (own && pair.label) || slug }]);
}
