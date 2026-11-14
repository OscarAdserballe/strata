import { StrataAPI, StrataPath } from "../data/api.ts";

export async function signOut(failed: (e: unknown) => void): Promise<void> {
  try { await StrataAPI.logout(); } catch (e) { failed(e); return; }
  // Remove only this instance's paths: an old shared origin may still hold both / and /sharing/.
  const base = StrataPath("/");
  try {
    if (window.caches) for (const k of await caches.keys()) {
      const cache = await caches.open(k);
      for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith(base)) await cache.delete(req);
    }
    if ("serviceWorker" in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) {
      if (new URL(r.scope).pathname === base) await r.unregister();
    }
  } catch { /* the server session is already gone; stale local bytes are best-effort */ }
  location.replace(/^\/u\/[^/]+\/$/.test(base) ? "/" : base);
}
