// The primer is a source's first layer: one page drawn by the routine, opened before page 1.
import { useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { setPlanOpen, togglePlan, usePlanOpen } from "./planOpen.ts";
import { sources } from "../../data/entities/sources.ts";
import type { PrimerPlan, ResourceMeta } from "../../../shared/types/index.ts";
import "./primer.css";

export interface PrimerButtonProps {
  board: string;
  src: ResourceMeta;
  /** on a primer, the source it is the primer of */
  of?: ResourceMeta | null;
  onOpen(rid: string): void;
}

const at = (where?: string) => where ? <span className="pp-where">{where}</span> : null;

function PlanInfo({ plan }: { plan: PrimerPlan }) {
  const open = usePlanOpen();
  return <span className="rbar-primer-info">
    <button className={"rbar-primer info" + (open ? " on" : "")} title="the plan this primer was drawn from (i)" onClick={togglePlan}>ⓘ</button>
    {open ? <div className="primer-plan" role="dialog" aria-label="the primer's plan" onKeyDown={(e) => { if (e.key === "Escape") setPlanOpen(false); }}>
      <div className="pp-q">{plan.question}</div>
      <div className="pp-h">threads</div>
      <ol>{plan.threads.map((t, i) => <li key={i}><b>{t.name}</b> {at(t.where)}<div>{t.gist}</div></li>)}</ol>
      <div className="pp-h">results</div>
      <ul>{plan.results.map((r, i) => <li key={i}>{r.claim} {at(r.where)}</li>)}</ul>
      {plan.watch.length ? <><div className="pp-h">keep track of</div><div className="pp-watch">{plan.watch.map((w, i) => <span key={i}>{w}</span>)}</div></> : null}
    </div> : null}
  </span>;
}

export default function PrimerButton({ board, src, of, onOpen }: PrimerButtonProps) {
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  if (src.primerOf) {
    const plan = of?.primer?.plan;
    return <span className="rbar-primer-pair">
      <button className="rbar-primer back" title="back to the source this primer is for" onClick={() => onOpen(src.primerOf!)}>← source</button>
      {plan ? <PlanInfo plan={plan} /> : null}
    </span>;
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
      {src.primer.plan ? <PlanInfo plan={src.primer.plan} /> : null}
      <button className="rbar-primer redraw" disabled={asking || waiting} title={waiting ? "being redrawn" : why ?? "draw the primer again"} onClick={ask}>{waiting ? "redrawing…" : "↻"}</button>
    </span>;
  }
  return <button className="rbar-primer" disabled={asking || waiting}
    title={why ?? (waiting ? "asked for: the routine is drawing it" : "ask the routine to draw a one-page primer of this source")}
    onClick={ask}>{asking ? "asking…" : waiting ? "primer coming…" : why ? "primer: try again" : "make a primer"}</button>;
}
