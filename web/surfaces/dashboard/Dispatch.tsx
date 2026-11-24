import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash, useArchive, useDispatch, type DispatchThread, type DispatchVersion } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import LivePage from "../../capabilities/live/LivePage.tsx";
import { switches } from "../../capabilities/fold/switches.ts";
import type { View } from "./nav.ts";
import { age, hm } from "./parts.tsx";
import NewThread from "./NewThread.tsx";
import { initials } from "./initials.ts";

const latest = (t: DispatchThread): DispatchVersion | null => t.versions[t.versions.length - 1] ?? null;
const label = (v: DispatchVersion): string => `v${v.n}${v.landed === "review" ? " · built" : v.landed === "finish" || v.landed === "done" ? " · finish" : ""}`;
const notes = (n: number): string => (n ? `${n} note${n === 1 ? "" : "s"}` : "");

const typing = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
// versions opened this session: a version you haven't seen opens with its ask unfolded, once
const seen = new Set<string>();

/** The line above the sheet: whose page, which version, and what it answers. */
export function caption(t: DispatchThread, v: DispatchVersion): string {
  const prev = t.versions.find((x) => x.n === v.n - 1);
  const why = prev ? ` · after you sent v${prev.n}` : "";
  return `Claude's page · ${label(v)} · ${hm(v.at)}${why}${latest(t)?.n !== v.n ? " · an older version" : ""}`;
}

