import { useEffect, useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash, useDashBoard, useRoutine, type DashItem, type DashTask } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import { go, type Mode, type Sub } from "./nav.ts";
import { Grow, Src, age, hm, newThreadId, useTyped } from "./parts.tsx";
import { move, pick, saveText } from "./moves.ts";

const OLD = 14 * 864e5;
const TABS: [Sub, string][] = [["inbox", "Inbox"], ["backlog", "Backlog"], ["todo", "To-do"]];
const said = (e: unknown, what: string) => toast(StrataWhy(e, what), 4200);

function useArea(): [string, (a: string) => void] {
  const [area, setArea] = useState(() => { try { return localStorage.getItem("dashboard-area") === "personal" ? "personal" : "work"; } catch { return "work"; } });
  return [area, (a) => { setArea(a); try { localStorage.setItem("dashboard-area", a); } catch { /* private mode: the choice lasts the visit */ } }];
}

/** Triage: what came in, what you keep, and what is next. The same in both modes; Dispatch takes a thread from here. */
export default function Triage({ mode, sub }: { mode: Mode; sub: Sub }) {
  const board = useDashBoard();
  const [area, setArea] = useArea();
  const [open, setOpen] = useState<string | null>(null);
  const [unfold, setUnfold] = useState(false);
  const tasks = (board?.tasks ?? []).filter((t) => t.area === area);
  const inbox = (board?.inbox ?? []).filter((i) => (i.area || "work") === area);
  const backlog = tasks.filter((t) => t.stage === "backlog").sort((a, b) => b.createdAt - a.createdAt);
  const todo = tasks.filter((t) => t.stage === "todo").sort((a, b) => Number(!!b.morningAt) - Number(!!a.morningAt) || b.updatedAt - a.updatedAt);
  const counts: Record<Sub, number> = { inbox: inbox.length, backlog: backlog.length, todo: todo.length };
  const picks = (board?.tasks ?? []).filter((t) => t.stage === "todo" && t.morningAt).sort((a, b) => (a.morningAt ?? 0) - (b.morningAt ?? 0));
  const drop = useDrop();

  return (
    <div className="triage">
      <section className="tr-col">
        <div className="tr-tabs" role="tablist" aria-label="Triage">
          {TABS.map(([k, name]) => <button key={k} role="tab" aria-selected={sub === k} {...drop.zone(k)}
            onClick={() => { setOpen(null); go({ sub: k }); }}>{name} <i>{counts[k] || ""}</i></button>)}
          <span className="grow" />
          <span className="tr-area" role="tablist" aria-label="Work or personal">
            {["work", "personal"].map((a) => <button key={a} role="tab" aria-selected={area === a} onClick={() => setArea(a)}>{a === "work" ? "Work" : "Personal"}</button>)}
          </span>
        </div>
        {!board ? <p className="tr-empty">Loading…</p>
          : sub === "inbox" ? <InboxList items={inbox} mode={mode} />
          : sub === "backlog" ? <>
              <NewThread area={area} onMade={setOpen} />
              <div className="tr-list">
                {backlog.filter((t) => unfold || Date.now() - t.createdAt <= OLD).map((t) => <Thread key={t.id} t={t} open={open === t.id} onOpen={setOpen} mode={mode} drag={drop.drag} />)}
                {!unfold && backlog.some((t) => Date.now() - t.createdAt > OLD)
                  ? <button className="tr-fold" onClick={() => setUnfold(true)}>{backlog.filter((t) => Date.now() - t.createdAt > OLD).length} more, older than two weeks</button> : null}
                {backlog.length ? null : <p className="tr-empty">The backlog is empty. Keep something from the inbox, or write a thread above.</p>}
              </div>
            </>
          : <div className="tr-list">
              {todo.map((t) => <Thread key={t.id} t={t} open={open === t.id} onOpen={setOpen} mode={mode} drag={drop.drag} />)}
              {todo.length ? null : <p className="tr-empty">Nothing in to-do. Open a backlog thread and move it here, or drag one onto the tab.</p>}
            </div>}
      </section>
      <aside className="tr-morning">
        <h2>Tomorrow morning <i>{picks.length || ""}</i></h2>
        <div className="tr-box" {...drop.zone("morning")}>
          {picks.map((t) => <div key={t.id} className="tr-pick" draggable onDragStart={drop.drag(t.id)}>
            <span>{t.title}</span>
            <button aria-label="Not tomorrow morning" title="Not tomorrow" onClick={() => void pick(t.id, false)}>×</button>
          </div>)}
          <div className="tr-pick empty">Drag a thread here</div>
        </div>
        <p className="tr-hint">These open first in Thinking. A nudge, not a rule.</p>
      </aside>
    </div>
  );
}

