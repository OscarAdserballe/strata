import { useState } from "react";

export interface RenameBoxProps {
  draft: string; setDraft(v: string): void; onCommit(): void; onCancel(): void; cls?: string;
}

export default function RenameBox({ draft, setDraft, onCommit, onCancel, cls }: RenameBoxProps) {
  return <input className={cls} autoFocus value={draft} onClick={(e) => e.stopPropagation()}
    onFocus={(e) => e.target.select()}
    onChange={(e) => setDraft(e.target.value)}
    onBlur={() => onCommit()}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }} />;
}

export function useRename<T extends { rid?: string | null; label?: string }>(t: T, onRenamed?: ((t: T, name: string) => void) | null) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const start = onRenamed && t.rid ? () => { setDraft(t.label || ""); setRenaming(true); } : undefined;
  const commit = () => { const v = draft.trim(); setRenaming(false); if (v && v !== t.label && onRenamed) onRenamed(t, v); };
  const cancel = () => setRenaming(false);
  return { renaming, draft, setDraft, start, commit, cancel };
}
