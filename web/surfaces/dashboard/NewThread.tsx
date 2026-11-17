import { useEffect, useRef, useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import { Grow, newThreadId, useArea } from "./parts.tsx";

type Draft = { title: string; body: string };
const EMPTY: Draft = { title: "", body: "" };
// outlives the form, so Esc or a tab change never loses what was typed
let held: Draft = EMPTY;
const said = (e: unknown, what: string) => toast(StrataWhy(e, what), 4200);
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");

/** The foot of Dispatch's sidebar: a thread written here goes to to-do, or straight to Claude, and the page you read stays open. */
export default function NewThread() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(held);
  const [area, setArea] = useArea();
  const titleRef = useRef<HTMLInputElement>(null);
  const put = (d: Draft) => { held = d; setDraft(d); };

  useEffect(() => {
    if (open) { titleRef.current?.focus(); return; }
    const key = (e: KeyboardEvent) => {
      if (e.key !== "n" && e.key !== "N") return;
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      setOpen(true);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open]);

  function make(send: boolean): void {
    const title = draft.title.trim();
    if (!title) { titleRef.current?.focus(); return; }
    const was = draft, id = newThreadId();
    put(EMPTY);
    setOpen(false);
    dash.create({ id, title, body: draft.body.trim(), area }).catch((e) => said(e, "not added"));
    if (send) { toast("Sent to Dispatch"); dash.send(id).catch((e) => said(e, "not sent")); return; }
    toast("Kept in to-do", 5000, { label: "Undo", run: () => { put(was); setOpen(true); dash.end(id).catch((e) => said(e, "not undone")); } });
  }

  if (!open) return <div className="ws-new">
    <button className="ws-new-row" onClick={() => setOpen(true)}><b>+</b> New thread<kbd>N</kbd></button>
  </div>;
  return <div className="ws-new">
    <form className="ws-new-form" aria-label="New thread" onSubmit={(e) => { e.preventDefault(); make(false); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); } }}>
      <input ref={titleRef} value={draft.title} placeholder="Title" aria-label="Title" autoComplete="off"
        onChange={(e) => put({ ...draft, title: e.target.value })}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.currentTarget.form?.querySelector("textarea") as HTMLElement | null)?.focus(); } }} />
      <Grow value={draft.body} placeholder="Context…" aria-label="Context" onChange={(e) => put({ ...draft, body: e.target.value })} />
      <span className="tr-area small" role="tablist" aria-label="Work or personal">
        {["work", "personal"].map((a) => <button key={a} type="button" role="tab" aria-selected={area === a} onClick={() => setArea(a)}>{a === "work" ? "Work" : "Personal"}</button>)}
      </span>
      <div className="acts">
        <button className="btn dark" type="submit">Keep in to-do</button>
        <button className="btn" type="button" onClick={() => make(true)}>Send to Dispatch</button>
      </div>
    </form>
  </div>;
}
