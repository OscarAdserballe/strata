// A source's primer: the overview page the reader's routine writes, opened beside the source before page 1.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import { useQuery } from "../../data/store.ts";
import { mutate } from "../../data/mutate.ts";
import { primerKey, primerOps, primerRead, primerRecheck, type PrimerEntity } from "../../data/entities/primers.ts";
import { HtmlEngine } from "../../engines/html/HtmlEngine.ts";
import { barSlot } from "./barSlot.ts";

const POLL_FIRST = 15_000, POLL_MOST = 120_000;

/** The sandboxed page; it keeps no state, so its bridge is answered with nothing. */
function PrimerPage({ url, scale }: { url: string; scale: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engine = useRef<HtmlEngine | null>(null);
  useEffect(() => {
    engine.current ??= new HtmlEngine({
      onSelect: () => {}, onMark: () => {}, onPress: () => {},
      onLoad: () => Promise.resolve(null),
      onSave: () => Promise.reject(new Error("a primer keeps no state")),
    });
    if (hostRef.current) engine.current.open(hostRef.current, url);
  }, [url]);
  useEffect(() => () => engine.current?.dispose(), []);
  return <div className="primer-page" ref={hostRef} style={scale !== 1 ? { zoom: String(1 / scale) } : undefined} />;
}

function Ask({ label, onAsk }: { label: string; onAsk: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  return <>
    <button className="primer-ask" disabled={busy} onClick={() => { setBusy(true); setWhy(null); void onAsk().catch((e) => setWhy(StrataWhy(e, "couldn't ask"))).finally(() => setBusy(false)); }}>{label}</button>
    {why ? <p role="alert" className="primer-why">{why}</p> : null}
  </>;
}

const SAYS: Record<PrimerEntity["status"], string> = { none: "none yet", requested: "being written", ready: "ready", stale: "source changed" };

/** scale: the zoom the room paints at; the page undoes it, so a ~420px panel is ~420px to the page. */
export default function Primer({ board, rid, scale }: { board: string; rid: string; scale: number }) {
  const p = useQuery<PrimerEntity>(primerKey(rid), primerRead(board, rid));
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const bar = useSyncExternalStore(barSlot.subscribe, barSlot.get);
  const status = p?.status ?? "none";

  // only a requested primer can change by itself: the routine writes it
  useEffect(() => {
    if (status !== "requested") return;
    let live = true, delay = POLL_FIRST;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!live || document.hidden) return;
      try { if ((await primerRecheck(board, rid))?.status !== "requested") return; } catch { /* the next try says */ }
      delay = Math.min(delay * 2, POLL_MOST);
      if (live) timer = setTimeout(poll, delay);
    };
    const shown = () => { clearTimeout(timer); if (!document.hidden) void poll(); };
    timer = setTimeout(poll, delay);
    document.addEventListener("visibilitychange", shown);
    return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", shown); };
  }, [board, rid, status]);

  const ask = () => mutate(primerOps.request(board, rid)).then(() => {});
  const url = p?.hasPage ? StrataAPI.primerPageUrl(board, rid, p.builtAt) : null;
  const chip = (
    <button className={"rbar-chip rbar-primer primer-" + status + (open ? "" : " off")} aria-pressed={open} aria-expanded={open}
      title={`primer · ${SAYS[status]}`} onClick={() => setOpen((v) => !v)}>
      <i />primer{status === "requested" ? <b>…</b> : status === "stale" ? <b>!</b> : null}
    </button>
  );
  return <>
    {bar ? createPortal(chip, bar) : null}
    {open
      ? <aside className={"primer" + (wide ? " wide" : "")} aria-label="primer">
          <header className="primer-head">
            <b>Primer</b><span className="primer-state">{SAYS[status]}</span>
            <span className="primer-grow" />
            {url ? <button onClick={() => setWide((v) => !v)} title={wide ? "narrower" : "wider"}>{wide ? "→←" : "←→"}</button> : null}
            <button onClick={() => setOpen(false)} title="close">✕</button>
          </header>
          {status === "stale" ? <div className="primer-note">The source changed since this was written. <Ask label="Rebuild" onAsk={ask} /></div> : null}
          {status === "requested" && url ? <div className="primer-note">A new one is being written; this is the last one.</div> : null}
          {url
            ? <PrimerPage url={url} scale={scale} />
            : status === "requested"
              ? <div className="primer-empty"><p><b>Being written…</b></p><p>Your routine writes it on its next run. It shows here when it lands.</p></div>
              : <div className="primer-empty">
                  <p>A primer is one page to read before page 1: what this source is about, the threads to follow through it, and where it lands.</p>
                  <Ask label="Ask for a primer" onAsk={ask} />
                </div>}
        </aside>
      : null}
  </>;
}
