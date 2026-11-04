import { store as roomStore } from "./store.ts";
import { BOARDS, REGISTER } from "./entities/sources.ts";
import { reviewStrip } from "./entities/review.ts";

/** The worker answered a boot read from its snapshot and then found the live answer differs: read again, live. */
export function snapshotChanged(path: string): void {
  if (path.endsWith("/api/boards")) roomStore.invalidate([BOARDS]);
  else if (path.endsWith("/api/register")) roomStore.invalidate([REGISTER]);
  else if (path.endsWith("/api/review")) reviewStrip.refresh();
}

export function watchSnapshots(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent<{ type?: string; path?: string }>) => {
    if (e.data?.type === "strata:snapshot" && typeof e.data.path === "string") snapshotChanged(e.data.path);
  });
}
