import { useEffect, useState } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash, useDashBoard, useRoutine, type DashItem, type DashTask } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import { go, type Mode, type Sub } from "./nav.ts";
import Writer from "../../capabilities/write/Writer.tsx";
import { Grow, Src, age, hm, newThreadId, useTyped } from "./parts.tsx";
import { move, saveText } from "./moves.ts";

const OLD = 14 * 864e5;
const TABS: [Sub, string][] = [["inbox", "Inbox"], ["todo", "To-do"]];
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
  const todo = tasks.filter((t) => t.stage === "todo").sort((a, b) => b.createdAt - a.createdAt);
  const old = todo.filter((t) => Date.now() - t.createdAt > OLD).length;
  const counts: Record<Sub, number> = { inbox: inbox.length, todo: todo.length };

  const where = sub === "inbox" ? counts.inbox ? `${counts.inbox} new` : "Inbox" : counts.todo ? `${counts.todo} to do` : "To-do";
  return (
    <div className="ws triage">
      <aside className="ws-list" aria-label="Triage">
        <nav className="tr-nav" role="tablist" aria-label="Triage">
          {TABS.filter(([k]) => k !== "inbox").map(([k, name]) => <button key={k} role="tab" aria-selected={sub === k} className={"ws-card" + (sub === k ? " on" : "")}
            onClick={() => { setOpen(null); go({ sub: k }); }}><span className="t">{name}</span><i>{counts[k] || ""}</i></button>)}
        </nav>
        <Routine />
      </aside>
      <div className="ws-room">
        <div className="ws-caption plain"><span>{where}</span>
          <span className="tr-area" role="tablist" aria-label="Work or personal">
            {["work", "personal"].map((a) => <button key={a} role="tab" aria-selected={area === a} onClick={() => setArea(a)}>{a === "work" ? "Work" : "Personal"}</button>)}
          </span>
        </div>
        <section className="tr-main">
          {!board ? <p className="tr-empty">Loading…</p>
            : sub === "inbox" ? <InboxList items={inbox} mode={mode} />
            : <>
                <NewThread area={area} onMade={setOpen} />
                <div className="tr-list">
                  {todo.filter((t) => unfold || Date.now() - t.createdAt <= OLD).map((t) => <Thread key={t.id} t={t} open={open === t.id} onOpen={setOpen} mode={mode} />)}
                  {!unfold && old ? <button className="tr-fold" onClick={() => setUnfold(true)}>{old} more, older than two weeks</button> : null}
                  {todo.length ? null : <Empty title="Nothing in to-do" text="Keep something from the inbox, or write a thread above." act={["Open the inbox", () => go({ sub: "inbox" })]} />}
                </div>
              </>}
        </section>
      </div>
    </div>
  );
}

function InboxList({ items, mode }: { items: DashItem[]; mode: Mode }) {
  const [cur, setCur] = useState<string | null>(null);
  const at = items.find((i) => i.id === cur) ? cur : items[0]?.id ?? null;
  const next = (id: string) => { const i = items.findIndex((x) => x.id === id); setCur(items[i + 1]?.id ?? items[i - 1]?.id ?? null); };
  const keep = (id: string, area: string) => { next(id); toast("Kept in to-do"); dash.keep(id, area).catch((e) => said(e, "not kept")); };
  const drop = (id: string) => { next(id); toast("Dropped"); dash.drop(id).catch((e) => said(e, "not dropped")); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!at || (t.matches?.("input, textarea") || t.isContentEditable) || e.metaKey || e.ctrlKey || e.altKey) return;
      const it = items.find((i) => i.id === at)!;
      const k = e.key.toLowerCase();
      if (k === "t") { e.preventDefault(); keep(at, it.area); }
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
          <div className="tr-meta"><Src from={p.from} /><span>{age(p.at)}</span></div>
          <div className="acts-row">
            <button className="btn dark" onClick={() => keep(p.id, p.area)}>Keep in to-do</button>
            <button className="btn quiet" onClick={() => { const a = p.area === "personal" ? "work" : "personal"; next(p.id); toast(`Moved to ${a}`); dash.itemArea(p.id, a).catch((e) => said(e, "not moved")); }}>
              Move to {p.area === "personal" ? "work" : "personal"}</button>
            <span className="grow" />
            <button className="btn quiet danger" onClick={() => drop(p.id)}>Drop</button>
          </div>
        </article>
      : <button key={p.id} className="tr-row in" onClick={() => setCur(p.id)}>
          <span className="t">{p.title}</span>
          {p.context ? <span className="ctx">“{p.context}”</span> : null}
          <span className="tr-meta"><Src from={p.from} /><span>{age(p.at)}</span></span>
        </button>)}
    {items.length ? null : <Empty title="Inbox zero" text="New things land here from your agents and from you. Keep each in to-do, or drop it." />}
    {items.length ? <p className="tr-keys"><kbd>t</kbd> keep in to-do · <kbd>x</kbd> drop · <kbd>j</kbd> <kbd>k</kbd> move{mode === "dispatch" ? " · send a kept thread from to-do" : ""}</p> : null}
  </div>;
}

