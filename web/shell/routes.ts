export type RoomRoute = { kind: "library" } | { kind: "review" }
  | { kind: "board"; board: string; resource?: string; pair?: string }
  | { kind: "cram"; board: string }
  | { kind: "keeps"; board?: string; deck?: string; from?: "library" };
export type HistoryMode = "push" | "replace" | "none";
const validId = (value: string | null): string | undefined => value && /^[a-zA-Z0-9_-]+$/.test(value) ? value : undefined;
export function readRoute(search: string): RoomRoute {
  const p = new URLSearchParams(search);
  const view = p.get("view");
  if (view === "review") return { kind: "review" };
  const board = validId(p.get("board"));
  if (view === "keeps") {
    const deck = board ? validId(p.get("deck")) : undefined;
    const from = board && p.get("from") === "library" ? { from: "library" as const } : {};
    return { kind: "keeps", ...(board ? { board } : {}), ...(deck ? { deck } : {}), ...from };
  }
  if (!board) return { kind: "library" };
  if (view === "cram") return { kind: "cram", board };
  return { kind: "board", board, resource: validId(p.get("resource")), pair: validId(p.get("pair")) };
}
export function routeSearch(route: RoomRoute): string {
  const p = new URLSearchParams();
  if (route.kind === "review") p.set("view", "review");
  if (route.kind === "board") {
    p.set("board", route.board);
    if (route.resource) p.set("resource", route.resource);
    if (route.pair) p.set("pair", route.pair);
  }
  if (route.kind === "cram") { p.set("board", route.board); p.set("view", "cram"); }
  if (route.kind === "keeps") {
    if (route.board) p.set("board", route.board);
    p.set("view", "keeps");
    if (route.board && route.deck) p.set("deck", route.deck);
    if (route.board && route.from === "library") p.set("from", "library");
  }
  return p.size ? `?${p}` : "";
}
export interface KeepsFrame { library?: boolean; board?: boolean; boardId?: string; slug?: string; title?: string }
export function keepsRoute(frames: readonly KeepsFrame[], activeId?: string | null): RoomRoute {
  const top = frames[frames.length - 1];
  const library = !!frames[0]?.library;
  const board = top && !top.library ? validId(top.boardId || (library ? null : activeId) || null) : undefined;
  if (!board) return { kind: "keeps" };
  const deck = top.board ? undefined : validId(String(top.slug ?? "").split("/")[0]);
  return { kind: "keeps", board, ...(deck ? { deck } : {}), ...(library ? { from: "library" as const } : {}) };
}
export function keepsFrames(route: RoomRoute): KeepsFrame[] {
  if (route.kind !== "keeps") return [];
  if (!route.board) return [{ library: true }];
  if (route.from === "library") return [{ library: true }, { board: true, boardId: route.board },
    ...(route.deck ? [{ slug: route.deck, boardId: route.board }] : [])];
  return [route.deck ? { slug: route.deck } : { board: true }];
}
export function routeBoard(route: RoomRoute): string | undefined {
  if (route.kind === "keeps" && route.from === "library") return undefined;
  return route.kind === "board" || route.kind === "cram" || route.kind === "keeps" ? route.board : undefined;
}
export class Navigation {
  route: RoomRoute = { kind: "library" };
  version = 0;
  begin(route: RoomRoute): number { this.route = route; return ++this.version; }
  shift(route: RoomRoute): number {
    const on = routeBoard(route);
    if (on && on === routeBoard(this.route) && (route.kind !== "board" || this.route.kind !== "board")) { this.route = route; return this.version; }
    return this.begin(route);
  }
  current(version: number): boolean { return this.version === version; }
  owns(board: string): boolean { return this.route.kind === "board" && this.route.board === board; }
  // While a board is the route only its state lands; behind an overlay, the held board's updates land too.
  accepts(board: string, held: string | null | undefined): boolean {
    return this.owns(board) || routeBoard(this.route) === board || (this.route.kind !== "board" && !!held && held === board);
  }
}

// Only the route's kind is published, so App doesn't re-render on page flips.
let kindNow: RoomRoute["kind"] = typeof location === "undefined" ? "library" : readRoute(location.search).kind;
const kindHeard = new Set<() => void>();
function publish(route: RoomRoute): void {
  if (route.kind === kindNow) return;
  kindNow = route.kind;
  for (const cb of [...kindHeard]) cb();
}
const popped = () => publish(readRoute(location.search));
export function go(route: RoomRoute, mode: HistoryMode = "push"): void {
  const search = routeSearch(route);
  if (mode !== "none" && search !== location.search) history[mode === "replace" ? "replaceState" : "pushState"](null, "", location.pathname + search);
  publish(route);
}
export const navigation = new Navigation();
export function navigate(route: RoomRoute, mode: HistoryMode = "push", over = false): number {
  const version = over ? navigation.shift(route) : navigation.begin(route);
  go(route, mode);
  return version;
}
export const routeKind = (): RoomRoute["kind"] => kindNow;
export function subscribeRoute(cb: () => void): () => void {
  if (!kindHeard.size) addEventListener("popstate", popped);
  kindHeard.add(cb);
  return () => { kindHeard.delete(cb); if (!kindHeard.size) removeEventListener("popstate", popped); };
}
