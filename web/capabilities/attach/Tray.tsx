import type { TrayItem } from "./useTray.ts";

export default function Tray({ items, note, onRemove }: { items: TrayItem[]; note: string; onRemove(key: number): void }) {
  if (!items.length && !note) return null;
  return (
    <div className="att-tray" aria-label="Images going with your question">
      {items.map((i) => (
        <div key={i.key} className={"att-thumb" + (i.error ? " failed" : "")} title={i.error || (i.id ? "attached" : "uploading…")}>
          <img src={i.src} alt="" />
          {!i.id && !i.error ? <span className="att-ring" aria-label="uploading" /> : null}
          {i.error ? <span className="att-err">!</span> : null}
          <button type="button" className="att-x" aria-label="Remove image" onClick={() => onRemove(i.key)}>×</button>
        </div>
      ))}
      {note ? <span className="att-note">{note}</span> : null}
    </div>
  );
}

export function FaceStrip({ refs, onRemove }: { refs: { id: string; src: string }[]; onRemove(id: string): void }) {
  if (!refs.length) return null;
  return (
    <div className="att-tray face" aria-label="Images on this face">
      {refs.map((r) => (
        <div key={r.id} className="att-thumb">
          <img src={r.src} alt="" />
          <button type="button" className="att-x" aria-label="Remove image" onClick={() => onRemove(r.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
