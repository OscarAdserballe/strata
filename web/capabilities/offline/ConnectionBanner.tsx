import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { StrataCheckConnection, StrataConnection } from "../../data/api.ts";
import { updateInterface } from "./offline.ts";
import { grades } from "../../data/entities/grades.ts";
import { ClashList, useClashes, useMarksWaiting } from "./Clashes.tsx";

export default function ConnectionBanner() {
  const [connection, setConnection] = useState(StrataConnection);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const banner = useRef<HTMLDivElement>(null);
  const reviews = useSyncExternalStore(grades.subscribe, () => grades.getSnapshot().pending);
  const marking = useMarksWaiting();
  const clashes = useClashes().length;
  const [open, setOpen] = useState(false);
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
  const visible = connection.offline || connection.needsReload || clashes > 0;
  useLayoutEffect(() => {
    const measure = () => document.documentElement.style.setProperty("--connection-height", `${banner.current?.offsetHeight || 0}px`);
    measure();
    const observer = new ResizeObserver(measure);
    if (banner.current) observer.observe(banner.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--connection-height"); };
  }, [visible]);
  if (!visible) return null;
  const update = async () => {
    setBusy(true); setError("");
    try { await updateInterface(); } catch (e) { setError(e instanceof Error ? e.message : "Could not update. Try again when connected."); }
    finally { setBusy(false); }
  };
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const waiting = [reviews ? plural(reviews, "review") : "", marking ? plural(marking, "highlight or note") : ""].filter(Boolean).join(" and ");
  return <div ref={banner} className="connection-banner" role="status" aria-live="polite">
    {connection.offline ? <span><strong>Offline</strong> · {savedAt ? `saved copies from ${new Date(savedAt).toLocaleString()}` : "saved date unavailable"} · {waiting ? `${waiting} waiting to sync` : "reviews, highlights and notes save and sync later"} · other changes can’t be saved</span>
      : connection.needsReload ? <><span>{connection.outdated ? "Strata was updated · this page is an older version." : "Back online · reload to refresh saved content."}</span>
        <button onClick={update} disabled={busy}>{busy ? "Checking…" : connection.outdated ? "Reload" : "Refresh now"}</button></> : null}
    {clashes ? <><span>{plural(clashes, "offline change")} didn’t fit</span><button onClick={() => setOpen(true)}>Resolve</button></> : null}
    {error ? <span>{error}</span> : null}
    {open ? <ClashList onClose={() => setOpen(false)} /> : null}
  </div>;
}
