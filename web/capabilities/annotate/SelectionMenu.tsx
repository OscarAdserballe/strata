import { CHIP_LABELS, type ChipAct, type ChipOffer } from "./chips.ts";

export interface SelectionMenuProps {
  at: { x: number; y: number; under: number };
  /** paints the words at once; what to hang on them is offered after, in the chips */
  onMark(): void;
  /** on touch the native copy menu sits over the words, so this sits under them */
  under?: boolean;
}

// on touch, act from touchend: a tap collapses the selection before the click arrives
const press = (act: () => void) => ({
  onClick: act,
  onTouchEnd: (e: { preventDefault(): void }) => { e.preventDefault(); act(); },
});
const hold = { onMouseDown: (e: { preventDefault(): void; stopPropagation(): void }) => { e.preventDefault(); e.stopPropagation(); } };

export default function SelectionMenu({ at, onMark, under }: SelectionMenuProps) {
  return (
    <div className={"selmenu" + (under ? " under" : "")} style={{ left: at.x, top: under ? at.under : at.y }} {...hold}>
      <button title="mark these words (m)" {...press(onMark)}>Mark</button>
    </div>
  );
}

export interface MarkChipsProps {
  at: { x: number; y: number };
  offer: ChipOffer;
  onAct(act: ChipAct): void;
}

export function MarkChips({ at, offer, onAct }: MarkChipsProps) {
  const acts = (["note", "ask", "card"] as const).filter((a) => offer[a]);
  return (
    <div className="markchips" role="toolbar" aria-label="on this mark" style={{ left: at.x, top: at.y }} {...hold}>
      {acts.map((a) =>
        <button key={a} className="chip" title={`${CHIP_LABELS[a].toLowerCase()} (${a[0]})`} {...press(() => onAct(a))}>{CHIP_LABELS[a]}</button>)}
      {offer.remove
        ? <button className="chip rm" title="remove the mark" aria-label="Remove mark" {...press(() => onAct("remove"))}>✕</button>
        : null}
    </div>
  );
}