/** Dispatch: threads Claude answers with a page, read on the sheet with Strata's notes; Send, Later, To thinking and Drop on the card, Archive in Finish. */
export default function Dispatch({ view }: { view: Exclude<View, "triage" | "thinking" | "review"> }) {
  const pane = useDispatch();
  const stage = view === "built" ? "review" : view;
  const here = (pane?.threads ?? []).filter((t) => t.stage === stage).sort((a, b) => b.updatedAt - a.updatedAt);
  const [sel, setSel] = useState<{ thread: string; n: number | null } | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const t = here.find((x) => x.id === sel?.thread) ?? here[0] ?? null;
  const v = t ? (t.versions.find((x) => x.n === (sel?.thread === t.id ? sel.n : null)) ?? latest(t)) : null;
  useEffect(() => { setSel(null); }, [view]);
  // a thread arriving later sorts above the one on the sheet, so pin what is shown
  const pinned = here.some((x) => x.id === sel?.thread);
  useEffect(() => { if (!pinned && t) setSel({ thread: t.id, n: null }); }, [pinned, t?.id]);
  // the thread list is a drawer over the sheet: hover the rail a moment, or press [
  const [drawer, setDrawer] = useState(false);
  const hover = useRef<number | null>(null);
  const unhover = () => { if (hover.current !== null) { clearTimeout(hover.current); hover.current = null; } };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "[") { e.preventDefault(); setDrawer((d) => !d); } else if (e.key === "Escape") setDrawer(false);
    };
    addEventListener("keydown", key);
    return () => { removeEventListener("keydown", key); unhover(); };
  }, []);
  const [unfolded, setUnfolded] = useState<string | null>(null);
  useEffect(() => { if (v && !seen.has(v.resourceId)) { seen.add(v.resourceId); setUnfolded(v.resourceId); } }, [v?.resourceId]);
  const pick = (id: string, n: number | null = null) => { setSel({ thread: id, n }); setDrawer(false); };

  function press(th: DispatchThread, kind: "send" | "drop" | "archive" | "todo" | "thinking"): void {
    const rest = here.filter((x) => x.id !== th.id);
    setSel(rest[0] ? { thread: rest[0].id, n: null } : null);
    setReopening(null);
    if (kind === "drop") { toast("Dropped"); dash.end(th.id).catch((e) => toast(StrataWhy(e, "not dropped"), 4200)); return; }
    if (kind === "todo" || kind === "thinking") {
      toast(kind === "todo" ? "In to-do. Send it again when it matters." : "In Thinking. Send to Dispatch picks up from this page.");
      dash.aside(th.id, kind).catch((e) => toast(StrataWhy(e, "not moved"), 4200));
      return;
    }
    if (kind === "archive") { toast("Archived"); dash.end(th.id, "done").catch((e) => toast(StrataWhy(e, "not archived"), 4200)); return; }
    dash.press(th.id).catch((e) => toast(StrataWhy(e, "Send didn't reach Claude"), 4200));
  }

  const acts = (x: DispatchThread): ReactNode => stage !== "finish" ? <div className="acts">
      <button className="btn quiet" title="Back to to-do, pages kept" onClick={() => press(x, "todo")}>Later</button>
      <button className="btn quiet" title="Write more in Thinking, pages kept" onClick={() => press(x, "thinking")}>To thinking</button>
      <button className="btn quiet danger" onClick={() => press(x, "drop")}>Drop</button>
      <button className="btn dark" onClick={() => press(x, "send")}>Send</button>
    </div> : reopening === x.id ? <div className="acts reopen">
      <p>Write what's wrong as a note on the page, then Send.</p>
      <button className="btn quiet" onClick={() => setReopening(null)}>Cancel</button>
      <button className="btn dark" onClick={() => press(x, "send")}>Send</button>
    </div> : <div className="acts">
      <button className="faint" onClick={() => setReopening(x.id)}>Reopen</button>
      <button className="btn dark" onClick={() => press(x, "archive")}>Archive</button>
    </div>;

  const blank = !pane ? "Loading…"
    : !t ? (stage === "implementing" ? "Nothing with Claude right now." : stage === "review" ? "Nothing to review. Built pages come here."
      : stage === "finish" ? "Nothing to finish. Merged, filed or not-doing threads come here, with what to check." : "Nothing to decide. Send a thread from to-do in Triage.")
    : !v ? "Claude is preparing the first page. It shows up in Decide when it is ready."
    : null;

  return (
    <div className={"ws dispatch" + (drawer ? " drawer-open" : "")}>
      <div className="ws-nav" onMouseEnter={() => { unhover(); hover.current = window.setTimeout(() => setDrawer(true), 350); }}
        onMouseLeave={() => { unhover(); setDrawer(false); }}>
      <nav className="ws-rail" aria-label="Threads, as squares">
        {here.map((x) => <button key={x.id} className={"rail-sq" + (x.id === t?.id ? " on" : "") + (latest(x)?.notes ? " noted" : "")}
          title={x.title} aria-label={x.title} aria-current={x.id === t?.id ? "true" : undefined} onClick={() => pick(x.id)}>{initials(x.title)}</button>)}
        <button className="rail-sq new" title="Threads and a new one ( [ )" aria-label="Show the threads" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>☰</button>
      </nav>
      <aside className="ws-list" aria-label="Threads">
        {stage === "implementing" ? <Implementing threads={here} on={t?.id ?? null} onPick={(x) => pick(x.id)} />
          : here.map((x) => x.id === t?.id
            ? <section key={x.id} className="ws-card open" aria-label={x.title}>
                <span className="t">{x.title}</span>
                {x.links.length ? <span className="m">{x.links.map((l) => l.ref).join(" · ")}</span> : null}
                <ol className="vers" reversed>
                  {[...x.versions].reverse().map((ver) => <li key={ver.n}>
                    <button aria-current={v?.n === ver.n ? "true" : undefined} onClick={() => pick(x.id, ver.n)}><b>{label(ver)}</b><span>{notes(ver.notes)}</span></button>
                  </li>)}
                </ol>
                {acts(x)}
              </section>
            : <button key={x.id} className="ws-card" onClick={() => pick(x.id)}>
                <span className="t">{x.title}</span>
                <span className="m">{[latest(x) ? label(latest(x)!) : null, latest(x) ? notes(latest(x)!.notes) : null, latest(x) ? age(latest(x)!.at) : null].filter(Boolean).join(" · ")}</span>
              </button>)}
        {pane && !here.length ? <p className="ws-none">{blank}</p> : null}
        {stage === "finish" ? <Archived /> : null}
        <NewThread />
      </aside>
      </div>
      <div className="ws-room">
        {t && v ? <AskLine t={t} v={v} open={unfolded === v.resourceId} onToggle={() => setUnfolded(unfolded === v.resourceId ? null : v.resourceId)}>
          {stage !== "implementing" ? acts(t) : null}
        </AskLine> : null}
        <div className="ws-sheet" onMouseEnter={() => setUnfolded(null)}>
          {t && v && pane?.board ? <LivePage key={v.resourceId} board={pane.board} resource={v.resourceId} /> : null}
          {blank ? <div className="ws-blank"><p>{blank}</p></div> : null}
        </div>
      </div>
    </div>
  );
}

