import { useEffect, useRef, useState } from "react";
import { StrataAPI, StrataWhy } from "../../data/api.ts";
import { store as roomStore, useEntry, useQuery } from "../../data/store.ts";
import { primerKey, primerRead, primers, primersTag, type PrimerEntity } from "../../data/entities/primers.ts";
import { HtmlEngine } from "../../engines/html/HtmlEngine.ts";
import { toast } from "../../shell/layers.ts";
import HtmlSource from "../live/HtmlSource.tsx";

export interface PrimerPanelProps {
  board: string;
  rid: string;
  /** the room's zoom here, which the page undoes to draw at the browser's own scale */
  scale: number;
  /** a link in the primer to a page of the source; null where the source has no pages */
  onPage: ((n: number) => void) | null;
}

const NO_STATE = () => Promise.reject(new Error("a primer keeps no state"));

/** A source's primer over its pages: the page itself when written, or where it stands and the press that asks for one. */
export default function PrimerPanel({ board, rid, scale, onPage }: PrimerPanelProps) {
  const primer = useQuery<PrimerEntity>(primerKey(rid), primerRead(board, rid), { tags: [primersTag(board)] });
  const failed = useEntry<PrimerEntity>(primerKey(rid))?.error;
  const [asking, setAsking] = useState(false);
  const pageRef = useRef(onPage);
  pageRef.current = onPage;
  const engineRef = useRef<HtmlEngine | null>(null);
  engineRef.current ??= new HtmlEngine({
    onSelect: () => {}, onMark: () => {}, onPress: () => {},
    onLoad: () => Promise.resolve(null), onSave: NO_STATE,
    onPage: (n) => pageRef.current?.(n),
  });
  const engine = engineRef.current;
  useEffect(() => () => engine.dispose(), [engine]);

  // the routine writes it minutes later: look again now and then while it is being written, never while hidden
  const waiting = primer?.status === "requested";
  useEffect(() => {
    if (!waiting) return;
    let delay = 8000, timer: ReturnType<typeof setTimeout>;
    const look = () => {
      if (!document.hidden) void roomStore.refetch(primerKey(rid)).catch(() => {});
      delay = Math.min(delay * 1.5, 60_000);
      timer = setTimeout(look, delay);
    };
    timer = setTimeout(look, delay);
    return () => clearTimeout(timer);
  }, [waiting, rid]);

  const ask = () => {
    setAsking(true);
    primers.request(board, rid).catch((e: unknown) => toast(StrataWhy(e, "couldn't ask for a primer"), 4200)).finally(() => setAsking(false));
  };

  if (!primer) return <div className="primer-plane"><p className="primer-say">{failed ? "Couldn't read this source's primer." : "Reading…"}</p></div>;
  if (primer.dispatch) return <div className="primer-plane"><p className="primer-say">Dispatch pages don't have primers.</p></div>;
  const page = primer.builtAt ? <HtmlSource engine={engine} url={StrataAPI.primerLiveUrl(board, rid, primer.builtAt)} scale={scale} /> : null;
  const press = <button type="button" className="primer-ask" disabled={asking} onClick={ask}>{primer.status === "stale" ? "Write a new one" : "Make a primer"}</button>;
  return (
    <div className="primer-plane">
      {primer.status === "none"
        ? <div className="primer-say"><p>No primer yet. A primer is an overview of this source to read before page 1: its threads, what to watch for, and where it lands. The routine writes it.</p>{press}</div>
        : primer.status === "requested"
          ? primer.builtAt ? <p className="primer-bar">A new primer is being written; this is the last one.</p>
            : <p className="primer-say">The primer is being written. It shows here when it is ready.</p>
          : primer.status === "stale"
            ? <div className="primer-bar"><span>This source changed since its primer was written.</span>{press}</div>
            : null}
      {page}
    </div>
  );
}
