export interface SelectionMenuProps {
  at: { x: number; y: number };
  /** a note on the words; left empty, it stays a highlight */
  onNote(): void;
  /** left out where a page is read for its notes alone */
  onAsk?(): void;
  onCard?(): void;
}

export default function SelectionMenu({ at, onNote, onAsk, onCard }: SelectionMenuProps) {
  const acts = ([["Note", onNote], ["Card", onCard], ["Ask", onAsk]] as [string, (() => void) | undefined][])
    .filter((a): a is [string, () => void] => !!a[1]);
  return (
    <div className="selmenu" style={{ left: at.x, top: at.y }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {/* on touch, act from touchend: a tap collapses the selection before the click arrives */}
      {acts.map(([label, act]) =>
        <button key={label} onClick={act} onTouchEnd={(e) => { e.preventDefault(); act(); }}>{label}</button>)}
    </div>
  );
}