// The ask this version answers and how Claude read it, side by side so a misreading shows: one line, unfolded on a new version until you read the sheet.
function AskLine({ t, v, open, onToggle, children }: { t: DispatchThread; v: DispatchVersion; open: boolean; onToggle(): void; children: ReactNode }) {
  const older = latest(t)?.n !== v.n ? " · older" : "";
  const both = !!(v.ask && v.heard);
  return <div className={"ws-ask" + (open && both ? " open" : "")} aria-label="The ask">
    <button className={"ws-ask-text" + (both ? "" : " solo")} title={caption(t, v)} aria-expanded={both ? open && both : undefined} onClick={both ? onToggle : undefined}>
      {both ? <>
        <span className="ask"><span className="lab">Your ask</span><span className="p">{v.ask}</span></span>
        <span className="heard"><span className="lab">Claude heard · {label(v)}{older}</span><span className="p">{v.heard}</span></span>
      </> : <span className="ask"><span className="lab">{label(v)}{older}</span><span className="p">{caption(t, v)}</span></span>}
    </button>
    <div className="ws-ask-acts"><NotesSwitch />{children}</div>
  </div>;
}

// Strata's own notes layer: its count and its switch, set above the sheet.
function NotesSwitch() {
  const sw = useSyncExternalStore(switches.subscribe, switches.getSnapshot);
  return <button className={"notes-switch" + (sw.on.notes ? "" : " off")} aria-pressed={sw.on.notes} title={`${sw.on.notes ? "hide" : "show"} notes`}
    onClick={() => switches.flip("notes")}>{sw.count.notes ? <><i /><b>{sw.count.notes}</b> {sw.count.notes === 1 ? "note" : "notes"}</> : "No notes yet"}</button>;
}

// Where the page lands is Claude's call, so the card says only what was pressed and when.
function Implementing({ threads, on, onPick }: { threads: DispatchThread[]; on: string | null; onPick(t: DispatchThread): void }) {
  const pressed = (t: DispatchThread): string => !t.press ? "" : !t.press.version ? "Sent" : t.press.stage === "finish" ? "Reopened" : `Sent v${t.press.version}`;
  return <>{threads.map((t) => (
    <div key={t.id} className={"ws-card impl" + (t.id === on ? " on" : "")}>
      <button className="t" onClick={() => onPick(t)}>{t.title}</button>
      <span className="m">{t.press ? `${pressed(t)} · ${age(t.press.at)}` : ""}{t.versions.length ? "" : " · first page coming"}</span>
      {t.press?.sessionUrl ? <a className="session" href={t.press.sessionUrl} target="_blank" rel="noopener">Open the session ↗</a> : null}
    </div>
  ))}</>;
}

// Finish's fold: Dispatch threads archived or dropped, loaded only when opened.
function Archived() {
  const [open, setOpen] = useState(false);
  const list = (useArchive(open) ?? []).filter((t) => t.dispatched).slice(0, 40);
  return <>
    <button className="ws-fold" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide archived" : "Archived"}</button>
    {open ? list.map((x) => <div key={x.id} className="ws-done"><span>{x.title}</span><i>{x.stage === "dropped" ? "dropped" : "archived"}</i></div>) : null}
    {open && !list.length ? <p className="ws-none">Nothing archived yet.</p> : null}
  </>;
}
