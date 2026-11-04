import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { RegisterEntry, RegisterStatus } from "../../../shared/types/index.ts";
import { ago } from "../../shell/format.js";
import CardIcon from "../../shell/CardIcon.tsx";
import { routeSearch } from "../../shell/routes.ts";

const DAY = 864e5;
export const WINDOW_MS = 7 * DAY;
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" }); // one, not one per row

export interface Band { key: string; label: string }

export function bandOf(ts: number, now: number): Band {
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  const start = d0.getTime();
  if (ts >= start) return { key: "today", label: "today" };
  if (ts >= start - DAY) return { key: "yesterday", label: "yesterday" };
  if (ts >= start - 6 * DAY) {
    const d = new Date(ts);
    return { key: "d" + d.toDateString(), label: WEEKDAY.format(d) };
  }
  if (ts >= start - 27 * DAY) return { key: "weeks", label: "earlier this month" };
  return { key: "older", label: "earlier" };
}

const STATE: Record<RegisterStatus, { word: string; cls: string }> = {
  fresh: { word: "fresh", cls: "" },
  reading: { word: "reading", cls: "on" },
  distilling: { word: "distilling", cls: "busy" },
  failed: { word: "wouldn't read", cls: "bad" },
  "to-review": { word: "to review", cls: "owed" },
  kept: { word: "cards kept", cls: "kept" },
  done: { word: "done", cls: "done" },
};

function Status({ e }: { e: RegisterEntry }) {
  const s = STATE[e.status] || STATE.fresh;
  return (
    <span className={"rg-state " + s.cls}>
      {e.status === "distilling" ? <i className="rg-spin" aria-hidden="true" /> : null}
      {s.word}
      {e.status === "reading" && e.readPct > 0 ? <b> {e.readPct}%</b> : null}
    </span>
  );
}

export interface FilingBoard { id: string; title: string }
export type OnRename = (e: RegisterEntry, name: string) => void;
export type OnDelete = (e: RegisterEntry) => void;
export type OnFile = (e: RegisterEntry, boardId: string | null) => void;

function RowMenu({ e, onRename, onDelete, startRename }: { e: RegisterEntry; onRename?: OnRename | null; onDelete?: OnDelete | null; startRename: () => void }) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const shut = () => { setOpen(false); setArmed(false); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); shut(); } };
    document.addEventListener("click", shut);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("click", shut); document.removeEventListener("keydown", key, true); };
  }, [open]);

  if (!onRename && !onDelete) return null;
  return (
    <span className="rg-actions" onClick={(ev) => ev.stopPropagation()}>
      <button className="rg-dots" title="file actions" aria-label={`Actions for ${e.filename}`}
        aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setArmed(false); setOpen((v) => !v); }}>⋯</button>
      {open ? <span className="rg-menu" role="menu">
        {onRename ? <button role="menuitem" onClick={() => { setOpen(false); startRename(); }}>rename</button> : null}
        {onDelete ? <button role="menuitem" className={armed ? "bad armed" : "bad"}
          onClick={() => {
            if (armed) { setOpen(false); setArmed(false); onDelete(e); }
            else setArmed(true);
          }}>{armed ? "delete this source?" : "delete"}</button> : null}
      </span> : null}
    </span>
  );
}

function FilePicker({ entry, boards, onFile, onClose }: { entry: RegisterEntry; boards: FilingBoard[]; onFile: OnFile; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const matches = boards.filter((b) => b.title.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    el.querySelector("input")!.focus();
    return () => el.close();
  }, []);
  return createPortal(
    <dialog className="file-picker" ref={dialog} aria-labelledby={heading}
      onCancel={onClose} onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
      <div className="file-picker-inner">
        <div className="file-picker-head"><h2 id={heading}>File to a board</h2><button onClick={onClose} aria-label="Close filing">✕</button></div>
        <p>{entry.filename}</p>
        <input type="search" aria-label="Find a board" placeholder="Find a board…" value={query} onChange={(ev) => setQuery(ev.target.value)} />
        <div className="file-picker-label">{query ? "Matching boards" : "Recently active"}</div>
        <div className="file-picker-options">
          {matches.length ? matches.map((b) => <button key={b.id} onClick={() => onFile(entry, b.id)}><span>{b.title}</span><span aria-hidden="true">→</span></button>)
            : <p>No boards found.</p>}
        </div>
        <button className="file-picker-new" onClick={() => onFile(entry, null)}>+ Create a board for this source</button>
      </div>
    </dialog>, document.body
  );
}

