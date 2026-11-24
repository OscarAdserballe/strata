import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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

// which version of each thread this device has shown, so a new one opens with its ask unfolded and the rail can mark it
const SEEN = "dispatch-seen";
function readSeen(): Record<string, number> {
  try { const v = JSON.parse(localStorage.getItem(SEEN) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}
function writeSeen(v: Record<string, number>): void { try { localStorage.setItem(SEEN, JSON.stringify(v)); } catch { /* private mode: seen lasts the visit */ } }
const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false])");

type Press = "send" | "drop" | "archive" | "todo" | "thinking";

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
  // on a phone the sheet fits a short page; on a desktop it always fills the room down to the bottom
  const [tall, setTall] = useState<{ rid: string; h: number } | null>(null);
  const fit = v && tall?.rid === v.resourceId ? Math.max(tall.h, 240) : null;

  // the ask opens unfolded on a version not shown here before, and folds once the reader scrolls the page
  const [seen, setSeen] = useState(readSeen);
  const [asked, setAsked] = useState<{ rid: string; open: boolean } | null>(null);
  useEffect(() => {
    if (!t || !v) return;
    const had = readSeen(), fresh = (had[t.id] ?? 0) < v.n;
    setAsked({ rid: v.resourceId, open: fresh });
    if (fresh) { const next = { ...had, [t.id]: v.n }; writeSeen(next); setSeen(next); }
  }, [v?.resourceId]);
  const unfolded = !!v && asked?.rid === v.resourceId && asked.open;
  const waits = (x: DispatchThread): boolean => stage !== "implementing" && (latest(x)?.n ?? 0) > (seen[x.id] ?? 0);

  function press(th: DispatchThread, kind: Press): void {
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

  const blank = !pane ? "Loading…"
    : !t ? (stage === "implementing" ? "Nothing with Claude right now." : stage === "review" ? "Nothing to review. Built pages come here."
      : stage === "finish" ? "Nothing to finish. Merged, filed or not-doing threads come here, with what to check." : "Nothing to decide. Send a thread from to-do in Triage.")
    : !v ? "Claude is preparing the first page. It shows up in Decide when it is ready."
    : null;
  const acts = (x: DispatchThread) => <Acts stage={stage} reopening={reopening === x.id} onPress={(k) => press(x, k)} onReopen={(on) => setReopening(on ? x.id : null)} />;

  return (
    <div className="ws dispatch">
      <Side threads={here} on={t?.id ?? null} waits={waits} onPick={(x) => setSel({ thread: x.id, n: null })}>
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
                  {acts(x)}
                </section>
              : <button key={x.id} className="ws-card" onClick={() => setSel({ thread: x.id, n: null })}>
                  <span className="t">{x.title}</span>
                  <span className="m">{[latest(x) ? label(latest(x)!) : null, latest(x) ? notes(latest(x)!.notes) : null, latest(x) ? age(latest(x)!.at) : null].filter(Boolean).join(" · ")}</span>
                </button>)}
          {pane && !here.length ? <p className="ws-none">{blank}</p> : null}
          {stage === "finish" ? <Archived /> : null}
          <NewThread />
        </aside>
      </Side>
      <div className="ws-room">
        <div className="ws-caption"><span>{t && v ? caption(t, v) : ""}</span>{t && v ? <NotesSwitch /> : null}</div>
        {t && v ? <div className="ws-askline">
          {v.ask && v.heard
            ? <button className="said" aria-expanded={unfolded} title={unfolded ? "Fold the ask" : "Unfold the ask"} onClick={() => setAsked({ rid: v.resourceId, open: !unfolded })}>
                <i className="when">{label(v)} · {hm(v.at)}</i>
                <span className="lab">Your ask</span><span className="txt">{v.ask}</span>
                <span className="lab heard">Heard</span><span className="txt">{v.heard}</span>
                <span className="chev" aria-hidden="true" />
              </button>
            : <span className="said plain"><i className="when">{caption(t, v)}</i></span>}
          <NotesSwitch />
          {stage !== "implementing" ? acts(t) : null}
        </div> : null}
        {v?.ask && v.heard ? <Asked v={v} folded={!unfolded} /> : null}
        <div className={"ws-sheet" + (fit ? " fits" : "")} style={fit ? ({ "--fit": `${fit}px` } as React.CSSProperties) : undefined}>
          {t && v && pane?.board ? <LivePage key={v.resourceId} board={pane.board} resource={v.resourceId}
            onHeight={(h) => setTall((was) => (was?.rid === v.resourceId && was.h === h ? was : { rid: v.resourceId, h }))}
            onScrolled={() => setAsked((was) => (was?.rid === v.resourceId && was.open ? { ...was, open: false } : was))} /> : null}
          {blank ? <div className="ws-blank"><p>{blank}</p></div> : null}
        </div>
      </div>
    </div>
  );
}

// A thread's buttons, the same on its card in the drawer and on the line above the page.
function Acts({ stage, reopening, onPress, onReopen }: { stage: string; reopening: boolean; onPress(k: Press): void; onReopen(on: boolean): void }) {
  if (stage === "implementing") return null;
  if (stage !== "finish") return <div className="acts">
    <button className="btn dark" onClick={() => onPress("send")}>Send</button>
    <button className="btn quiet" title="Back to to-do, pages kept" onClick={() => onPress("todo")}>Later</button>
    <button className="btn quiet" title="Write more in Thinking, pages kept" onClick={() => onPress("thinking")}>To thinking</button>
    <button className="btn quiet danger" onClick={() => onPress("drop")}>Drop</button>
  </div>;
  if (reopening) return <div className="acts reopen">
    <p>Write what's wrong as a note on the page, then Send.</p>
    <button className="btn dark" onClick={() => onPress("send")}>Send</button>
    <button className="btn quiet" onClick={() => onReopen(false)}>Cancel</button>
  </div>;
  return <div className="acts">
    <button className="btn dark" onClick={() => onPress("archive")}>Archive</button>
    <button className="faint" onClick={() => onReopen(true)}>Reopen</button>
  </div>;
}

// The 44px rail: a letter per thread, a dot on one with a version not shown here yet. Hovering it, or [, slides the full list over the page.
function Side({ threads, on, waits, onPick, children }: { threads: DispatchThread[]; on: string | null; waits(t: DispatchThread): boolean; onPick(t: DispatchThread): void; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key === "[") { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === "Escape") setOpen(false);
    };
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener("keydown", key);
    addEventListener("pointerdown", away);
    return () => { removeEventListener("keydown", key); removeEventListener("pointerdown", away); };
  }, []);
  return <div ref={ref} className={"ws-side" + (open ? " open" : "")}>
    <nav className="ws-rail" aria-label="Threads, by letter">
      {threads.map((x) => <button key={x.id} title={x.title} aria-label={x.title} aria-current={x.id === on ? "true" : undefined} onClick={() => onPick(x)}>
        {(x.title.match(/[\p{L}\p{N}]/u)?.[0] ?? "·").toUpperCase()}{waits(x) ? <i className="dot" aria-label="new version" /> : null}
      </button>)}
      <button className="plus" title="New thread (N)" aria-label="New thread"
        onClick={() => { setOpen(true); ref.current?.querySelector<HTMLButtonElement>(".ws-new-row")?.click(); }}>+</button>
    </nav>
    {children}
  </div>;
}

// The ask this version answers and how Claude read it, the same size side by side, so a misreading shows.
function Asked({ v, folded }: { v: DispatchVersion; folded: boolean }) {
  return <div className={"ws-asked" + (folded ? " folded" : "")} aria-label="The ask">
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
