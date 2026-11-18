// The source's primer: a chip in the reader's bar that opens a page an agent drew to read before page 1, beside the source.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { prefetch } from "../../data/api.ts";
import { store, useQuery } from "../../data/store.ts";
import { primerKey, primerPageUrl, primerRead, primers, type PrimerEntity } from "../../data/entities/primers.ts";

export interface PrimerProps { board: string; rid: string; bar: HTMLElement | null; hidden: boolean }

export default function Primer({ board, rid, bar, hidden }: PrimerProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [rid]);
  const chip = bar && !hidden
    ? createPortal(<button className={"rbar-chip primer" + (open ? "" : " off")} aria-pressed={open} title={open ? "hide the primer" : "show the primer"}
        onPointerDown={() => void prefetch(`/api/boards/${board}/resources/${rid}/primer`).catch(() => {})}
        onClick={() => setOpen((v) => !v)}><i />primer</button>, bar)
    : null;
  return <>{chip}{open && !hidden ? <PrimerPanel board={board} rid={rid} onClose={() => setOpen(false)} /> : null}</>;
}

function PrimerPanel({ board, rid, onClose }: { board: string; rid: string; onClose(): void }) {
  const p = useQuery<PrimerEntity>(primerKey(rid), primerRead(board, rid));
  const [failed, setFailed] = useState<string | null>(null);
  const ask = () => { setFailed(null); primers.ask(board, rid).catch((e: Error) => setFailed(e.message || "couldn't ask")); };
  // while the routine writes it: look again now and then, never while the tab is hidden, slower the longer it takes
  useEffect(() => {
    if (p?.status !== "asked") return;
    let delay = 10_000, timer: ReturnType<typeof setTimeout>;
    const tick = () => { if (!document.hidden) void store.refetch(primerKey(rid)); delay = Math.min(delay * 1.5, 60_000); timer = setTimeout(tick, delay); };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
  }, [p?.status, rid]);
  return (
    <aside className="primer-panel" aria-label="primer">
      <header>
        <b>Primer</b>
        {p?.hasPage ? <button onClick={ask} disabled={p.status === "asked"}>{p.status === "asked" ? "rewriting…" : "rewrite"}</button> : null}
        <button onClick={onClose} title="close" aria-label="close">✕</button>
      </header>
      {p?.hasPage
        ? <iframe key={p.builtAt ?? 0} title="primer" src={primerPageUrl(board, rid, p.builtAt)}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms" />
        : <div className="primer-empty">{
            !p ? "…"
            : p.status === "asked" ? <p>Your routine is writing it. It usually takes a few minutes; it appears here when it's done.</p>
            : <><p>A primer is one page to read before page 1: what this source is about, the threads to follow through it and where it ends up, drawn by your routine.</p>
                <button className="primer-ask" onClick={ask}>Make a primer</button></>
          }{failed ? <p className="primer-err">{failed}</p> : null}</div>}
    </aside>
  );
}
