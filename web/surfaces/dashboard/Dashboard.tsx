import { useEffect, useState, useSyncExternalStore } from "react";
import { store } from "../../data/store.ts";
import { DASH_KEY, DISPATCH_KEY, useDashBoard, useDispatch } from "../../data/entities/dashboard.ts";
import { subscribeToast, toastNow } from "../../shell/layers.ts";
import { useDeploy } from "../../shell/session.ts";
import { go, useNav, type Mode, type View } from "./nav.ts";
import Triage from "./Triage.tsx";
import Thinking from "./Thinking.tsx";
import FocusReview from "./FocusReview.tsx";
import Dispatch from "./Dispatch.tsx";
import { hm } from "./parts.tsx";
import { loadWriter } from "../../capabilities/write/Writer.tsx";
import Pad from "../../capabilities/pad/Pad.tsx";

// No arrows between the tabs: Claude picks where a thread goes next, so they are places, not steps.
// what waits on you carries an orange count; the rest is information
const WAITS: View[] = ["review", "decide", "built", "finish"];
const RAIL: Record<Mode, [View, string][]> = {
  focus: [["thinking", "Thinking"], ["review", "Review"]],
  dispatch: [["decide", "Decide"], ["implementing", "With Claude"], ["built", "Review"], ["finish", "Finish"]],
};

export default function Dashboard() {
  const nav = useNav();
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 300));
    idle(() => { loadWriter().catch(() => {}); });
  }, []);
  return <>
    <Sky />
    <Poller />
    <div className="dash" data-mode={nav.mode} data-view={nav.view}>
      <Header />
      <main className="dash-main">
        {nav.view === "triage" ? <Triage mode={nav.mode} sub={nav.sub} />
          : nav.view === "thinking" ? <Thinking />
          : nav.view === "review" ? <FocusReview />
          : <Dispatch view={nav.view} />}
      </main>
    </div>
    <Pad />
    <Toast />
  </>;
}

// One calm sky under every view of both modes: the mode is said by the toggle, not the weather.
function Sky() {
  return <div className="dash-sky" aria-hidden="true"><i /></div>;
}

function Header() {
  const nav = useNav();
  const board = useDashBoard(), pane = useDispatch();
  const tasks = board?.tasks ?? [], threads = pane?.threads ?? [];
  const inbox = board?.inbox.length ?? 0;
  const todo = tasks.filter((t) => t.stage === "todo").length;
  const on = (sub: "inbox" | "todo") => nav.view === "triage" && nav.sub === sub;
  const count = (v: View): string => {
    if (v === "thinking") return String(tasks.filter((t) => t.stage === "thinking").length || "");
    if (v === "review") return String(tasks.filter((t) => t.stage === "review" && !t.dispatched).length || "");
    const n = threads.filter((t) => t.stage === (v === "built" ? "review" : v)).length;
    return !n ? "" : v === "implementing" ? `(${n})` : String(n);
  };
  const rail = RAIL[nav.mode];
  return (
    <header className="dh">
      <div className="dh-side">
        <div className="dh-modes" role="tablist" aria-label="Mode">
          {(["focus", "dispatch"] as Mode[]).map((m) => <button key={m} role="tab" aria-selected={nav.mode === m} onClick={() => go({ mode: m })}>
            {m === "focus" ? "Focus" : "Dispatch"}</button>)}
        </div>
        <button className={"dh-inbox" + (on("inbox") ? " on" : "")} aria-pressed={on("inbox")}
          onClick={() => go({ view: "triage", sub: "inbox" })}>
          Inbox <i>{inbox || ""}</i>
        </button>
        <button className={"dh-inbox dh-todo" + (on("todo") ? " on" : "")} aria-pressed={on("todo")}
          onClick={() => go({ view: "triage", sub: "todo" })}>
          To-do <i>{todo || ""}</i>
        </button>
      </div>
      <div className="dh-main">
      <span />
      <nav className="dh-rail" aria-label="Stages">
        {rail.map(([v, name]) => <span key={v} className="dh-step">
          <button aria-current={nav.view === v ? "page" : undefined} onClick={() => go({ view: v })}>{name} <i className={WAITS.includes(v) ? "wait" : undefined}>{count(v)}</i></button>
        </span>)}
      </nav>
      <div className="dh-side end"><Deploy /><Clock /></div>
      </div>
    </header>
  );
}

// The same dot and line as the room's top bar, for an admin; nothing for anyone else.
function Deploy() {
  const deploy = useDeploy();
  const [open, setOpen] = useState(false);
  if (!deploy) return null;
  return <span className="dh-deploy-wrap">
    <button className={"dh-deploy " + deploy.level} aria-label={"Deploy: " + deploy.line} title={"Deploy: " + deploy.line}
      aria-expanded={open} onClick={() => setOpen((v) => !v)} />
    {open ? <span className={"dh-deploy-line " + deploy.level} role="status"><b>Deploy</b>{deploy.line}</span> : null}
  </span>;
}

// The minute changes on its own clock, so only this re-renders.
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const h = window.setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(h); }, []);
  return <span className="dh-clock">{hm(now.getTime())} · {now.toLocaleDateString([], { weekday: "long" })}</span>;
}

// Reads again every 20 s while something moves, backing off to two minutes when nothing has; never while hidden.
function Poller() {
  const pane = useDispatch();
  const busy = !!pane?.threads.some((t) => t.stage === "implementing");
  useEffect(() => {
    let idle = 0, timer = 0;
    const look = async () => {
      if (document.hidden) return;
      const was = [store.get(DASH_KEY), store.get(DISPATCH_KEY)];
      await Promise.all([store.refetch(DASH_KEY), store.refetch(DISPATCH_KEY)]).catch(() => {});
      idle = store.get(DASH_KEY) === was[0] && store.get(DISPATCH_KEY) === was[1] ? idle + 1 : 0;
    };
    const tick = () => { timer = window.setTimeout(() => { void look().finally(tick); }, busy && idle < 8 ? 15_000 : idle > 6 ? 120_000 : 20_000); };
    tick();
    const back = () => { if (!document.hidden) { idle = 0; void look(); } };
    document.addEventListener("visibilitychange", back);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", back); };
  }, [busy]);
  return null;
}

function Toast() {
  const said = useSyncExternalStore(subscribeToast, toastNow, () => "");
  return said ? <div className="dash-toast" role="status">{said}</div> : null;
}
