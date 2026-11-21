import type { MouseEvent, TouchEvent } from "react";
import { TOUCH } from "../../platform/device.js";

export interface SelectionMenuProps {
  /** over the words at `y`, under them at `b` */
  at: { x: number; y: number; b: number };
  /** the highlight is made at once; the chips under it say what else */
  onMark(): void;
}

const hold = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); };
// on touch, act from touchend: a tap collapses the selection before the click arrives
const tap = (act: () => void) => (e: TouchEvent) => { e.preventDefault(); act(); };

export default function SelectionMenu({ at, onMark }: SelectionMenuProps) {
  // a phone's own copy menu sits over the words, so Mark goes under them
  return (
    <div className={"selmenu" + (TOUCH ? " under" : "")} style={{ left: at.x, top: TOUCH ? at.b : at.y }} onMouseDown={hold}>
      <button onClick={onMark} onTouchEnd={tap(onMark)} title="mark these words (m)">Mark</button>
    </div>
  );
}

export interface MarkChipsProps {
  /** under the mark's words */
  at: { x: number; y: number };
  onNote(): void;
  /** left out where a page is read for its notes alone */
  onAsk?(): void;
  onCard?(): void;
  /** offered on a mark tapped again, not on one just made (⌘Z takes that back) */
  onRemove?(): void;
}

export function MarkChips({ at, onNote, onAsk, onCard, onRemove }: MarkChipsProps) {
  const acts = ([["Note", onNote, "n"], ["Ask", onAsk, "a"], ["Card", onCard, "c"]] as [string, (() => void) | undefined, string][])
    .filter((a): a is [string, () => void, string] => !!a[1]);
  return (
    <div className="markchips" role="toolbar" aria-label="on this mark" style={{ left: at.x, top: at.y }} onMouseDown={hold}>
      {acts.map(([label, act, key]) =>
        <button key={label} onClick={act} onTouchEnd={tap(act)} title={`${label.toLowerCase()} on these words (${key})`}>{label}</button>)}
      {onRemove ? <button className="mc-rm" onClick={onRemove} onTouchEnd={tap(onRemove)} aria-label="Remove the mark" title="remove the mark">✕</button> : null}
    </div>
  );
}
