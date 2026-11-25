import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash, useDispatch, type DispatchThread, type DispatchVersion } from "../../data/entities/dashboard.ts";
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

/** Dispatch: threads Claude answers with a page, read on a sheet that takes the room; the threads are a rail that opens into a drawer, and Send and the rest sit on one line above the page. */
export default function Dispatch({ view }: { view: Exclude<View, "triage" | "thinking" | "review" | "archive"> }) {
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
  const [drawer, setDrawer] = useState(false);
  const [kept, setKept] = useState(readKept);
  const keep = (on: boolean) => { setKept(on); setDrawer(false); try { localStorage.setItem(KEPT, on ? "1" : "0"); } catch {} };
  const pick = (x: DispatchThread, n: number | null = null) => { setSel({ thread: x.id, n }); setDrawer(false); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "[") { e.preventDefault(); keep(!kept); } else if (e.key === "Escape") setDrawer(false);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [kept]);

  function press(th: DispatchThread, kind: "send" | "drop" | "archive" | "todo" | "thinking"): void {
    const rest = here.filter((x) => x.id !== th.id);
    setSel(rest[0] ? { thread: rest[0].id, n: null } : null);
    setReopening(null);
    setDrawer(false);
    if (kind === "drop") { toast("Dropped"); dash.end(th.id).catch((e) => toast(StrataWhy(e, "not dropped"), 4200)); return; }
    if (kind === "todo" || kind === "thinking") {
      toast(kind === "todo" ? "In to-do. Send it again when it matters." : "In Thinking. Send to Dispatch picks up from this page.");
      dash.aside(th.id, kind).catch((e) => toast(StrataWhy(e, "not moved"), 4200));
      return;
    }
    if (kind === "archive") { toast("Archived"); dash.end(th.id, "done").catch((e) => toast(StrataWhy(e, "not archived"), 4200)); return; }
    dash.press(th.id).catch((e) => toast(StrataWhy(e, "Send didn't reach Claude"), 4200));
  }

  const blank = !pane ? "Loading…"
    : !t ? (stage === "implementing" ? "Nothing with Claude right now." : stage === "review" ? "Nothing to review. Built pages come here."
      : stage === "finish" ? "Nothing to finish. Merged, filed or not-doing threads come here, with what to check." : "Nothing to decide. Send a thread from to-do in Triage.")
    : !v ? "Claude is preparing the first page. It shows up in Decide when it is ready."
    : null;

  const acts = !t ? null : stage === "implementing" ? (t.press?.sessionUrl ? <a className="session" href={t.press.sessionUrl} target="_blank" rel="noopener">Open the session ↗</a> : null)
    : stage !== "finish" ? <>
        <button className="btn dark" onClick={() => press(t, "send")}>Send</button>
        <button className="btn quiet" title="Back to to-do, pages kept" onClick={() => press(t, "todo")}>Later</button>
        <button className="btn quiet" title="Write more in Thinking, pages kept" onClick={() => press(t, "thinking")}>To thinking</button>
        <button className="btn quiet danger" onClick={() => press(t, "drop")}>Drop</button>
      </>
    : reopening === t.id ? <>
        <span className="hint">Write what's wrong as a note on the page, then Send.</span>
        <button className="btn dark" onClick={() => press(t, "send")}>Send</button>
        <button className="btn quiet" onClick={() => setReopening(null)}>Cancel</button>
      </>
    : <>
        <button className="btn dark" onClick={() => press(t, "archive")}>Archive</button>
        <button className="btn quiet" onClick={() => setReopening(t.id)}>Reopen</button>
      </>;

  return (
    <div className="ws dispatch railed" data-drawer={drawer ? "open" : undefined} data-kept={kept ? "" : undefined}>
      <div className="ws-side">
      <nav className="ws-rail" aria-label="Threads" onMouseEnter={() => setDrawer(true)} onClick={(e) => { if (e.target === e.currentTarget) keep(true); }}>
        <button className="ws-pip keep" title="Keep the list open ([)" onClick={() => keep(true)}>»</button>
        {here.map((x) => <button key={x.id} className="ws-pip" aria-current={x.id === t?.id ? "true" : undefined} title={x.title} onClick={() => pick(x)}>{initial(x.title)}</button>)}
        <button className="ws-pip add" title="New thread (N)" onClick={() => setDrawer(true)}>+</button>
      </nav>
      <aside className="ws-list" aria-label="Thread list" onMouseLeave={() => setDrawer(false)}>
        <button className="ws-keep" aria-pressed={kept} title={kept ? "Fold the list to a rail ([)" : "Keep the list open ([)"} onClick={() => keep(!kept)}>{kept ? "« Fold" : "Keep open »"}</button>
        {stage === "implementing" ? <Implementing threads={here} on={t?.id ?? null} onPick={(x) => pick(x)} />
          : here.map((x) => x.id === t?.id
            ? <section key={x.id} className="ws-card open" aria-label={x.title}>
                <span className="t">{x.title}</span>
                {x.links.length ? <span className="m">{x.links.map((l) => l.ref).join(" · ")}</span> : null}
                <ol className="vers" reversed>
                  {[...x.versions].reverse().map((ver) => <li key={ver.n}>
                    <button aria-current={v?.n === ver.n ? "true" : undefined} onClick={() => pick(x, ver.n)}><b>{label(ver)}</b><span>{notes(ver.notes)}</span></button>
                  </li>)}
                </ol>
              </section>
            : <button key={x.id} className="ws-card" onClick={() => pick(x)}>
                <span className="t">{x.title}</span>
                <span className="m">{[latest(x) ? label(latest(x)!) : null, latest(x) ? notes(latest(x)!.notes) : null, latest(x) ? age(latest(x)!.at) : null].filter(Boolean).join(" · ")}</span>
              </button>)}
        {pane && !here.length ? <p className="ws-none">{blank}</p> : null}
        <NewThread />
      </aside>
      </div>
      <div className="ws-room">
        {t ? <Bar t={t} v={v} acts={acts} /> : null}
        <div className="ws-sheet">
          {t && v && pane?.board ? <LivePage key={v.resourceId} board={pane.board} resource={v.resourceId} /> : null}
          {blank ? <div className="ws-blank"><p>{blank}</p></div> : null}
        </div>
      </div>
    </div>
  );
}

