import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { StrataCheckConnection, StrataConnection } from "../../data/api.ts";
import { updateInterface } from "./offline.ts";
import { grades } from "../../data/entities/grades.ts";
import { outbox } from "../../data/outbox.ts";
import ClashList from "./ClashList.tsx";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A sync with nothing to look at says so and goes. */
const SYNCED_MS = 8000;

export default function ConnectionBanner() {
  const [connection, setConnection] = useState(StrataConnection);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const banner = useRef<HTMLDivElement>(null);
  const gradesWaiting = useSyncExternalStore(grades.subscribe, () => grades.getSnapshot().pending);
  const box = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);
  const waiting = box.waiting + gradesWaiting;
  // one stretch offline: what had synced when it began, and the most grades it owed
  const [round, setRound] = useState<{ synced: number; grades: number; back: boolean } | null>(null);
  const [listOpen, setListOpen] = useState(false);
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
  useEffect(() => {
    if (connection.offline) setRound((r) => (r && !r.back ? (r.grades >= gradesWaiting ? r : { ...r, grades: gradesWaiting }) : { synced: outbox.getSnapshot().synced, grades: gradesWaiting, back: false }));
    else setRound((r) => (r && !r.back ? { ...r, back: true } : r));
  }, [connection.offline, gradesWaiting]);
  const synced = round?.back && !waiting ? box.synced - round.synced + round.grades : null;
  const clashes = box.clashes.length;
  useEffect(() => {
    if (synced === null || clashes) return;
    if (!synced) { setRound(null); return; }
    const t = setTimeout(() => setRound(null), SYNCED_MS);
    return () => clearTimeout(t);
  }, [synced, clashes]);
  let savedAt = connection.savedAt;
  if (!savedAt) try {
    const board = new URLSearchParams(location.search).get("board");
    if (board) savedAt = Number(localStorage.getItem(`strata.offline.${board}`)) || null;
  } catch { /* Old copies may not have a recorded date. */ }
  const told = synced !== null && (synced > 0 || clashes > 0);
  const visible = connection.offline || connection.needsReload || told || clashes > 0;
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
  const clashLine = told ? `Synced ${synced} · ${plural(clashes, "clash", "clashes")}` : clashes ? `${plural(clashes, "clash", "clashes")} from offline` : "";
  return <div ref={banner} className="connection-banner" role="status" aria-live="polite">
    {connection.offline ? <span><strong>Offline</strong> · {waiting ? `${plural(waiting, "change")} kept on this device` : "changes are kept on this device"} · {savedAt ? `saved copies from ${new Date(savedAt).toLocaleString()}` : "saved date unavailable"}</span>
      : <>
        {clashLine ? <span className="sync-line">{clashLine}</span> : null}
        {clashes ? <button onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}>{listOpen ? "Hide clashes" : "Show clashes"}</button> : null}
        {connection.needsReload ? <><span>{connection.outdated ? "Strata was updated · this page is an older version." : "Back online · reload to refresh saved content."}</span>
          <button onClick={update} disabled={busy}>{busy ? "Checking…" : connection.outdated ? "Reload" : "Refresh now"}</button></> : null}
      </>}
    {error ? <span>{error}</span> : null}
    {listOpen && clashes && !connection.offline ? <ClashList clashes={box.clashes} onClose={() => setListOpen(false)} /> : null}
  </div>;
}
