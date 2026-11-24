import { useSyncExternalStore } from "react";
import type { BoardState } from "../../../shared/types/index.ts";
import { StrataConnection, StrataMB, StrataPath, StrataWireDown } from "../../data/api.ts";
import { imagesIn, savedUrls } from "../../data/offline-coverage.ts";
import { fetchAsset, saveImage, saveOfflineUrl, savedText } from "./offline.ts";
import { ledgerOf, notSaved, useLedger, writeLedger, type Missed } from "./ledger.ts";

// progress lives in its own store, so each step re-renders the button and not the room

interface Say { toast(t: string, ms?: number): void; toastWhy(e: unknown, said: string): void }

let progress: string | null = null;
const heard = new Set<() => void>();
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
const tell = (v: string | null) => { progress = v; for (const cb of [...heard]) cb(); };
const now = () => progress;

/** A download asked for on a page the worker didn't control yet: started again after the reload it needs. */
const RESUME = "strata.offline.resume";
export function resumeDownload(id: string | null, b: BoardState | null, say: Say): void {
  try {
    if (!id || !b || sessionStorage.getItem(RESUME) !== id || !navigator.serviceWorker?.controller) return;
    sessionStorage.removeItem(RESUME);
  } catch { return; }
  void downloadBoard(id, b, say);
}

export const downloadedAt = (id: string | null): number => ledgerOf(id)?.at ?? 0;

const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const why = (e: unknown) => (e instanceof Error && e.message ? e.message : "not saved");

export async function downloadBoard(id: string | null, b: BoardState | null, say: Say): Promise<void> {
  const { toast, toastWhy } = say;
  if (!id || !b || progress) return;
  if (StrataWireDown()) { toast("reconnect before downloading for offline use"); return; }
  const build = StrataConnection().serverBuild;
  if (build && window.STRATA_BUILD && build !== window.STRATA_BUILD) { toast("reload Strata before downloading, so the saved interface matches"); return; }
  if (!("serviceWorker" in navigator)) { toast("this browser can't keep boards"); return; }
  // the worker only intercepts pages it controls, which begins one load after install
  if (!navigator.serviceWorker.controller) {
    if (!window.confirm("Strata needs to reload once before this device can keep boards. Reload now and download?")) return;
    try { sessionStorage.setItem(RESUME, id); } catch { /* the reader presses Download again */ }
    location.reload();
    return;
  }
  let assets: string[];
  try {
    const manifest = await fetchAsset(StrataPath("/dist/offline-assets.json"), { cache: "no-store" });
    if (!manifest.ok) throw new Error("missing interface manifest");
    assets = (await manifest.json()).assets;
    if (!Array.isArray(assets) || !assets.length) throw new Error("invalid interface manifest");
  } catch (e) { toastWhy(e, "couldn't download the interface"); return; }
  // Safari evicts Cache Storage for sites it thinks you left, unless storage is persistent
  let kept: boolean | null = null;
  try { kept = navigator.storage?.persist ? await navigator.storage.persist() : null; } catch { /* best effort */ }
  const urls = new Set([StrataPath("/")]);
  for (const el of document.querySelectorAll<HTMLScriptElement & HTMLLinkElement>("script[src], link[rel=stylesheet]")) urls.add(el.src || el.href);
  for (const asset of assets) urls.add(StrataPath("/" + asset));
  urls.add(StrataPath("/pdf.worker.min.js"));
  try { for (const e of performance.getEntriesByType("resource")) if (/\.(js|jsx|mjs|css|woff2?)(\?|$)/.test(e.name)) urls.add(e.name); } catch { /* no resource timing */ }
  try {
    const cssUrl = Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")).map((l) => l.href).find((h) => /katex/i.test(h));
    const css = cssUrl ? await (await fetchAsset(cssUrl)).text() : "";
    for (const m of css.matchAll(/url\((['"]?)([^)'"]+?\.woff2)\1\)/g)) urls.add(new URL(m[2], cssUrl).href);
  } catch { /* maths falls back to whatever fonts are already cached */ }
  // every read the coverage table marks saved, for this board
  for (const u of savedUrls({ board: id, state: b, since: midnight() })) urls.add(StrataPath(u));
  const list = Array.from(urls, (url) => ({ url, image: false }));
  const texts = new Set((b.resources || []).filter((r) => r.kind !== "pdf").map((r) => StrataPath(`/api/boards/${id}/resources/${r.id}/raw`)));
  const missed: Missed[] = [];
  let done = 0;
  tell(`0 / ${list.length}`);
  const pull = async () => {
    while (list.length) {
      const { url, image } = list.shift()!;
      try {
        if (image) await saveImage(url);
        else await saveOfflineUrl(url);
        // a note's images are cached only once seen, so the ones its text names are saved with it
        if (texts.has(url)) for (const img of imagesIn(await savedText(url))) list.push({ url: StrataPath(img), image: true });
      } catch (e) { missed.push({ url, why: why(e) }); }
      done++; tell(`${done} / ${done + list.length}`);
    }
  };
  await Promise.all([pull(), pull(), pull(), pull()]);
  let bytes: number | null = null, free: number | null = null;
  try { const est = await navigator.storage?.estimate?.(); if (est) { bytes = est.usage ?? null; free = est.quota != null && est.usage != null ? est.quota - est.usage : null; } } catch { /* no estimate */ }
  writeLedger(id, { at: Date.now(), title: b.board?.title || "", resources: (b.resources || []).map((r) => r.id), missed, bytes, kept });
  tell(null);
  const room = bytes != null ? ` · Strata uses ${StrataMB(bytes)}${free != null ? ` of ${StrataMB(free + bytes)}` : ""}` : "";
  const evictable = kept === false ? " · this browser may clear it: add Strata to your Home Screen to keep it" : "";
  toast(missed.length
    ? `downloaded, but ${missed.length} ${missed.length === 1 ? "file" : "files"} couldn't be saved — the button lists them${room}`
    : `downloaded for offline reading${room}${evictable}`, missed.length || evictable ? 8000 : 4200);
}

export function DownloadButton({ boardId, resources, onDownload }: { boardId: string | null; resources: { id: string; filename?: string }[]; onDownload(): void }) {
  const keeping = useSyncExternalStore(subscribe, now, now);
  const ledger = useLedger(boardId);
  const fresh = notSaved(ledger, resources);
  const missing = ledger?.missed.length ?? 0;
  const label = keeping ? "downloading " + keeping
    : !ledger ? "download"
    : missing ? `offline · ${missing} missing`
    : fresh ? `offline · ${fresh} new`
    : "offline ✓";
  const title = !ledger ? "keep this board readable offline"
    : [
      `downloaded ${new Date(ledger.at).toLocaleString()}`,
      missing ? `not saved:\n${ledger.missed.slice(0, 8).map((m) => `  ${m.url.replace(/^.*\/api\//, "")} — ${m.why}`).join("\n")}${missing > 8 ? `\n  …and ${missing - 8} more` : ""}` : "",
      fresh ? `${fresh} ${fresh === 1 ? "source was" : "sources were"} added since` : "",
      ledger.kept === false ? "this browser may clear saved boards" : "",
      "click to download again",
    ].filter(Boolean).join("\n");
  return (
    <button className={`bh-dl${ledger && (missing || fresh) ? " bh-dl-gap" : ""}`} onClick={onDownload} disabled={!!keeping} title={title}>{label}</button>
  );
}
