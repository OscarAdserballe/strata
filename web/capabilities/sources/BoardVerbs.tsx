import { useEffect, useState, type ReactNode } from "react";
import type { BoardActions } from "./useBoardActions.ts";

export default function BoardVerbs({ board, actions, name, between, className = "home-quiet" }: {
  board: { id: string; title: string };
  actions: BoardActions;
  name?: ReactNode;
  between?: ReactNode;
  className?: string;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [armed, setArmed] = useState(false);
  useEffect(() => { setRenaming(false); setArmed(false); }, [board.id]);
  // an armed delete stands down by itself: a second click minutes later is not a decision
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const commit = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== board.title) void actions.rename(board.id, next);
  };
  return <>
    {renaming
      ? <input className="lc-rename" autoFocus aria-label="Board name" value={draft}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(false); } }} />
      : name}
    {between}
    <button className={className} aria-label={`Rename ${board.title}`} onClick={() => { setArmed(false); setDraft(board.title); setRenaming(true); }}>Rename</button>
    {armed
      ? <button className={className + " danger"} aria-label={`Delete ${board.title} and everything on it`} onClick={() => { setArmed(false); void actions.remove(board.id); }}>Delete it?</button>
      : <button className={className} aria-label={`Delete ${board.title}`} onClick={() => setArmed(true)}>Delete</button>}
  </>;
}
