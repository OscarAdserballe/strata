import { useEffect, useRef, useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import { Grow, newThreadId, useArea } from "./parts.tsx";

const said = (e: unknown, what: string) => toast(StrataWhy(e, what), 4200);
const typing = (t: EventTarget | null): boolean => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [contenteditable='']");

/** The row under Dispatch's cards: a thread written here is kept in to-do, or sent straight to Claude. The draft outlives Esc. */
export default function NewThread() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [area, setArea] = useArea();
  const titleRef = useRef<HTMLInputElement | null>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const back = useRef(false);

  useEffect(() => {
    if (open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented || typing(e.target)) return;
      e.preventDefault();
      setOpen(true);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [open]);
  useEffect(() => {
    if (open) titleRef.current?.focus();
    else if (back.current) { back.current = false; rowRef.current?.focus(); }
  }, [open]);

  const close = () => { back.current = true; setOpen(false); };
  const make = (send: boolean) => {
    const t = title.trim();
    if (!t) { titleRef.current?.focus(); return; }
    const id = newThreadId(), draft = { title, context };
    setTitle(""); setContext(""); close();
    dash.create({ id, title: t, body: context.trim() ? context : "", area }).catch((e) => said(e, "not added"));
    if (send) { toast("Sent to Dispatch"); dash.send(id).catch((e) => said(e, "Send didn't reach Claude")); return; }
    toast("Kept in to-do", 5000, { label: "Undo", run: () => {
      dash.end(id).catch((e) => said(e, "not undone"));
      setTitle((cur) => cur || draft.title); setContext((cur) => cur || draft.context); setOpen(true);
    } });
  };

  if (!open) return <div className="nt">
    <button ref={rowRef} className="nt-row" aria-expanded={false} onClick={() => setOpen(true)}><span>+ New thread</span><kbd>N</kbd></button>
  </div>;
  return <div className="nt">
    <form className="nt-form" aria-label="New thread" onSubmit={(e) => { e.preventDefault(); make(false); }}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); make(false); }
      }}>
      <div className="nt-head"><span className="cap">New thread</span>
        <span className="tr-area small" role="tablist" aria-label="Work or personal">
          {["work", "personal"].map((a) => <button key={a} type="button" role="tab" aria-selected={area === a} onClick={() => setArea(a)}>{a === "work" ? "Work" : "Personal"}</button>)}
        </span>
      </div>
      <input ref={titleRef} className="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" aria-label="Title" autoComplete="off"
        onKeyDown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); (e.currentTarget.form?.querySelector(".nt-ctx") as HTMLElement | null)?.focus(); } }} />
      <Grow className="nt-ctx" value={context} onChange={(e) => setContext(e.target.value)} placeholder="Context: what Claude should know" aria-label="Context" />
      <div className="nt-acts">
        <button type="submit" className="btn dark" disabled={!title.trim()}>Keep in to-do</button>
        <button type="button" className="btn" disabled={!title.trim()} onClick={() => make(true)}>Send to Dispatch</button>
      </div>
    </form>
  </div>;
}
