import { useEffect, useState, useSyncExternalStore } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash, useArchive, useDispatch, type DispatchThread, type DispatchVersion } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import LivePage from "../../capabilities/live/LivePage.tsx";
import { switches } from "../../capabilities/fold/switches.ts";
import type { View } from "./nav.ts";
import { age, hm } from "./parts.tsx";
import NewThread from "./NewThread.tsx";

const latest = (t: DispatchThread): DispatchVersion | null => t.versions[t.versions.length - 1] ?? null;
const label = (v: DispatchVersion): string => `v${v.n}${v.landed === "review" ? " · built" : v.landed === "finish" || v.landed === "done" ? " · finish" : ""}`;
const notes = (n: number): string => (n ? `${n} note${n === 1 ? "" : "s"}` : "");

/** The line above the sheet: whose page, which version, and what it answers. */
export function caption(t: DispatchThread, v: DispatchVersion): string {
  const prev = t.versions.find((x) => x.n === v.n - 1);
  const why = prev ? ` · after you sent v${prev.n}` : "";
  return `Claude's page · ${label(v)} · ${hm(v.at)}${why}${latest(t)?.n !== v.n ? " · an older version" : ""}`;
}

/** Dispatch: threads Claude answers with a page, read on the sheet with Strata's notes; Send and Drop on the card, Archive in Finish. */
export default function Dispatch({ view }: { view: Exclude<View, "triage" | "thinking" | "review"> }) {
  const pane = useDispatch();
  const stage = view === "built" ? "review" : view;
  const here = (pane?.threads ?? []).filter((t) => t.stage === stage).sort((a, b) => b.updatedAt - a.updatedAt);
  const [sel, setSel] = useState<{ thread: string; n: number | null } | null>(null);
  const [reopening, setReopening] = useState<string | null>(null);
  const t = here.find((x) => x.id === sel?.thread) ?? here[0] ?? null;
  const v = t ? (t.versions.find((x) => x.n === (sel?.thread === t.id ? sel.n : null)) ?? latest(t)) : null;
  useEffect(() => { setSel(null); }, [view]);
  // pin what's on the sheet, so a thread or version arriving later doesn't take it over
  useEffect(() => { if (t && v && (sel?.thread !== t.id || sel.n !== v.n)) setSel({ thread: t.id, n: v.n }); }, [t?.id, v?.n, sel]);
  // the sheet fits a short page; a long one fills the room and scrolls in its frame
  const [tall, setTall] = useState<{ rid: string; h: number } | null>(null);
  const fit = v && tall?.rid === v.resourceId ? Math.max(tall.h, 240) : null;

  function press(th: DispatchThread, kind: "send" | "drop" | "archive"): void {
    const rest = here.filter((x) => x.id !== th.id);
    setSel(rest[0] ? { thread: rest[0].id, n: null } : null);
    setReopening(null);
    if (kind === "drop") { toast("Dropped"); dash.end(th.id).catch((e) => toast(StrataWhy(e, "not dropped"), 4200)); return; }
    if (kind === "archive") { toast("Archived"); dash.end(th.id, "done").catch((e) => toast(StrataWhy(e, "not archived"), 4200)); return; }
    dash.press(th.id).catch((e) => toast(StrataWhy(e, "Send didn't reach Claude"), 4200));
  }

  const blank = !pane ? "Loading…"
    : !t ? (stage === "implementing" ? "Nothing with Claude right now." : stage === "review" ? "Nothing to review. Built pages come here."
      : stage === "finish" ? "Nothing to finish. Merged, filed or not-doing threads come here, with what to check." : "Nothing to decide. Send a thread from to-do in Triage.")
    : !v ? "Claude is preparing the first page. It shows up in Decide when it is ready."
    : null;

  return (
    <div className="ws dispatch">
      <aside className="ws-list" aria-label="Threads">
        {stage === "implementing" ? <Implementing threads={here} on={t?.id ?? null} onPick={(x) => setSel({ thread: x.id, n: null })} />
          : here.map((x) => x.id === t?.id
            ? <section key={x.id} className="ws-card open" aria-label={x.title}>
                <span className="t">{x.title}</span>
                {x.links.length ? <span className="m">{x.links.map((l) => l.ref).join(" · ")}</span> : null}
                <ol className="vers" reversed>
                  {[...x.versions].reverse().map((ver) => <li key={ver.n}>
                    <button aria-current={v?.n === ver.n ? "true" : undefined} onClick={() => setSel({ thread: x.id, n: ver.n })}><b>{label(ver)}</b><span>{notes(ver.notes)}</span></button>
                  </li>)}
                </ol>
                {stage !== "finish" ? <div className="acts">
                  <button className="btn dark" onClick={() => press(x, "send")}>Send</button>
                  <button className="btn quiet danger" onClick={() => press(x, "drop")}>Drop</button>
                </div> : reopening === x.id ? <div className="acts reopen">
                  <p>Write what's wrong as a note on the page, then Send.</p>
                  <button className="btn dark" onClick={() => press(x, "send")}>Send</button>
                  <button className="btn quiet" onClick={() => setReopening(null)}>Cancel</button>
                </div> : <div className="acts">
                  <button className="btn dark" onClick={() => press(x, "archive")}>Archive</button>
                  <button className="faint" onClick={() => setReopening(x.id)}>Reopen</button>
                </div>}
              </section>
            : <button key={x.id} className="ws-card" onClick={() => setSel({ thread: x.id, n: null })}>
                <span className="t">{x.title}</span>
                <span className="m">{[latest(x) ? label(latest(x)!) : null, latest(x) ? notes(latest(x)!.notes) : null, latest(x) ? age(latest(x)!.at) : null].filter(Boolean).join(" · ")}</span>
              </button>)}
        {pane && !here.length ? <p className="ws-none">{blank}</p> : null}
        {stage === "finish" ? <Archived /> : null}
        <NewThread />
      </aside>
      <div className="ws-room">
        <div className="ws-caption"><span>{t && v ? caption(t, v) : ""}</span>{t && v ? <NotesSwitch /> : null}</div>
        <div className="ws-sheet" style={fit ? { flex: `0 1 ${fit}px` } : undefined}>
          {t && v && pane?.board ? <LivePage key={v.resourceId} board={pane.board} resource={v.resourceId}
            onHeight={(h) => setTall((was) => (was?.rid === v.resourceId && was.h === h ? was : { rid: v.resourceId, h }))} /> : null}
          {blank ? <div className="ws-blank"><p>{blank}</p></div> : null}
        </div>
      </div>
    </div>
  );
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
