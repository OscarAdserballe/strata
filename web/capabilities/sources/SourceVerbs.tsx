import { useEffect, useState, type MouseEvent } from "react";

export interface VerbTarget {
  rid?: string | null; doneAt?: number | null; keep?: string | null; keepBoard?: boolean; sections?: number;
  aside?: { live: number; out: number } | null; del?: { res?: string; pair?: string };
}

export interface SourceVerbsProps<T extends VerbTarget> {
  t: T;
  onDel?: ((t: T) => void) | null;
  onAside?: ((t: T, restore: boolean) => void) | null;
  onDistil?: ((t: T) => void) | null;
  onDistilWarm?: ((t: T) => void) | null;
  onKeep?: ((t: T) => void) | null;
  onKeepWarm?: (() => void) | null;
  onRename?: ((t: T) => void) | null;
  onDone?: ((t: T, done: boolean) => void) | null;
}

export default function SourceVerbs<T extends VerbTarget>({ t, onDel, onAside, onDistil, onDistilWarm, onKeep, onKeepWarm, onRename, onDone }: SourceVerbsProps<T>) {
  const [menu, setMenu] = useState(false);
  const [arm, setArm] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const shut = () => { setMenu(false); setArm(null); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); shut(); } };
    document.addEventListener("click", shut);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("click", shut); document.removeEventListener("keydown", key, true); };
  }, [menu]);
  const aside = t.aside && onAside && (t.aside.live > 0 || t.aside.out > 0) ? t.aside : null;
  const putBack = !!(aside && !aside.live && aside.out);
  const canRename = !!(t.rid && onRename), canDone = !!(t.rid && onDone), canKeep = !!((t.keep || t.keepBoard) && onKeep);
  if (!((t.del && onDel) || aside || (t.rid && onDistil) || canKeep || canRename || canDone)) return null;
  const row = (kind: string, label: string, ask: string | null, go: () => void, cls?: string, warm?: () => void) => (
    <button className={"tl-row" + (cls ? " " + cls : "") + (arm === kind ? " arm" : "")} onPointerDown={warm}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        if (!ask) { setMenu(false); setArm(null); go(); return; }
        if (arm === kind) { setMenu(false); setArm(null); go(); } else setArm(kind);
      }}>{arm === kind ? ask : label}</button>
  );
  return (
    <span className="dk-verbs" onClick={(e) => e.stopPropagation()}>
      <span className="tl-more" title="what can be done with this source"
        onClick={(e) => { e.stopPropagation(); setArm(null); if (!menu && canKeep && onKeepWarm) onKeepWarm(); setMenu((v) => !v); }}>⋯</span>
      {menu ? <span className="tl-menu" onClick={(e) => e.stopPropagation()}>
        {canRename && onRename ? row("rename", "rename", null, () => onRename(t)) : null}
        {canDone && onDone
          ? (t.doneAt
              ? row("undone", "not done after all", null, () => onDone(t, false))
              : row("done", "mark as done", null, () => onDone(t, true)))
          : null}
        {canKeep && onKeep ? row("keep", "choose what to keep", null, () => onKeep(t)) : null}
        {t.rid && onDistil
          ? (t.sections || 0) > 1
            // the section editor that opens is the confirmation
            ? row("distil", "re-distil…", null, () => onDistil(t), undefined, onDistilWarm ? () => onDistilWarm(t) : undefined)
            : row("distil", "re-distil", "re-distil 1 section?", () => onDistil(t))
          : null}
        {aside && onAside
          ? putBack
            ? row("back", "put " + aside.out + " back in the drill", null, () => onAside(t, true))
            : row("aside", "set the deck aside", "ignore " + aside.live + (aside.live === 1 ? " card?" : " cards?"), () => onAside(t, false))
          : null}
        {t.del && onDel
          ? row("del", "delete this " + (t.del.res ? "source" : "pair"),
              (t.del.res ? "the source, its pages and its cards" : "the pair and its cards") + " — all of it?",
              () => onDel(t), "bad")
          : null}
      </span> : null}
    </span>
  );
}
