import { useEffect, useState, useSyncExternalStore } from "react";
import { StrataWhy } from "../../data/api.ts";
import { dash, useDispatch, type DispatchThread, type DispatchVersion } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import LivePage from "../../capabilities/live/LivePage.tsx";
import { switches } from "../../capabilities/fold/switches.ts";
import type { View } from "./nav.ts";
import { age, hm } from "./parts.tsx";

const STOP: Record<string, string> = { decide: "Decide", review: "Review", done: "Done" };
const latest = (t: DispatchThread): DispatchVersion | null => t.versions[t.versions.length - 1] ?? null;
const label = (v: DispatchVersion): string => `v${v.n}${v.landed === "review" ? " · built" : ""}`;
const notes = (n: number): string => (n ? `${n} note${n === 1 ? "" : "s"}` : "");

/** The line above the sheet: whose page, which version, and what it answers. */
export function caption(t: DispatchThread, v: DispatchVersion): string {
  const prev = t.versions.find((x) => x.n === v.n - 1);
  const why = !prev ? "" : v.landed === "review" && prev.landed === "decide" ? ` · after you said Go on v${prev.n}` : ` · after you sent v${prev.n} back`;
  return `Claude's page · ${label(v)} · ${hm(v.at)}${why}${latest(t)?.n !== v.n ? " · an older version" : ""}`;
}

/** Dispatch: threads Claude answers with a page, read on the sheet with Strata's notes; Go and Send back on the card. */
export default function Dispatch({ view }: { view: Exclude<View, "triage" | "thinking" | "review"> }) {
  const pane = useDispatch();
  const stage = view === "built" ? "review" : view;
  // Implementing lists what is being built before what is still being written, so its order is that too
  const here = (pane?.threads ?? []).filter((t) => t.stage === stage)
    .sort((a, b) => (stage === "implementing" ? Number(a.lands === "decide") - Number(b.lands === "decide") : 0) || b.updatedAt - a.updatedAt);
  const [sel, setSel] = useState<{ thread: string; n: number | null } | null>(null);
  const t = here.find((x) => x.id === sel?.thread) ?? here[0] ?? null;
  const v = t ? (t.versions.find((x) => x.n === (sel?.thread === t.id ? sel.n : null)) ?? latest(t)) : null;
  useEffect(() => { setSel(null); }, [view]);

  function press(th: DispatchThread, kind: "go" | "back"): void {
    const rest = here.filter((x) => x.id !== th.id);
    setSel(rest[0] ? { thread: rest[0].id, n: null } : null);
    dash.press(th.id, kind).catch((e) => toast(StrataWhy(e, kind === "go" ? "Go didn't reach Claude" : "Send back didn't reach Claude"), 4200));
  }

  const blank = !pane ? "Loading…"
    : !t ? (stage === "implementing" ? "Nothing with Claude right now." : stage === "review" ? "Nothing to review. Built pages come here." : "Nothing to decide. Send a thread from the backlog in Inbox.")
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
                <div className="acts">
                  <button className={"btn dark" + (stage === "review" ? " merge" : "")} onClick={() => press(x, "go")}>{stage === "review" ? "Go → merge" : "Go →"}</button>
                  <button className="btn" onClick={() => press(x, "back")}>Send back</button>
                </div>
              </section>
            : <button key={x.id} className="ws-card" onClick={() => setSel({ thread: x.id, n: null })}>
                <span className="t">{x.title}</span><span className="m">{latest(x) ? label(latest(x)!) : ""}</span>
              </button>)}
        {pane && !here.length ? <p className="ws-none">{blank}</p> : null}
      </aside>
      <div className="ws-room">
        <div className="ws-caption"><span>{t && v ? caption(t, v) : ""}</span>{t && v ? <NotesSwitch /> : null}</div>
        <div className="ws-sheet">
          {t && v && pane?.board ? <LivePage key={v.resourceId} board={pane.board} resource={v.resourceId} /> : null}
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
    onClick={() => switches.flip("notes")}><i />notes <b>{sw.count.notes}</b></button>;
}

function Implementing({ threads, on, onPick }: { threads: DispatchThread[]; on: string | null; onPick(t: DispatchThread): void }) {
  const building = threads.filter((t) => t.lands !== "decide"), preparing = threads.filter((t) => t.lands === "decide");
  const row = (t: DispatchThread) => (
    <div key={t.id} className={"ws-card impl" + (t.id === on ? " on" : "")}>
      <button className="t" onClick={() => onPick(t)}>{t.title}</button>
      <span className="m">
        {t.press ? `${t.press.kind === "send" ? "sent" : t.press.kind === "go" ? "Go" : "sent back"} ${age(t.press.at)} ago · ` : ""}next stop {STOP[t.lands ?? "decide"]}
      </span>
      {t.press?.sessionUrl ? <a className="session" href={t.press.sessionUrl} target="_blank" rel="noopener">session ↗</a> : null}
    </div>
  );
  return <>
    {building.length ? <h3 className="ws-group">Building · {building.length}</h3> : null}
    {building.map(row)}
    {preparing.length ? <h3 className="ws-group">Preparing a page · {preparing.length}</h3> : null}
    {preparing.map(row)}
  </>;
}
