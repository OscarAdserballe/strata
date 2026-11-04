import { useEffect, useState } from "react";
import { StrataAPI, StrataPath } from "../data/api.ts";
import { ImportsStatus } from "../capabilities/sources/ImportsPanel.tsx";
import { loadCapture } from "../capabilities/sources/AddSource.tsx";
import Suggest from "../capabilities/feedback/Suggest.tsx";
import { openKeysSheet } from "../capabilities/keys/registry.ts";

export interface StatusBarProps {
  onBoards(): void;
  homeOff: boolean;
  onHome(): void;
  onAdd(kind: "file" | "link", study?: boolean): void;
  solo: string | null;
  imports: boolean;
  onImport(board: string, resource?: string): void;
  follow: boolean | null;
  onFollow(): void;
  onNewCard(): void;
  adminPath: string | null;
  onSignOut(): void;
}

export default function StatusBar(p: StatusBarProps) {
  const [addMenu, setAddMenu] = useState(false);
  const [study, setStudy] = useState(true);
  useEffect(() => {
    if (!addMenu) return;
    const shut = () => setAddMenu(false);
    document.addEventListener("click", shut);
    document.addEventListener("keydown", shut, true);
    return () => { document.removeEventListener("click", shut); document.removeEventListener("keydown", shut, true); };
  }, [addMenu]);
  const add = (kind: "file" | "link") => { setAddMenu(false); p.onAdd(kind, study); };
  return (
    <div className="status">
      <button className="seg" onClick={p.onBoards} title="all boards (b)">boards</button>
      <button className="seg k" disabled={p.homeOff} onClick={p.onHome} title="this board's log">home</button>
      <button className="seg help addsrc" onClick={(e) => { e.stopPropagation(); if (!addMenu) setStudy(true); setAddMenu(!addMenu); }}
        title="add a source — a file, or from a link">+
        {addMenu ? <span className="addmenu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => add("file")}><b>a file</b>pdf / md / txt / html</button>
          <button className="addmenu-study" aria-pressed={study} title="Make flashcards from the file as it arrives; you can always make them later"
            onClick={() => setStudy((v) => !v)}>make flashcards: {study ? "on" : "off"}</button>
          <button onPointerDown={() => void loadCapture().catch(() => {})} onClick={() => add("link")}><b>from a link</b>youtube / article</button>
        </span> : null}
      </button>
      {p.solo ? <span className="seg dim">{p.solo}</span> : null}
      <span className="seg grow" />
      {p.imports ? <ImportsStatus onOpen={p.onImport} /> : null}
      {p.follow !== null ? <button className="seg" aria-pressed={p.follow} title="Switch the deck automatically as you read into another chapter"
        onClick={p.onFollow}>Follow chapters: {p.follow ? "on" : "off"}</button> : null}
      <button className="seg help newcard" onClick={p.onNewCard} title="make a card (c grabs the last answer)">
        <svg viewBox="0 0 15 12" width="15" height="12" aria-hidden="true">
          <rect x="0.75" y="2.75" width="10.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <line x1="3" y1="6.1" x2="9" y2="6.1" stroke="currentColor" strokeWidth="1.1" opacity="0.55" />
          <line x1="3" y1="8.6" x2="7" y2="8.6" stroke="currentColor" strokeWidth="1.1" opacity="0.55" />
          <line x1="12.4" y1="0.6" x2="12.4" y2="5.4" stroke="currentColor" strokeWidth="1.4" />
          <line x1="10" y1="3" x2="14.8" y2="3" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <button className="seg help" onClick={openKeysSheet} title="every shortcut (?)">?</button>
      <Suggest />
      {p.adminPath ? <button className="seg" onClick={() => location.assign(p.adminPath!)}>Admin</button> : null}
      <button className="seg" onClick={p.onSignOut}>Log out</button>
    </div>
  );
}

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
