import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { StrataCheckConnection, StrataConnection } from "../../data/api.ts";
import { updateInterface } from "./offline.ts";
import { grades } from "../../data/entities/grades.ts";
import { outbox } from "../../data/outbox.ts";
import ClashList from "./ClashList.tsx";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A sync with nothing to look at says so and goes. */
const SYNCED_MS = 8000;
/** The wire calls itself down only after its grace; the marker then lingers 3 s after it is back, so a flaky signal doesn't blink it. */
const HIDE_MS = 3000;

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
  const [marked, setMarked] = useState(connection.offline);
  useEffect(() => {
    if (connection.offline === marked) return;
    if (connection.offline) { setMarked(true); return; }
    const t = setTimeout(() => setMarked(false), HIDE_MS);
    return () => clearTimeout(t);
  }, [connection.offline, marked]);
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
  // the full-width bar is for a choice only you can make: which of two versions to keep
  const visible = clashes > 0 && !connection.offline;
  useLayoutEffect(() => {
    const measure = () => document.documentElement.style.setProperty("--connection-height", `${banner.current?.offsetHeight || 0}px`);
    measure();
    const observer = new ResizeObserver(measure);
    if (banner.current) observer.observe(banner.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--connection-height"); };
  }, [visible]);
  const update = async () => {
    setBusy(true); setError("");
    try { await updateInterface(); } catch (e) { setError(e instanceof Error ? e.message : "Could not update. Try again when connected."); }
    finally { setBusy(false); }
  };
  if (!visible) {
    const line = marked ? "Offline" : connection.needsReload ? (connection.outdated ? "Strata was updated" : "Back online") : synced ? `Synced ${plural(synced, "change")}` : null;
    if (!line) return null;
    const why = marked ? [waiting ? `${plural(waiting, "change")} kept on this device` : "changes are kept on this device", savedAt ? `saved ${new Date(savedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "saved date unavailable"].join(" · ") : undefined;
    return <div className={"connection-mark" + (marked ? " off" : "")} role="status" aria-live="polite" title={why}>
      <i aria-hidden="true" />{line}{marked && waiting ? <span className="n">{waiting}</span> : null}
      {!marked && connection.needsReload ? <button onClick={update} disabled={busy}>{busy ? "Checking…" : connection.outdated ? "Reload" : "Refresh"}</button> : null}
      {error ? <span className="err">{error}</span> : null}
    </div>;
  }
  const clashLine = told ? `Synced ${synced} · ${plural(clashes, "clash", "clashes")}` : clashes ? `${plural(clashes, "clash", "clashes")} from offline` : "";
  return <div ref={banner} className="connection-banner" role="status" aria-live="polite">
    {clashLine ? <span className="sync-line">{clashLine}</span> : null}
    <button onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}>{listOpen ? "Hide clashes" : "Show clashes"}</button>
    {connection.needsReload ? <><span>{connection.outdated ? "Strata was updated · this page is an older version." : "Back online · reload to refresh saved content."}</span>
      <button onClick={update} disabled={busy}>{busy ? "Checking…" : connection.outdated ? "Reload" : "Refresh now"}</button></> : null}
    {error ? <span>{error}</span> : null}
    {listOpen ? <div className="clash-row"><ClashList clashes={box.clashes} onClose={() => setListOpen(false)} /></div> : null}
  </div>;
}