function InboxList({ items, mode }: { items: DashItem[]; mode: Mode }) {
  const [cur, setCur] = useState<string | null>(null);
  const at = items.find((i) => i.id === cur) ? cur : items[0]?.id ?? null;
  const next = (id: string) => { const i = items.findIndex((x) => x.id === id); setCur(items[i + 1]?.id ?? items[i - 1]?.id ?? null); };
  const keep = (id: string, stage: "backlog" | "todo", area: string) => { next(id); toast(stage === "todo" ? "→ To-do" : "→ Backlog"); dash.keep(id, stage, area).catch((e) => said(e, "not kept")); };
  const drop = (id: string) => { next(id); toast("Dropped"); dash.drop(id).catch((e) => said(e, "not dropped")); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!at || t.matches?.("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
      const it = items.find((i) => i.id === at)!;
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); keep(at, "backlog", it.area); }
      else if (k === "t") { e.preventDefault(); keep(at, "todo", it.area); }
      else if (k === "x") { e.preventDefault(); drop(at); }
      else if (k === "j" || k === "k") { const i = items.findIndex((x) => x.id === at); const n = items[i + (k === "j" ? 1 : -1)]; if (n) setCur(n.id); }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });
  return <div className="tr-list">
    {items.map((p) => p.id === at
      ? <article key={p.id} className="tr-card in" aria-current="true">
          <h3>{p.title}</h3>
          {p.context ? <p className="tr-ctx">{p.context}</p> : null}
          {p.from?.quote ? <blockquote>“{p.from.quote}”</blockquote> : null}
          <div className="tr-meta"><Src from={p.from} /><span>{age(p.at)}</span>
            <span className="grow" />
            <span className="tr-area small" role="group" aria-label="Work or personal">
              {["work", "personal"].map((a) => <button key={a} aria-pressed={p.area === a} onClick={() => dash.itemArea(p.id, a).catch((e) => said(e, "not moved"))}>{a === "work" ? "Work" : "Personal"}</button>)}
            </span>
            <button className="btn" onClick={() => keep(p.id, "backlog", p.area)}>→ Backlog</button>
            <button className="btn" onClick={() => keep(p.id, "todo", p.area)}>→ To-do</button>
            <button className="btn quiet" onClick={() => drop(p.id)}>Drop</button>
          </div>
        </article>
      : <button key={p.id} className="tr-row in" onClick={() => setCur(p.id)}>
          <span className="t">{p.title}</span>
          {p.context ? <span className="ctx">“{p.context}”</span> : null}
          <span className="tr-meta"><Src from={p.from} /><span>{age(p.at)}</span></span>
        </button>)}
    {items.length ? null : <p className="tr-empty">Nothing new. Agents add here with dashboard_add_items; you keep or drop each.</p>}
    {items.length ? <p className="tr-keys"><kbd>b</kbd> backlog · <kbd>t</kbd> to-do · <kbd>x</kbd> drop · <kbd>j</kbd><kbd>k</kbd> move{mode === "dispatch" ? " · send a kept thread from Backlog" : ""}</p> : null}
    <Routine />
  </div>;
}

/** A thread in the backlog or to-do: one line until opened, then its title and prompt to trim, and where it goes next. */
function Thread({ t, open, onOpen, mode, drag }: { t: DashTask; open: boolean; onOpen(id: string | null): void; mode: Mode; drag(id: string): (e: React.DragEvent) => void }) {
  const [title, setTitle, flushTitle] = useTyped(t.title, (v) => saveText(t.id, "title", v));
  const [body, setBody, flushBody] = useTyped(t.body, (v) => saveText(t.id, "body", v));
  const meta = [t.links[0]?.ref, t.createdFrom?.source !== "You" ? t.createdFrom?.source : "You", age(t.createdAt)].filter(Boolean).join(" · ");
  if (!open) return (
    <div className={"r" + (t.morningAt ? " pick" : "")} draggable onDragStart={drag(t.id)}>
      <button className="t" onClick={() => onOpen(t.id)} title={t.title}>{t.title}</button>
      <span className="r-meta">{t.morningAt ? <span className="r-tag">tomorrow</span> : null}{t.links[0]?.ref ?? (t.createdFrom?.source === "You" ? "You" : "")}</span>
    </div>
  );
  const leave = () => { flushTitle(); flushBody(); onOpen(null); };
  return (
    <article className="tr-card open" draggable={false}>
      <div className="tr-head">
        <Grow className="dtitle" value={title} aria-label="Title" onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.currentTarget.closest("article")?.querySelector(".dbody") as HTMLElement | null)?.focus(); } if (e.key === "Escape") leave(); }} />
        <span className="tr-src">{meta}</span>
      </div>
      <label className="cap" htmlFor={`body-${t.id}`}>Prompt · yours to trim</label>
      <Grow id={`body-${t.id}`} className="dbody" value={body} placeholder="What should be done, in a few lines you could hand to Claude." onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") leave(); }} />
      <div className="tr-acts">
        <button className="btn quiet" onClick={() => { leave(); move(t, "dropped"); }}>Drop</button>
        <button className="btn quiet" aria-label={t.morningAt ? "Not tomorrow morning" : "Tomorrow morning"} onClick={() => void pick(t.id, !t.morningAt)}>{t.morningAt ? "Not tomorrow" : "Tomorrow morning"}</button>
        {t.stage === "backlog" ? <button className="btn quiet" onClick={() => { leave(); move(t, "todo"); }}>→ To-do</button>
          : <button className="btn quiet" onClick={() => { leave(); move(t, "backlog"); }}>← Backlog</button>}
        <span className="grow" />
        <button className="btn" onClick={() => { leave(); move(t, "thinking"); go({ mode: "focus", view: "thinking" }); }}>Think it through</button>
        <button className="btn dark" onClick={() => { leave(); toast("Sent to Dispatch"); dash.send(t.id).catch((e) => said(e, "not sent")); }}>Send to Dispatch →</button>
      </div>
      <p className="tr-hint">{mode === "dispatch" ? "Sending starts Claude preparing its page. It shows up in Decide when it is ready." : "Think it through opens it in Thinking. Send to Dispatch hands it to Claude, who comes back with a page."}</p>
    </article>
  );
}

