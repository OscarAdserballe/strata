import { useEffect, useState, useSyncExternalStore } from "react";
import { ImportsStatus } from "../../capabilities/sources/ImportsPanel.tsx";
import { loadCapture } from "../../capabilities/sources/AddSource.tsx";
import Suggest from "../../capabilities/feedback/Suggest.tsx";
import { openKeysSheet } from "../../capabilities/keys/registry.ts";
import { type Layer, switches } from "../../capabilities/fold/switches.ts";
import { barSlot } from "./barSlot.ts";
import { useDispatchBar } from "../../shell/dispatch.ts";

export interface ReaderBarProps {
  board: string;
  file: string;
  kind: string;
  onBoards(): void;
  onHome(): void;
  onAdd(kind: "file" | "link", study?: boolean): void;
  imports: boolean;
  onImport(board: string, resource?: string): void;
  follow: boolean | null;
  onFollow(): void;
  onNewCard(): void;
  adminPath: string | null;
  onSignOut(): void;
}

const KIND: Record<string, string> = { pdf: "PDF", html: "HTML", transcript: "transcript" };
const LAYERS: [Layer, string][] = [["notes", "notes"], ["cards", "cards"], ["ask", "ask"]];

// While a source is open the bar is one row: where you are, and which layers are on.
export default function ReaderBar(p: ReaderBarProps) {
  const sw = useSyncExternalStore(switches.subscribe, switches.getSnapshot);
  const dispatch = useDispatchBar();
  const [menu, setMenu] = useState(false);
  const [study, setStudy] = useState(true);
  useEffect(() => {
    if (!menu) return;
    const shut = () => setMenu(false);
    document.addEventListener("click", shut);
    document.addEventListener("keydown", shut, true);
    return () => { document.removeEventListener("click", shut); document.removeEventListener("keydown", shut, true); };
  }, [menu]);
  const add = (kind: "file" | "link") => { setMenu(false); p.onAdd(kind, study); };
  return (
    <div className="rbar">
      <button className="rbar-home" onClick={p.onBoards} title="all boards (b)" aria-label="boards">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M2.5 7.5 8 3l5.5 4.5" /><path d="M4 7v6h8V7" /></svg>
      </button>
      <button className="rbar-board" onClick={p.onHome} title="this board's home">{dispatch?.board ?? p.board}</button>
      <span className="rbar-slash">/</span>
      <span className="rbar-file" title={p.file}>{p.file}</span>
      <span className="rbar-kind">{KIND[p.kind] || "text"}</span>
      {dispatch ? <span className="rbar-ver">{dispatch.version}</span> : null}
      <span className="rbar-grow" />
      {p.imports ? <ImportsStatus onOpen={p.onImport} className="rbar-imports" /> : null}
      <span className="rbar-slot" ref={barSlot.set} />
      <span className="rbar-lbl">layers</span>
      {LAYERS.filter(([l]) => (l !== "ask" || sw.count.ask > 0) && !(dispatch && l === "cards")).map(([l, label]) =>
        <button key={l} className={"rbar-chip " + (l === "ask" ? "asks" : l) + (sw.on[l] ? "" : " off")} aria-pressed={sw.on[l]}
          title={`${sw.on[l] ? "hide" : "show"} ${label}`} onClick={() => switches.flip(l)}>
          <i />{label}<b>{sw.count[l]}</b>
        </button>)}
      <span className="rbar-more">
        <button className="rbar-dots" aria-haspopup="menu" aria-expanded={menu} title="more"
          onClick={(e) => { e.stopPropagation(); if (!menu) setStudy(true); setMenu(!menu); }}>⋯</button>
        {/* kept mounted while shut: a dialog opened from it (Suggest) lives on after the menu closes */}
        <span className={"rbar-menu" + (menu ? " open" : "")} role="menu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => add("file")}><b>Add a file</b>pdf / md / txt / html</button>
          <button className="rbar-study" aria-pressed={study} onClick={() => setStudy((v) => !v)}>make flashcards: {study ? "on" : "off"}</button>
          <button onPointerDown={() => void loadCapture().catch(() => {})} onClick={() => add("link")}><b>Add from a link</b>youtube / article</button>
          <button onClick={() => { setMenu(false); p.onNewCard(); }}><b>New card</b>c</button>
          {p.follow !== null ? <button aria-pressed={p.follow} onClick={p.onFollow}><b>Follow chapters</b>{p.follow ? "on" : "off"}</button> : null}
          <button onClick={() => { setMenu(false); openKeysSheet(); }}><b>Shortcuts</b>?</button>
          <Suggest />
          {p.adminPath ? <button onClick={() => location.assign(p.adminPath!)}><b>Admin</b></button> : null}
          <button onClick={p.onSignOut}><b>Log out</b></button>
        </span>
      </span>
    </div>
  );
}
