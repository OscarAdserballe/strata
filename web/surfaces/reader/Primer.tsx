import { useEffect, useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { useQuery } from "../../data/store.ts";
import { primerKey, primerPageUrl, primerRead, primers, type Primer } from "../../data/entities/primers.ts";
import { LIVE_SANDBOX } from "../../engines/html/HtmlEngine.ts";

// A primer: Claude's page about this source, read beside it before page 1. Asked for here, written by the routine.

const usePrimer = (board: string, rid: string): Primer | undefined => useQuery<Primer>(primerKey(rid), primerRead(board, rid));

const FIRST_MS = 3000, MOST_MS = 30_000;

function usePrimerWait(board: string, rid: string, waiting: boolean): void {
  useEffect(() => {
    if (!waiting) return;
    let live = true, delay = FIRST_MS, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      timer = undefined;
      if (!live || document.hidden) return;
      try { await primers.refresh(board, rid); } catch { /* the next look tries again */ }
      delay = Math.min(delay * 1.6, MOST_MS);
      if (live && !document.hidden) timer = setTimeout(tick, delay);
    };
    const shown = () => { if (!document.hidden && live && timer === undefined) { delay = FIRST_MS; void tick(); } };
    document.addEventListener("visibilitychange", shown);
    timer = setTimeout(tick, FIRST_MS);
    return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", shown); };
  }, [board, rid, waiting]);
}

const SAID: Record<Primer["status"], string> = { none: "", asked: "writing", ready: "", stale: "out of date" };

// the chip, not the panel, watches an asked primer: it is up whenever the source is
export function PrimerChip({ board, rid, on, onFlip }: { board: string; rid: string; on: boolean; onFlip: () => void }) {
  const p = usePrimer(board, rid);
  usePrimerWait(board, rid, p?.status === "asked");
  const said = p ? SAID[p.status] : "";
  return (
    <button type="button" className={"rbar-chip primer-chip" + (on ? "" : " off") + (p && p.status !== "none" ? " has" : "")} aria-pressed={on}
      title={on ? "close the primer" : "the primer: a page to read before this source"} onMouseDown={(e) => e.preventDefault()} onClick={onFlip}>
      <i />primer{said ? <b>{said}</b> : null}
    </button>
  );
}

function AskPrimer({ board, rid, label }: { board: string; rid: string; label: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button type="button" className="primer-ask" onClick={() => { setError(null); primers.ask(board, rid).catch((e: unknown) => setError(StrataWhy(e, "couldn't ask for it"))); }}>{label}</button>
      {error ? <p role="alert" className="primer-error">{error}</p> : null}
    </>
  );
}

export function PrimerPanel({ board, rid, scale, onClose }: { board: string; rid: string; scale: number; onClose: () => void }) {
  const p = usePrimer(board, rid);
  const status = p?.status;
  return (
    <div className="primer">
      <div className="primer-head">
        <span className="primer-title">Primer</span>
        {status === "asked" && p?.page ? <span className="primer-note">Claude is remaking it…</span> : null}
        {status === "stale" ? <span className="primer-note stale">out of date · <AskPrimer board={board} rid={rid} label="remake" /></span> : null}
        <span className="primer-grow" />
        <button type="button" className="primer-close" onClick={onClose} title="close the primer">✕</button>
      </div>
      {!p
        ? <p className="primer-empty">reading…</p>
        : p.page
        ? <div className="primer-body"><div className="primer-host" style={scale !== 1 ? { zoom: String(1 / scale) } : undefined}>
            <iframe className="primer-frame" title="primer" sandbox={LIVE_SANDBOX} src={primerPageUrl(board, rid, p.builtAt)} />
          </div></div>
        : status === "asked"
        ? <p className="primer-empty">Claude is writing it…</p>
        : <div className="primer-empty">
            <p>A page to read before this source: the threads to follow, what matters, the main results, drawn by Claude.</p>
            <AskPrimer board={board} rid={rid} label="Make a primer" />
          </div>}
    </div>
  );
}
