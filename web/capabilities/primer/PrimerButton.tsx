// The primer is a source's first layer: one page drawn by the routine, opened before page 1.
import { useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { sources } from "../../data/entities/sources.ts";
import type { ResourceMeta } from "../../../shared/types/index.ts";
import "./primer.css";

export interface PrimerButtonProps {
  board: string;
  src: ResourceMeta;
  onOpen(rid: string): void;
}

export default function PrimerButton({ board, src, onOpen }: PrimerButtonProps) {
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  if (src.primerOf) {
    return <button className="rbar-primer back" title="back to the source this primer is for" onClick={() => onOpen(src.primerOf!)}>← source</button>;
  }
  const ask = () => {
    setAsking(true); setWhy(null);
    sources.primer(board, src.id)
      .catch((e: unknown) => setWhy(StrataWhy(e, "the primer couldn't be asked for")))
      .finally(() => setAsking(false));
  };
  const waiting = !!src.primer?.askedAt;
  if (src.primer?.id) {
    return <span className="rbar-primer-pair">
      <button className="rbar-primer on" title="the page to read before page 1" onClick={() => onOpen(src.primer!.id!)}>primer</button>
      <button className="rbar-primer redraw" disabled={asking || waiting} title={waiting ? "being redrawn" : why ?? "draw the primer again"} onClick={ask}>{waiting ? "redrawing…" : "↻"}</button>
    </span>;
  }
  return <button className="rbar-primer" disabled={asking || waiting}
    title={why ?? (waiting ? "asked for: the routine is drawing it" : "ask the routine to draw a one-page primer of this source")}
    onClick={ask}>{asking ? "asking…" : waiting ? "primer coming…" : why ? "primer: try again" : "make a primer"}</button>;
}
