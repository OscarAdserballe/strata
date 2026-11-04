import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { StrataCheckConnection, StrataConnection } from "../../data/api.ts";
import { updateInterface } from "./offline.ts";

export default function ConnectionBanner() {
  const [connection, setConnection] = useState(StrataConnection);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const banner = useRef<HTMLDivElement>(null);
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
  const visible = connection.offline || connection.needsReload;
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
  return <div ref={banner} className="connection-banner" role="status" aria-live="polite">
    {connection.offline ? <span><strong>Offline</strong> · {savedAt ? `saved copies from ${new Date(savedAt).toLocaleString()}` : "saved date unavailable"} · changes can’t be saved</span>
      : <><span>{connection.outdated ? "Strata was updated · this page is an older version." : "Back online · reload to refresh saved content."}</span>
        <button onClick={update} disabled={busy}>{busy ? "Checking…" : connection.outdated ? "Reload" : "Refresh now"}</button></>}
    {error ? <span>{error}</span> : null}
  </div>;
}
