// The primer: a page the routine writes for a source, read before page 1, shown in place of the page body like the concept tree.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StrataAPI, prefetch } from "../../data/api.ts";
import { primers } from "../../data/entities/primers.ts";
import { HtmlEngine } from "../../engines/html/HtmlEngine.ts";
import HtmlSource from "../live/HtmlSource.tsx";
import { primerPane, usePrimer, usePrimerUp } from "./primer.ts";

export interface PrimerSource { id: string; filename: string }

/** The bar's toggle; the status is asked for as the pointer arrives, so the pane opens on it. */
export function PrimerToggle({ board, src, at }: { board: string; src: PrimerSource; at: HTMLElement }) {
  const up = usePrimerUp();
  return createPortal(
    <button type="button" className={"rbar-primer" + (up ? " on" : "")} aria-pressed={up} title={up ? "back to the source" : "a page to read before page 1"}
      onMouseDown={(e) => e.preventDefault()} onPointerEnter={() => void prefetch(`/api/boards/${board}/resources/${src.id}/primer`).catch(() => {})}
      onClick={() => primerPane.set(!up)}>primer</button>, at);
}

export interface PrimerPaneProps {
  board: string;
  src: PrimerSource;
  /** the room's zoom the pane sits under, which the page undoes to draw at the browser's own scale */
  scale: number;
  onPage(page: number): void;
  toastWhy(e: unknown, said: string): void;
}

/** Up only while the toggle says so; the page under it stays where it was. */
export function PrimerPane(p: PrimerPaneProps) {
  return usePrimerUp() ? <Pane {...p} /> : null;
}

function Pane({ board, src, scale, onPage, toastWhy }: PrimerPaneProps) {
  const primer = usePrimer(board, src.id);
  const [asking, setAsking] = useState(false);
  const pageAt = useRef(onPage);
  pageAt.current = onPage;
  const engine = useRef<HtmlEngine | null>(null);
  // a primer keeps no state and takes no notes: it is read, then left
  engine.current ??= new HtmlEngine({
    onSelect: () => {}, onMark: () => {}, onPress: () => {},
    onLoad: () => Promise.resolve(null),
    onSave: () => Promise.reject(new Error("a primer keeps nothing")),
    onGoto: (n) => { primerPane.set(false); pageAt.current(n); },
  });
  useEffect(() => () => engine.current?.dispose(), []);
  const ask = () => {
    setAsking(true);
    primers.request(board, src.id).catch((e: unknown) => toastWhy(e, "the primer wasn't asked for")).finally(() => setAsking(false));
  };
  const status = primer?.status;
  const shown = status === "ready" || status === "stale";
  return (
    <div className="primer" role="region" aria-label="Primer">
      <div className="thead primer-head">
        <span className="tsrc">{src.filename}</span>
        <span className="tstate">primer</span>
        {status === "stale"
          ? <span className="primer-stale">out of date · <button type="button" className="tlink" disabled={asking} onClick={ask}>remake</button></span>
          : null}
        <span className="tgrow" />
        <button type="button" className="tclose" onClick={() => primerPane.set(false)} title="back to the source">source</button>
      </div>
      {shown
        ? <HtmlSource engine={engine.current} url={StrataAPI.primerLiveUrl(board, src.id, primer?.builtAt ?? undefined)} scale={scale} />
        : <div className="primer-empty">
            {!primer
              ? <p className="tnote">Looking for a primer…</p>
              : status === "requested"
              ? <p className="tnote"><span className="kg-pulse">◆</span> Being written… It shows here when it is ready, and you can read on meanwhile.</p>
              : <>
                  <p className="tnote">A primer is one page to read before page 1: what this source is about, the threads to follow, and where it lands.</p>
                  <button type="button" className="primer-make" disabled={asking} onClick={ask}>Make a primer</button>
                </>}
          </div>}
    </div>
  );
}
