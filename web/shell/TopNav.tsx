// The room's one bar: Today, Projects and Review, Jump to and + Add. Every screen but the reader wears it.
import { useEffect, useState, type ReactNode } from "react";
import type { RegisterResponse } from "../../shared/types/index.ts";
import { useEntity } from "../data/store.ts";
import { REGISTER } from "../data/entities/sources.ts";
import { useReviewStrip } from "../data/entities/review.ts";
import { loadCapture } from "../capabilities/sources/AddSource.tsx";
import { setPicker, type PickerItem } from "../capabilities/sources/BoardPicker.tsx";
import Suggest from "../capabilities/feedback/Suggest.tsx";
import { openKeysSheet } from "../capabilities/keys/registry.ts";
import { begin as journey } from "../platform/rum.ts";
import { openTab, setReviewing } from "./screens.ts";
import { room } from "./room.ts";
import { useDeploy } from "./session.ts";
import "./topnav.css";

export type NavHere = "today" | "projects" | "review" | null;

export interface TopNavProps {
  here: NavHere;
  onAdd(kind: "file" | "link", study?: boolean): void;
  /** this screen's own tools, before Jump to */
  tools?: ReactNode;
  adminPath?: string | null;
  onSignOut(): void;
  /** the review hides Jump to and + Add while a card is up */
  quiet?: boolean;
}

/** Projects first, then their sources, from the register already held. */
export function jumpTo(reg: RegisterResponse | null | undefined): void {
  if (!reg) return;
  const live = reg.projects.filter((p) => !p.archivedAt).sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0));
  const titles = new Map(reg.projects.map((p) => [p.id, p.title]));
  const items: PickerItem[] = [
    ...live.map((p) => ({ group: "projects", label: p.title, meta: p.purpose, run: () => void room.openBoard(p.id) })),
    ...reg.entries.filter((e) => !e.unfiled && titles.has(e.boardId)).slice(0, 200).map((e) => ({
      group: "sources", label: e.filename, meta: titles.get(e.boardId) ?? "", run: () => void room.openBoard(e.boardId, e.resourceId),
    })),
  ];
  if (items.length) setPicker({ items, sel: 0 });
}

// One listener however many bars are mounted (the library's sits over the board's).
let jumpKeys = 0;
let held: RegisterResponse | undefined;
const onJumpKey = (e: KeyboardEvent): void => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); jumpTo(held); }
};

export default function TopNav(p: TopNavProps) {
  const reg = useEntity<RegisterResponse>(REGISTER);
  held = reg;
  const review = useReviewStrip();
  const [menu, setMenu] = useState<"add" | "more" | null>(null);
  const [study, setStudy] = useState(true);
  const deploy = useDeploy();
  useEffect(() => {
    if (!jumpKeys++) document.addEventListener("keydown", onJumpKey, true);
    return () => { if (!--jumpKeys) document.removeEventListener("keydown", onJumpKey, true); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const shut = () => setMenu(null);
    document.addEventListener("click", shut);
    return () => document.removeEventListener("click", shut);
  }, [menu]);
  const add = (kind: "file" | "link") => { setMenu(null); p.onAdd(kind, study); };
  const due = review ? review.total : 0;
  const tab = (id: Exclude<NavHere, null>, label: ReactNode, go: () => void) =>
    <button className={"tn-tab" + (p.here === id ? " on" : "")} aria-current={p.here === id ? "page" : undefined} onClick={go}>{label}</button>;
  return (
    <nav className="topnav" aria-label="Strata">
      <button className="tn-mark" onClick={() => openTab("today")}>Strata</button>
      <div className="tn-tabs">
        {tab("today", "Today", () => openTab("today"))}
        {tab("projects", "Projects", () => openTab("projects"))}
        {tab("review", <>Review{due ? <span className="tn-badge">{due}</span> : null}</>, () => { journey("review.open"); setReviewing(true); })}
      </div>
      <span className="tn-grow" />
      {p.tools}
      {p.quiet ? null : <>
        <button className="tn-jump" onClick={() => jumpTo(reg)} title="a project or a source, by name">Jump to… <kbd>⌘K</kbd></button>
        <span className="tn-pop">
          <button className="tn-add" aria-expanded={menu === "add"} onClick={(e) => { e.stopPropagation(); if (menu !== "add") setStudy(true); setMenu(menu === "add" ? null : "add"); }}>+ Add</button>
          {menu === "add" ? <span className="addmenu tn-menu" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => add("file")}><b>a file</b>pdf / md / txt / html</button>
            <button className="addmenu-study" aria-pressed={study} title="Make flashcards from the file as it arrives; you can always make them later"
              onClick={() => setStudy((v) => !v)}>make flashcards: {study ? "on" : "off"}</button>
            <button onPointerDown={() => void loadCapture().catch(() => {})} onClick={() => add("link")}><b>from a link</b>youtube / article</button>
          </span> : null}
        </span>
      </>}
      <span className="tn-pop">
        <button className="tn-more" aria-label="More" aria-expanded={menu === "more"} onClick={(e) => { e.stopPropagation(); setMenu(menu === "more" ? null : "more"); }}>···{deploy
          ? <span className={"tn-deploy " + deploy.level} role="img" aria-label={"Deploy: " + deploy.line} title={"Deploy: " + deploy.line} /> : null}</button>
        {menu === "more" ? <span className="addmenu tn-menu right" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setMenu(null); openKeysSheet(); }}><b>Shortcuts</b>?</button>
          {p.adminPath ? <button onClick={() => location.assign(p.adminPath!)}><b>Admin</b></button> : null}
          <button onClick={() => { setMenu(null); p.onSignOut(); }}><b>Log out</b></button>
          {deploy ? <span className={"tn-deploy-line " + deploy.level}><b>Deploy</b>{deploy.line}</span> : null}
        </span> : null}
      </span>
      <Suggest />
    </nav>
  );
}