// A real href, so a modified or middle click opens a new tab; a plain click stays in the room.
function OpenLink({ board, resource, onOpen, ...rest }: { board: string; resource?: string; onOpen: () => void; className: string; title?: string; children: ReactNode }) {
  return <a {...rest} href={location.pathname + routeSearch({ kind: "board", board, resource })}
    onClick={(ev) => { if (ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return; ev.preventDefault(); onOpen(); }} />;
}

interface RowProps {
  e: RegisterEntry;
  boards: FilingBoard[];
  boardCol: boolean;
  onOpen: (boardId: string, sourceId?: string) => void;
  onFile?: OnFile | null;
  filing?: string | null;
  setFiling: (sourceId: string | null) => void;
  onRename?: OnRename | null;
  onDelete?: OnDelete | null;
}

function Row({ e, boards, boardCol, onOpen, onFile, filing, setFiling, onRename, onDelete }: RowProps) {
  const open = filing === e.resourceId;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(e.filename);
  const commitRename = () => {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== e.filename) onRename!(e, name);
  };
  // Filing uses a dialog so long board names cannot be clipped by a ledger row.
  const board = boardCol ? (
    e.unfiled
      ? <span className="rg-board rg-boardcell">
          {onFile && e.pairId
            ? <button className={"rg-unfiled" + (open ? " open" : "")} title="File to a board" aria-haspopup="dialog" aria-expanded={open}
                onClick={(ev) => { ev.stopPropagation(); setFiling(open ? null : e.resourceId); }}>File to board</button>
            : <em className="rg-unfiled">unfiled</em>}
          {open ? <FilePicker entry={e} boards={boards} onFile={onFile!} onClose={() => setFiling(null)} /> : null}
        </span>
      : <OpenLink className="rg-board" board={e.boardId} onOpen={() => onOpen(e.boardId)}>{e.boardTitle}</OpenLink>
  ) : null;
  const details = <>
    <Status e={e} />
    <span className="rg-right">
      {e.kept > 0 ? <span className="rg-kept" title={`${e.kept} card${e.kept === 1 ? "" : "s"} kept from this`} aria-label={`${e.kept} card${e.kept === 1 ? "" : "s"} kept`}><CardIcon /> {e.kept}</span> : null}
      <span className="rg-age">{ago(e.createdAt) || "just now"}</span>
    </span>
  </>;
  return (
    <div className={"rg-row" + (open ? " picking" : "") + (boardCol ? "" : " nb") + (onRename || onDelete ? " actions" : "")}>
      {renaming
        ? <div className="rg-hit editing">
            <input className="rg-rename" autoFocus value={draft}
              onFocus={(ev) => ev.target.select()} onChange={(ev) => setDraft(ev.target.value)}
              onBlur={commitRename}
              onKeyDown={(ev) => {
                ev.stopPropagation();
                if (ev.key === "Enter") { ev.preventDefault(); ev.currentTarget.blur(); }
                if (ev.key === "Escape") { ev.preventDefault(); setRenaming(false); setDraft(e.filename); }
              }} />
            {board}
            {details}
          </div>
        : <div className="rg-hit">
            <OpenLink className="rg-title" board={e.boardId} resource={e.resourceId} onOpen={() => onOpen(e.boardId, e.resourceId)}
              title={e.originUrl || e.filename}>{e.filename}</OpenLink>
            {board}
            {details}
          </div>}
      <RowMenu e={e} onRename={onRename} onDelete={onDelete}
        startRename={() => { setDraft(e.filename); setRenaming(true); }} />
    </div>
  );
}

export interface TimelineProps extends Omit<RowProps, "e" | "boards" | "boardCol"> {
  entries: RegisterEntry[];
  boards?: FilingBoard[] | null;
  boardCol?: boolean;
  empty?: ReactNode;
}

function Timeline({ entries, boards, boardCol = true, onOpen, onFile, filing, setFiling, onRename, onDelete, empty }: TimelineProps) {
  const [older, setOlder] = useState(false);

  const edge = Date.now() - WINDOW_MS;
  const shown = older ? entries : entries.filter((e) => e.createdAt >= edge);
  const behind = entries.length - shown.length;

  const bands: (Band & { rows: RegisterEntry[] })[] = [];
  const now = Date.now();
  for (const e of shown) {
    const b = bandOf(e.createdAt, now);
    const last = bands[bands.length - 1];
    if (last && last.key === b.key) last.rows.push(e);
    else bands.push({ ...b, rows: [e] });
  }

  if (!entries.length) return <div className="rg-empty">{empty}</div>;

  return (
    <>
      {shown.length ? (
        <div className="rg-rows">
          {bands.map((b) => (
            <div className="rg-band" key={b.key}>
              <div className="rg-bh"><span>{b.label}</span><i /></div>
              {b.rows.map((e) => (
                <Row key={e.boardId + ":" + e.resourceId} e={e} boards={boards || []} boardCol={boardCol}
                  onOpen={onOpen} onFile={onFile} filing={filing} setFiling={setFiling}
                  onRename={onRename} onDelete={onDelete} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="rg-empty">Nothing in the last week.</div>
      )}
      {behind > 0 ? (
        <button className="rg-more" onClick={() => setOlder(true)}>
          {behind} older<i />show
        </button>
      ) : null}
    </>
  );
}

export default Timeline;
