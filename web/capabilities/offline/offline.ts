import { StrataFetchForShelf, StrataPath } from "../../data/api.ts";

/** refuses /api URLs: those must go through data/api.ts for the session header and wire health */
export function fetchAsset(url: string, init?: RequestInit): Promise<Response> {
  if ((new URL(url, location.href).pathname + "/").startsWith(StrataPath("/api/"))) return Promise.reject(new Error("fetchAsset: not /api"));
  return fetch(url, init);
}

/** Download explicitly; report storage failures instead of claiming an unsaved copy exists. */
export async function saveOfflineUrl(url: string): Promise<void> {
  const target = new URL(url, location.href);
  const response = await StrataFetchForShelf(target);
  if (response.status === 404 && target.pathname.endsWith("/tree")) return; // Optional trees may not have been generated.
  if (!response.ok || response.headers.has("X-Strata-Shelf")) throw new Error("Download needs a live connection");
  const kind = target.origin === location.origin && target.pathname.startsWith(StrataPath("/api/")) ? "api" : "shell";
  const cache = await caches.open(`strata-off-v2-${kind}`);
  await cache.put(target, await savedCopy(response));
}

async function savedCopy(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding"); headers.delete("Content-Length");
  headers.set("X-Strata-Saved-At", String(Date.now()));
  return new Response(await response.arrayBuffer(), { status: response.status, headers });
}

/** Updating the interface must not delete downloaded reading material. */
export async function updateInterface(): Promise<void> {
  if (!window.confirm("Reload Strata now? Unsaved edits may be lost. Downloaded material will be kept.")) return;
  let savedPage: string | null = null;
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration(StrataPath("/"));
    await registration?.update();
    savedPage = registration?.scope ?? null;
  }
  // Fail visibly rather than reloading into the same cached page during an outage.
  const response = await fetch(location.href, { cache: "no-store", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Could not load the latest app. Check your connection or log in again.");
  // The worker opens a load on its saved page, so without this the reload brings the old build back.
  if (savedPage) await replaceSavedPage(savedPage, response);
  location.reload();
}

async function replaceSavedPage(key: string, response: Response): Promise<void> {
  try {
    const cache = await caches.open("strata-off-v2-shell");
    try { await cache.put(key, await savedCopy(response)); }
    catch { await cache.delete(key); } // storage full: with no saved page the reload goes to the wire
  } catch { /* no Cache Storage: the worker has no saved page to serve either */ }
}
