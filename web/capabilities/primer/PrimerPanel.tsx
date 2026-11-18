import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ResourceMeta } from "../../../shared/types/index.ts";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import { primers } from "../../data/entities/primers.ts";
import { pageAsked, primerPanel, primerView } from "./primer.ts";
import { usePrimerWait } from "./usePrimerWait.ts";
import "./primer.css";

/** The bar's toggle: the panel's word for this source's primer, beside the layers. */
export function PrimerToggle({ src }: { src: ResourceMeta }) {
  const panel = useSyncExternalStore(primerPanel.subscribe, primerPanel.get);
  const v = primerView(src.primer);
  return (
    <button type="button" className={"rbar-primer" + (panel.open ? " on" : "") + (v.stale ? " stale" : "")} aria-pressed={panel.open}
      title={panel.open ? "hide the primer" : "show this source's primer: its shape before you read it"}
      onMouseDown={(e) => e.preventDefault()} onClick={() => primerPanel.set({ open: !panel.open })}>
      primer{v.tag ? <b>{v.tag}</b> : null}
    </button>
  );
}

function AskButton({ board, src, label }: { board: string; src: ResourceMeta; label: string }) {
  const [busy, setBusy] = useState(false), [why, setWhy] = useState<string | null>(null);
  const ask = () => {
    setBusy(true); setWhy(null);
    primers.request(board, src.id).then(() => setBusy(false), (e) => { setBusy(false); setWhy(StrataWhy(e, "the primer wasn't asked for")); });
  };
  return <>
    <button type="button" className="primer-ask" disabled={busy} onClick={ask}>{busy ? "Asking…" : label}</button>
    {why ? <p role="alert" className="primer-why">{why}</p> : null}
  </>;
}

/** Beside the page: the source's primer in the live pages' sandbox, or the button that asks for one. */
export default function PrimerPanel({ board, src, onPage }: { board: string; src: ResourceMeta; onPage: (page: number) => void }) {
  const panel = useSyncExternalStore(primerPanel.subscribe, primerPanel.get);
  const v = primerView(src.primer);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const turn = useRef(onPage);
  turn.current = onPage;
  usePrimerWait(board, panel.open && v.asked);
  useEffect(() => {
    const hear = (e: MessageEvent) => { const n = pageAsked(e, frame.current?.contentWindow); if (n) turn.current(n); };
    addEventListener("message", hear);
    return () => removeEventListener("message", hear);
  }, []);
  const url = src.primer?.builtAt ? StrataAPI.primerUrl(board, src.id, src.primer.builtAt) : null;
  if (!panel.open) return null;
  return (
    <aside className={"primer" + (panel.wide ? " wide" : "")} aria-label="Primer">
      <div className="primer-head">
        <b>Primer</b>
        <span className="primer-said">{v.asked ? (v.page ? "a new one is being written…" : "asked for…") : v.stale ? "stale: the source changed since it was written" : ""}</span>
        {v.page && !v.asked ? <AskButton board={board} src={src} label={v.stale ? "Rebuild" : "Write again"} /> : null}
        <button type="button" className="primer-tool" aria-pressed={panel.wide} title={panel.wide ? "narrow" : "widen"} onClick={() => primerPanel.set({ wide: !panel.wide })}>{panel.wide ? "⇥" : "⇤"}</button>
        <button type="button" className="primer-tool" aria-label="Close the primer" onClick={() => primerPanel.set({ open: false })}>✕</button>
      </div>
      {url
        ? <iframe key={url} ref={frame} className="primer-frame" title={`Primer for ${src.filename}`} src={url}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms" referrerPolicy="no-referrer" />
        : <div className="primer-empty">
            {v.asked
              ? <p>Asked for. Your routine writes it on its next run, and it shows here when it lands.</p>
              : <><p>A primer is a page your agent writes for this source: the threads to follow, what to keep track of and the main results, laid out before you read.</p>
                <AskButton board={board} src={src} label="Primer" /></>}
          </div>}
    </aside>
  );
}