/** A thread in to-do: one line until opened, then its title and prompt to trim, and where it goes next. */
function Thread({ t, open, onOpen, mode }: { t: DashTask; open: boolean; onOpen(id: string | null): void; mode: Mode }) {
  const [title, setTitle, flushTitle, titleHeld] = useTyped(t.title, (v) => saveText(t.id, "title", v));
  const [body, setBody, flushBody, bodyHeld] = useTyped(t.body, (v) => saveText(t.id, "body", v));
  const meta = [t.links[0]?.ref, t.createdFrom?.source !== "You" ? t.createdFrom?.source : "You", age(t.createdAt)].filter(Boolean).join(" · ");
  if (!open) return (
    <div className="r">
      <button className="t" onClick={() => onOpen(t.id)} title={t.title}>{t.title}</button>
      <span className="r-meta">{t.links[0]?.ref ?? (t.createdFrom?.source === "You" ? "You" : "")}</span>
    </div>
  );
  const leave = () => { flushTitle(); flushBody(); onOpen(null); };
  return (
    <article className="tr-card open">
      <div className="tr-head">
        <Grow className="dtitle" value={title} aria-label="Title" {...titleHeld} onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.currentTarget.closest("article")?.querySelector(".dbody") as HTMLElement | null)?.focus(); } if (e.key === "Escape") leave(); }} />
        <span className="tr-src">{meta}</span>
      </div>
      <span className="cap">Prompt · yours to trim</span>
      <Writer className="dbody" value={body} label="Prompt" placeholder="What should be done, in a few lines you could hand to Claude." {...bodyHeld} onChange={setBody}
        onKeyDown={(e) => { if (e.key === "Escape") leave(); }} />
      <div className="acts-row">
        <button className="btn dark" title={mode === "dispatch" ? "Claude prepares a page; it shows up in Decide" : "Claude comes back with a page in Dispatch"} onClick={() => { leave(); toast("Sent to Dispatch"); dash.send(t.id).catch((e) => said(e, "not sent")); }}>Send to Dispatch</button>
        <button className="btn" title="Open it in Thinking and write it through yourself" onClick={() => { leave(); move(t, "thinking"); go({ mode: "focus", view: "thinking" }); }}>Think it through</button>
        <span className="grow" />
        <button className="btn quiet danger" onClick={() => { leave(); move(t, "dropped"); }}>Drop</button>
      </div>
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
      : <div className="row"><span title="Dispatch wakes Claude through it when you send a thread or press Go">Routine not connected ·</span><button className="link" onClick={() => setForm(!form)}>Connect</button></div>}
    {r.error ? <p className="err">{r.error}</p> : null}
    {form ? <form className="row" autoComplete="off" onSubmit={(e) => { e.preventDefault(); dash.routine({ url: url.trim(), token: token.trim() }).then(() => { setForm(false); toast("Routine connected."); }, (er) => said(er, "not saved")); }}>
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Fire URL: https://api.anthropic.com/v1/claude_code/routines/trig_…/fire" aria-label="Fire URL" />
      <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="API token, shown once when you make it" aria-label="API token" />
      <button className="btn small" type="submit">Save</button>
      {r.connected ? <button className="btn quiet small" type="button" onClick={() => { dash.routine({ url: null }).then(() => { setForm(false); toast("Routine disconnected."); }, (er) => said(er, "not saved")); }}>Disconnect</button> : null}
    </form> : null}
  </div>;
}

function Empty({ title, text, act }: { title: string; text: string; act?: [string, () => void] }) {
  return <div className="empty"><h4>{title}</h4><p>{text}</p>{act ? <button className="btn" onClick={act[1]}>{act[0]}</button> : null}</div>;
}
