import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { StrataCheckConnection, StrataConnection } from "../../data/api.ts";
import { clashes, pending, subscribeClashes, subscribePending } from "../../data/mutate.ts";
import { updateInterface } from "./offline.ts";
import { grades } from "../../data/entities/grades.ts";
import ClashList from "./ClashList.tsx";

// a number, not the list: the banner draws again only when the count moves
const keptCount = () => pending().reduce((n, p) => n + (p.kept ? 1 : 0), 0);
const clashCount = () => clashes().length;

export default function ConnectionBanner() {
  const [connection, setConnection] = useState(StrataConnection);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const banner = useRef<HTMLDivElement>(null);
  const waiting = useSyncExternalStore(grades.subscribe, () => grades.getSnapshot().pending);
  const kept = useSyncExternalStore(subscribePending, keptCount);
  const clashing = useSyncExternalStore(subscribeClashes, clashCount);
  useEffect(() => {
    // every API response announces itself; only a response that changed something may commit
    const changed = () => setConnection((was) => {
      const now = StrataConnection();
      return (Object.keys(now) as (keyof typeof now)[]).every((k) => now[k] === was[k]) ? was : now;
    });
    let checking = false;
    const check = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try { await StrataCheckConnection(); } finally { checking = false; }
    };
    window.addEventListener("strata:connection", changed);
    window.addEventListener("online", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, 30000);
    changed(); void check();
    return () => {
      clearInterval(timer);
      window.removeEventListener("strata:connection", changed);
      window.removeEventListener("online", check);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  let savedAt = connection.savedAt;
  if (!savedAt) try {
    const board = new URLSearchParams(location.search).get("board");
    if (board) savedAt = Number(localStorage.getItem(`strata.offline.${board}`)) || null;
  } catch { /* Old copies may not have a recorded date. */ }
  const visible = connection.offline || connection.needsReload || clashing > 0 || kept > 0;
  useLayoutEffect(() => {
    const measure = () => document.documentElement.style.setProperty("--connection-height", `${banner.current?.offsetHeight || 0}px`);
    measure();
    const observer = new ResizeObserver(measure);
    if (banner.current) observer.observe(banner.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--connection-height"); };
  }, [visible, open]);
  if (!visible) return null;
  const update = async () => {
    setBusy(true); setError("");
    try { await updateInterface(); } catch (e) { setError(e instanceof Error ? e.message : "Could not update. Try again when connected."); }
    finally { setBusy(false); }
  };
  // grades keep their own shelf (entities/grades.ts); every other kept write is in the outbox
  const owed = kept + (connection.offline ? waiting : 0);
  const keeping = owed ? `${owed} ${owed === 1 ? "change" : "changes"} kept on this device, they sync when you’re back` : "grades, marks and keeps are kept on this device until you’re back";
  return <div ref={banner} className="connection-banner" role="status" aria-live="polite">
    {connection.offline ? <span><strong>Offline</strong> · {savedAt ? `saved copies from ${new Date(savedAt).toLocaleString()}` : "saved date unavailable"} · {keeping}</span>
      : kept ? <span>Syncing {kept} {kept === 1 ? "change" : "changes"} made offline…</span>
      : connection.needsReload ? <><span>{connection.outdated ? "Strata was updated · this page is an older version." : "Back online · reload to refresh saved content."}</span>
        <button onClick={update} disabled={busy}>{busy ? "Checking…" : connection.outdated ? "Reload" : "Refresh now"}</button></> : null}
    {clashing ? <button className="clash-count" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{clashing} {clashing === 1 ? "clash" : "clashes"} to settle</button> : null}
    {error ? <span>{error}</span> : null}
    {open && clashing ? <ClashList /> : null}
  </div>;
}
