export interface SelectionMenuProps {
  at: { x: number; y: number };
  /** the words are marked already: offer what to do with the mark */
  marked: boolean;
  /** highlights the words at once */
  onMark(): void;
  onNote(): void;
  /** left out where a page is read for its notes alone */
  onAsk?(): void;
  onCard?(): void;
}

export default function SelectionMenu({ at, marked, onMark, onNote, onAsk, onCard }: SelectionMenuProps) {
  const acts = (marked
    ? [["Note", "N", onNote], ["Ask", "A", onAsk], ["Card", "C", onCard]]
    : [["Mark", "M", onMark]]) as [string, string, (() => void) | undefined][];
  return (
    <div className={"selmenu" + (marked ? " chips" : "")} style={{ left: at.x, top: at.y }}
      onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {/* on touch, act from touchend: a tap collapses the selection before the click arrives */}
      {acts.filter((a): a is [string, string, () => void] => !!a[2]).map(([label, key, act]) =>
        <button key={label} title={`${label} (${key.toLowerCase()})`} onClick={act} onTouchEnd={(e) => { e.preventDefault(); act(); }}>
          {label}<kbd aria-hidden="true">{key}</kbd>
        </button>)}
    </div>
  );
}
