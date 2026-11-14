import { useSyncExternalStore } from "react";
import { StrataPath } from "../../data/api.ts";

// Where you are on the dashboard: the mode is the path (/dashboard or /dispatch), the view and tab are the query.
export type Mode = "focus" | "dispatch";
export type View = "triage" | "thinking" | "review" | "decide" | "implementing" | "built";
export type Sub = "inbox" | "backlog" | "todo";
export interface Nav { mode: Mode; view: View; sub: Sub }

const VIEWS: Record<Mode, View[]> = { focus: ["triage", "thinking", "review"], dispatch: ["triage", "decide", "implementing", "built"] };
const SUBS: Sub[] = ["inbox", "backlog", "todo"];
// Focus opens where the hour puts you, as it always has; Dispatch opens on what waits for you
const byHour = (): View => { const h = new Date().getHours(); return h < 11 ? "thinking" : h >= 13 && h < 16 ? "review" : "triage"; };

function read(): Nav {
  const mode: Mode = /\/dispatch\/?$/.test(location.pathname) ? "dispatch" : "focus";
  const p = new URLSearchParams(location.search);
  const inbox = location.hash === "#inbox";
  const v = p.get("view") as View | null;
  const view: View = inbox ? "triage" : v && VIEWS[mode].includes(v) ? v : mode === "focus" ? byHour() : "decide";
  const s = p.get("sub") as Sub | null;
  return { mode, view, sub: inbox ? "inbox" : s && SUBS.includes(s) ? s : "inbox" };
}

let now: Nav = typeof location === "undefined" ? { mode: "focus", view: "triage", sub: "inbox" } : read();
const heard = new Set<() => void>();
const tell = () => { for (const cb of [...heard]) cb(); };
const path = (n: Nav): string => {
  const p = new URLSearchParams({ view: n.view, ...(n.view === "triage" ? { sub: n.sub } : {}) });
  return `${StrataPath(n.mode === "focus" ? "/dashboard" : "/dispatch")}?${p}`;
};

/** Moves the dashboard; a mode's own last view is where switching back to it lands. */
const last: Partial<Record<Mode, View>> = {};
export function go(patch: Partial<Nav>): void {
  last[now.mode] = now.view;
  const mode = patch.mode ?? now.mode;
  const view = patch.view ?? (patch.mode && patch.mode !== now.mode ? last[mode] ?? (mode === "focus" ? byHour() : "decide") : now.view);
  const next: Nav = { mode, view: VIEWS[mode].includes(view) ? view : VIEWS[mode][1], sub: patch.sub ?? now.sub };
  if (next.mode === now.mode && next.view === now.view && next.sub === now.sub) return;
  now = next;
  history.pushState(null, "", path(next));
  document.title = next.mode === "focus" ? "Focus" : "Dispatch";
  tell();
}
export const navNow = (): Nav => now;
function subscribe(cb: () => void): () => void {
  if (!heard.size) addEventListener("popstate", pop);
  heard.add(cb);
  return () => { heard.delete(cb); if (!heard.size) removeEventListener("popstate", pop); };
}
function pop(): void { now = read(); document.title = now.mode === "focus" ? "Focus" : "Dispatch"; tell(); }
export const useNav = (): Nav => useSyncExternalStore(subscribe, navNow, navNow);
