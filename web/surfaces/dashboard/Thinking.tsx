import { useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash, useDashBoard, type DashTask } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import { go } from "./nav.ts";
import { Grow, Notes, Src, useTyped } from "./parts.tsx";
import { move, saveText } from "./moves.ts";

/** Thinking: one thread's notes open on the sheet, the rest waiting on the left, morning picks first. */
export default function Thinking() {
  const board = useDashBoard();
  const tasks = board?.tasks ?? [];
  const open = tasks.filter((t) => t.stage === "thinking").sort((a, b) => b.updatedAt - a.updatedAt);
  const picks = tasks.filter((t) => t.stage === "todo" && t.morningAt).sort((a, b) => (a.morningAt ?? 0) - (b.morningAt ?? 0));
  const rest = tasks.filter((t) => t.stage === "todo" && !t.morningAt).sort((a, b) => b.updatedAt - a.updatedAt);
  const [sel, setSel] = useState<string | null>(null);
  const t = open.find((x) => x.id === sel) ?? open[0] ?? null;
  const take = (x: DashTask) => { setSel(x.id); move(x, "thinking"); };
  return (
    <div className="ws">
      <aside className="ws-list" aria-label="Threads">
        {open.map((x) => <button key={x.id} className={"ws-card" + (t?.id === x.id ? " on" : "")} onClick={() => setSel(x.id)}>
          <span className="t">{x.title}</span><span className="m">{x.links[0]?.ref ?? x.createdFrom?.source ?? ""}</span></button>)}
        {picks.length ? <h3 className="ws-group">Tomorrow morning</h3> : null}
        {picks.map((x) => <button key={x.id} className="ws-card wait" onClick={() => take(x)} title="Open in Thinking"><span className="t">{x.title}</span></button>)}
        {rest.length ? <h3 className="ws-group">To-do</h3> : null}
        {rest.map((x) => <button key={x.id} className="ws-card wait dim" onClick={() => take(x)} title="Open in Thinking"><span className="t">{x.title}</span></button>)}
        {!open.length && !picks.length && !rest.length ? <p className="ws-none">Nothing to think about yet. Keep threads in Triage and pick them for to-do.</p> : null}
      </aside>
      <div className="ws-room">
        <div className="ws-caption">{t ? <span>Your notes · {t.area} · since {new Date(t.updatedAt).toLocaleDateString([], { day: "numeric", month: "short" })}</span> : <span />}</div>
        <div className="ws-sheet">
          {t ? <Doc key={t.id} t={t} /> : <div className="ws-blank"><p>{open.length ? "Pick a thread on the left." : "Nothing in Thinking yet. Open one from the left, or from Triage."}</p></div>}
        </div>
      </div>
    </div>
  );
}

/** A thread's doc: its title and the notes you write until you could hand it over without being in the room. */
export function Doc({ t, where = "thinking" }: { t: DashTask; where?: "thinking" | "review" }) {
  const [title, setTitle, flushTitle] = useTyped(t.title, (v) => saveText(t.id, "title", v));
  const [body, setBody, flushBody] = useTyped(t.body, (v) => saveText(t.id, "body", v));
  const [editing, setEditing] = useState(false);
  const flush = () => { flushTitle(); flushBody(); };
  const copy = () => {
    const text = `${title}\n\n${body}`.trim();
    navigator.clipboard?.writeText(text).then(() => toast("Copied for Claude"), () => toast("Couldn’t copy"));
  };
  return (
    <article className="doc">
      <div className="doc-crumb"><Src from={t.createdFrom} /><span className="grow" />
        {t.links.map((l, i) => l.url ? <a key={i} href={l.url} target="_blank" rel="noopener">{l.ref}</a> : <span key={i}>{l.ref}</span>)}</div>
      <Grow className="dtitle" value={title} aria-label="Title" placeholder="Untitled" onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }} />
      {editing
        ? <Grow className="dbody" value={body} aria-label="Notes" autoFocus onChange={(e) => setBody(e.target.value)}
            onBlur={() => { flushBody(); setEditing(false); }} placeholder="Write until you could hand it to Claude without being in the room." />
        : <div className="doc-notes" role="textbox" tabIndex={0} aria-label="Notes" onClick={(e) => { if (!(e.target as HTMLElement).closest("a") && !getSelection()?.toString()) setEditing(true); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }}>
            {body.trim() ? <Notes text={body} /> : <p className="ph">Write until you could hand it to Claude without being in the room.</p>}
          </div>}
      <div className="doc-foot">
        {where === "thinking"
          ? <><button className="btn dark" onClick={() => { flush(); move(t, "review"); go({ view: "review" }); }}>→ Review</button>
              <button className="btn" onClick={() => { flush(); toast("Sent to Dispatch"); dash.send(t.id).catch((e) => toast(StrataWhy(e, "not sent"), 4200)); }}>Send to Dispatch →</button>
              <button className="btn quiet" onClick={copy}>Copy for Claude</button>
              <span className="grow" />
              <button className="btn quiet" onClick={() => { flush(); move(t, "todo"); }}>Close for now</button></>
          : <button className="btn quiet" onClick={copy}>Copy for Claude</button>}
      </div>
    </article>
  );
}