function NewThread({ area, onMade }: { area: string; onMade(id: string): void }) {
  const [title, setTitle] = useState("");
  return <form className="tr-add" onSubmit={(e) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const id = newThreadId();
    setTitle("");
    dash.create({ id, title: t, area }).catch((err) => said(err, "not added"));
    onMade(id);
  }}>
    <input id="addIn" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New thread…" autoComplete="off" aria-label="New thread" />
    <button className="btn" type="submit">Add</button>
  </form>;
}

// Drag a row onto a tab to move it there, or onto Tomorrow morning to pick it.
function useDrop() {
  const [over, setOver] = useState<string | null>(null);
  const board = useDashBoard();
  return {
    drag: (id: string) => (e: React.DragEvent) => { try { e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; } catch { /* some browsers refuse data on drag */ } },
    zone: (to: string) => ({
      "data-over": over === to ? "true" : undefined,
      onDragOver: (e: React.DragEvent) => { if (to === "inbox") return; e.preventDefault(); setOver(to); },
      onDragLeave: () => setOver((o) => (o === to ? null : o)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault(); setOver(null);
        const id = e.dataTransfer.getData("text/plain"), t = board?.tasks.find((x) => x.id === id);
        if (!t) return;
        if (to === "morning") void pick(id, true);
        else if (to === "backlog" || to === "todo") move(t, to);
      },
    }),
  };
}

function Routine() {
  const r = useRoutine();
  const [form, setForm] = useState(false);
  const [url, setUrl] = useState(""), [token, setToken] = useState("");
  const [running, setRunning] = useState(false);
  if (!r) return null;
  const cooling = !!r.ranAt && Date.now() - r.ranAt < 60_000;
  return <div className="tr-routine">
    {r.connected
      ? <div className="row"><button className="btn small" disabled={running || cooling} onClick={() => { setRunning(true); dash.runRoutine().then((v) => toast(v.error ? "The routine didn’t start." : "The routine is running."), (e) => said(e, "didn’t run")).finally(() => setRunning(false)); }}>
          {running ? "Starting…" : "Run the routine now"}</button>
          <span>{r.ranAt ? <>Last run {hm(r.ranAt)}{r.sessionUrl ? <> · <a href={r.sessionUrl} target="_blank" rel="noopener">open</a></> : null}</> : "Not run yet"}</span>
          <button className="btn quiet small" onClick={() => setForm(!form)}>Change</button></div>
      : <div className="row"><span>Connect the scheduled routine to run it from here, and from Dispatch.</span><button className="btn quiet small" onClick={() => setForm(!form)}>Connect</button></div>}
    {r.error ? <p className="err">{r.error}</p> : null}
    {form ? <form className="row" autoComplete="off" onSubmit={(e) => { e.preventDefault(); dash.routine({ url: url.trim(), token: token.trim() }).then(() => { setForm(false); toast("Routine connected."); }, (er) => said(er, "not saved")); }}>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Fire URL: https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" aria-label="Fire URL" />
      <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="API token, shown once when you make it" aria-label="API token" />
      <button className="btn small" type="submit">Save</button>
      {r.connected ? <button className="btn quiet small" type="button" onClick={() => { dash.routine({ url: null }).then(() => { setForm(false); toast("Routine disconnected."); }, (er) => said(er, "not saved")); }}>Disconnect</button> : null}
    </form> : null}
  </div>;
}
