import { Fragment } from "react";
import { REVIEW_NAME, STAGE_NAME, stageOf, stagesOf, type DrillCard } from "./drill-order.ts";

export interface CardTrailProps {
  cards: DrillCard[];
  pos: number;
  seen?: { has(id: unknown): boolean } | null;
  onSeek?: ((i: number) => void) | null;
  keep?: { kept?: number; total?: number; benched?: boolean } | null;
  onBench?: (() => void) | null;
  onBenchWarm?: (() => void) | null;
}

function CardTrail({ cards, pos, seen, onSeek, keep, onBench, onBenchWarm }: CardTrailProps) {
  const isSeen = (c: DrillCard) => !!(seen && seen.has && seen.has(c.id));
  const at = cards.map((c, i) => ({ c, i }));
  const stages = stagesOf(cards);
  const here = cards[pos] ? stageOf(cards[pos]) : null;
  const groups = stages.map((st) => {
    const items = at.filter(({ c }) => stageOf(c) === st);
    const n = items.reduce((s, { c, i }) => s + (i === pos || isSeen(c) ? 1 : 0), 0);
    const idx = items.findIndex(({ i }) => i === pos);
    const next = items.find(({ c, i }) => i !== pos && !isSeen(c)) || items[0];
    return { st, name: STAGE_NAME[st], items, n, idx, next, on: st === here, full: n === items.length };
  });
  const through = groups.length > 0 && groups.every((g) => g.full);
  const benched = !!(keep && keep.benched);
  const kept = keep ? keep.kept || 0 : 0;
  return (
    <div className="jn" role="group" aria-label="where you are in this deck: the skim, the deeper pass, then the review">
      {groups.map((g) => {
        const pct = Math.round((100 * g.n) / Math.max(1, g.items.length));
        const what = `${g.name} — ${g.n} of ${g.items.length} cards${g.on ? ", you are here" : ""}`;
        return (
          <Fragment key={g.st}>
            <button type="button" tabIndex={-1} className={"jn-st" + (g.on ? " on" : "") + (g.full ? " full" : "")}
              style={{ flexGrow: Math.max(2, g.items.length) }} title={what} aria-label={what} aria-current={g.on || undefined}
              onMouseDown={(e) => e.preventDefault()} onClick={onSeek && g.next ? () => onSeek(g.next.i) : undefined}>
              <span className="jn-head"><span className="jn-name">{g.name}</span><span className="jn-n">{g.n} / {g.items.length}</span></span>
              <span className="jn-bar">
                <i style={{ width: pct + "%" }} />
                {g.on && g.idx >= 0 ? <b style={{ left: ((g.idx + 0.5) * 100 / g.items.length) + "%" }} /> : null}
              </span>
            </button>
            <span className="jn-link" aria-hidden="true" />
          </Fragment>
        );
      })}
      <button type="button" tabIndex={-1} className={"jn-st jn-rev" + (benched ? " full" : through ? " next" : "")}
        title={benched ? `reviewed — ${kept} kept of ${keep!.total}` : through ? "both passes are through — choose what to keep (r)" : "after the passes: choose what to keep (r)"}
        onMouseDown={(e) => e.preventDefault()} onPointerEnter={onBenchWarm || undefined} onPointerDown={onBenchWarm || undefined}
        onClick={onBench || undefined}>
        <span className="jn-head"><span className="jn-name">{REVIEW_NAME}</span>
          <span className="jn-n">{benched ? `★ ${kept} kept` : through ? "choose what to keep" : "what to keep"}</span></span>
        <span className="jn-bar"><i style={{ width: benched ? "100%" : "0%" }} /></span>
      </button>
    </div>
  );
}

export default CardTrail;
