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
  const api = target.origin === location.origin && target.pathname.startsWith(StrataPath("/api/"));
  // a 404 is the server's answer ("no tree yet"), so the copy answers offline as the server would
  if (response.headers.has("X-Strata-Shelf")) throw new Error("needs a live connection");
  if (!response.ok && !(api && response.status === 404)) throw new Error(`the server said ${response.status}`);
  const cache = await caches.open(`strata-off-v2-${api ? "api" : "shell"}`);
  try { await cache.put(target, await savedCopy(response)); }
  catch { throw new Error("no room left on this device"); }
}

/** An image's bytes, into the worker's image cache, where every view of it looks first. */
export async function saveImage(url: string): Promise<void> {
  const target = new URL(url, location.href);
  const cache = await caches.open("strata-images-v1");
  if (await cache.match(target.href)) return;
  const response = await StrataFetchForShelf(target);
  if (!response.ok || response.headers.has("X-Strata-Shelf")) throw new Error(`the server said ${response.status}`);
  try { await cache.put(target.href, response); }
  catch { throw new Error("no room left on this device"); }
}

/** The text of a copy saveOfflineUrl just kept. */
export async function savedText(url: string): Promise<string> {
  const hit = await (await caches.open("strata-off-v2-api")).match(new URL(url, location.href));
  return hit ? hit.text() : "";
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