const KEPT = "strata.dispatchList";
const readKept = (): boolean => { try { return localStorage.getItem(KEPT) === "1"; } catch { return false; } };
const initial = (title: string): string => (title.match(/[A-Za-z0-9]/)?.[0] ?? "·").toUpperCase();
const typing = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");
// versions already read in this tab; a version not yet read opens with its ask unfolded, so a misreading shows first
const seen = new Set<string>();

// One line over the page: which version, the ask and how Claude read it (click to unfold), the notes switch and the buttons.
function Bar({ t, v, acts }: { t: DispatchThread; v: DispatchVersion | null; acts: ReactNode }) {
  const [fold, setFold] = useState<{ rid: string; open: boolean } | null>(null);
  const rid = v?.resourceId ?? "";
  const open = !!v?.ask && !!v.heard && (fold?.rid === rid ? fold.open : !seen.has(rid));
  useEffect(() => { if (rid) return () => { seen.add(rid); }; }, [rid]);
  return <>
    <div className="ws-bar">
      <span className="ver" title={v ? caption(t, v) : t.title}>{v ? `${label(v)} · ${hm(v.at)}` : "No page yet"}</span>
      {v?.ask && v.heard
        ? <button className="ask" aria-expanded={open} title={open ? "Fold the ask" : "Unfold the ask"} onClick={() => setFold({ rid, open: !open })}>
            <span><i>Your ask</i>{v.ask}</span><span className="heard"><i>Heard</i>{v.heard}</span>
          </button>
        : <span className="ask plain">{t.title}</span>}
      {v ? <NotesSwitch /> : null}
      <span className="acts">{acts}</span>
    </div>
    {open && v ? <Asked v={v} /> : null}
  </>;
}

// The ask this version answers and how Claude read it, the same size side by side, so a misreading shows.
function Asked({ v }: { v: DispatchVersion }) {
  return <div className="ws-asked" aria-label="The ask">
    <div><span className="lab">Your ask</span><p>{v.ask}</p></div>
    <div className="heard"><span className="lab">Claude heard · v{v.n}</span><p>{v.heard}</p></div>
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
