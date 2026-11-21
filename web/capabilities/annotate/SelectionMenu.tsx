import type { MarkChips as Chips } from "./useMarks.ts";

export interface SelectionMenuProps {
  at: { x: number; y: number };
  /** paints the highlight; where a page keeps the keys, it opens the note too */
  onMark(): void;
  /** only where Mark can't offer its chips: a live page's frame */
  onAsk?(): void;
  onCard?(): void;
}

type Act = [label: string, key: string | null, act: (() => void) | undefined];

// on touch, act from touchend: a tap collapses the selection before the click arrives
function Buttons({ acts }: { acts: Act[] }) {
  return <>{acts.filter((a): a is [string, string | null, () => void] => !!a[2]).map(([label, key, act]) =>
    <button key={label} title={key ? `${label} (${key})` : label} onClick={act} onTouchEnd={(e) => { e.preventDefault(); act(); }}>
      {label}{key ? <kbd aria-hidden="true">{key}</kbd> : null}</button>)}</>;
}
const keep = (e: { preventDefault(): void; stopPropagation(): void }) => { e.preventDefault(); e.stopPropagation(); };

export default function SelectionMenu({ at, onMark, onAsk, onCard }: SelectionMenuProps) {
  return (
    <div className="selmenu" style={{ left: at.x, top: at.y }} onMouseDown={keep}>
      <Buttons acts={[["Mark", "m", onMark], ["Card", null, onCard], ["Ask", null, onAsk]]} />
    </div>
  );
}

export interface MarkChipsProps {
  at: Chips;
  onNote(): void;
  onAsk?(): void;
  onCard?(): void;
  /** only on a mark already there: a fresh one is taken back with ⌘Z */
  onRemove?(): void;
}

export function MarkChips({ at, onNote, onAsk, onCard, onRemove }: MarkChipsProps) {
  return (
    <div className="selmenu chips" role="toolbar" aria-label="on this highlight" style={{ left: at.x, top: at.y }} onMouseDown={keep}>
      <Buttons acts={[["Note", "n", onNote], ["Ask", "a", onAsk], ["Card", "c", onCard]]} />
      {onRemove ? <button className="rm" title="remove the highlight" aria-label="Remove highlight" onClick={onRemove}
        onTouchEnd={(e) => { e.preventDefault(); onRemove(); }}>✕</button> : null}
    </div>
  );
}
