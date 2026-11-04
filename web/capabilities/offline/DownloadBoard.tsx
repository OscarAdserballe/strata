import { useSyncExternalStore } from "react";
import { StrataAPI, StrataConnection, StrataPath, StrataWireDown } from "../../data/api.ts";
import { fetchAsset, saveOfflineUrl } from "./offline.ts";

// progress lives in its own store, so each step re-renders the button and not the room

type Board = any;
interface Say { toast(t: string, ms?: number): void; toastWhy(e: unknown, said: string): void }

let progress: string | null = null;
const heard = new Set<() => void>();
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
const tell = (v: string | null) => { progress = v; for (const cb of [...heard]) cb(); };
const now = () => progress;

export const downloadedAt = (id: string | null): number => { try { return Number(localStorage.getItem("strata.offline." + id)) || 0; } catch { return 0; } };

export async function downloadBoard(id: string | null, b: Board, say: Say): Promise<void> {
  const { toast, toastWhy } = say;
  if (!id || !b || progress) return;
  if (StrataWireDown()) { toast("reconnect before downloading for offline use"); return; }
  const build = StrataConnection().serverBuild;
  if (build && window.STRATA_BUILD && build !== window.STRATA_BUILD) { toast("reload Strata before downloading, so the saved interface matches"); return; }
  if (!("serviceWorker" in navigator)) { toast("this browser can't keep boards"); return; }
  // the worker only intercepts pages it controls, which begins one load after install
  if (!navigator.serviceWorker.controller) { toast("reload once, then download"); return; }
  let assets: string[];
  try {
    const manifest = await fetchAsset(StrataPath("/dist/offline-assets.json"), { cache: "no-store" });
    if (!manifest.ok) throw new Error("missing interface manifest");
    assets = (await manifest.json()).assets;
    if (!Array.isArray(assets) || !assets.length) throw new Error("invalid interface manifest");
  } catch (e) { toastWhy(e, "couldn't download the interface"); return; }
  // ask for persistent storage: Safari evicts Cache Storage for sites it thinks you left
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch { /* best effort */ }
  const urls = new Set([StrataPath("/"), StrataPath("/api/boards"), StrataPath("/api/decks"), StrataPath("/api/register"), StrataPath(`/api/boards/${id}`), StrataPath(`/api/boards/${id}/touched`)]);
  for (const el of document.querySelectorAll<HTMLScriptElement & HTMLLinkElement>("script[src], link[rel=stylesheet]")) urls.add(el.src || el.href);
  for (const asset of assets) urls.add(StrataPath("/" + asset));
  urls.add(StrataPath("/pdf.worker.min.js"));
  try { for (const e of performance.getEntriesByType("resource")) if (/\.(js|jsx|mjs|css|woff2?)(\?|$)/.test(e.name)) urls.add(e.name); } catch { /* no resource timing */ }
  try {
    const cssUrl = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")).map((l) => l.href).find((h) => /katex/i.test(h));
    const css = cssUrl ? await (await fetchAsset(cssUrl)).text() : "";
    for (const m of css.matchAll(/url\((['"]?)([^)'"]+?\.woff2)\1\)/g)) urls.add(new URL(m[2], cssUrl).href);
  } catch { /* maths falls back to whatever fonts are already cached */ }
  for (const p of b.pairs || []) if (p.deck) urls.add(StrataPath(`/api/decks/${p.deck}`));
  for (const r of b.resources || []) {
    urls.add(StrataPath(`/api/boards/${id}/messages?resource=${encodeURIComponent(r.id)}`));
    urls.add(StrataAPI.resourceRawUrl(id, r.id));
    if (r.kind !== "pdf") urls.add(StrataPath(`/api/boards/${id}/resources/${r.id}/preview`));
    urls.add(StrataPath(`/api/boards/${id}/resources/${r.id}/tree`));
  }
  for (const s of b.sections || []) urls.add(StrataPath(`/api/boards/${id}/resources/${s.resourceId}/tree?section=${encodeURIComponent(s.id)}`));
  const list = Array.from(urls);
  let done = 0, missed = 0;
  tell(`0 / ${list.length}`);
  const pull = async () => {
    while (list.length) {
      const u = list.shift() as string;
      // a 404 means the source was never distilled, not a miss
      try { await saveOfflineUrl(u); }
      catch { missed++; }
      done++; tell(`${done} / ${done + list.length}`);
    }
  };
  await Promise.all([pull(), pull(), pull(), pull()]);
  if (!missed) try { localStorage.setItem("strata.offline." + id, String(Date.now())); } catch { /* private window */ }
  tell(null);
  StrataAPI.log("board_offline", { board: id, urls: done, missed });
  toast(missed ? `download incomplete — ${missed} files couldn't be saved; reconnect or free device storage and retry` : "downloaded for offline reading");
}

export function DownloadButton({ boardId, onDownload }: { boardId: string | null; onDownload(): void }) {
  const keeping = useSyncExternalStore(subscribe, now, now);
  const offKept = downloadedAt(boardId);
  return (
    <button className="bh-dl" onClick={onDownload} disabled={!!keeping}
      title={offKept ? "downloaded " + new Date(offKept).toLocaleDateString() + " — download again to refresh" : "keep this board readable offline"}>
      {keeping ? "downloading " + keeping : offKept ? "offline ✓" : "download"}</button>
  );
}
