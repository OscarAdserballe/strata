import { useEffect, useState, useSyncExternalStore } from "react";
import { store } from "../../data/store.ts";
import { DASH_KEY, DISPATCH_KEY, useDashBoard, useDispatch } from "../../data/entities/dashboard.ts";
import { subscribeToast, toastNow } from "../../shell/layers.ts";
import { go, useNav, type Mode, type View } from "./nav.ts";
import Triage from "./Triage.tsx";
import Thinking from "./Thinking.tsx";
import FocusReview from "./FocusReview.tsx";
import Dispatch from "./Dispatch.tsx";
import { hm } from "./parts.tsx";

// what waits on you carries an orange count; the rest is information
const WAITS: View[] = ["review", "decide", "built"];
const RAIL: Record<Mode, [View, string][]> = {
  focus: [["thinking", "Thinking"], ["review", "Review"]],
  dispatch: [["decide", "Decide"], ["implementing", "Implementing"], ["built", "Review"]],
};

export default function Dashboard() {
  const nav = useNav();
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
  const count = (v: View): string => {
    if (v === "thinking") return String(tasks.filter((t) => t.stage === "thinking" || (t.stage === "todo" && t.morningAt)).length || "");
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
        <button className={"dh-inbox" + (nav.view === "triage" && nav.sub === "inbox" ? " on" : "")} aria-pressed={nav.view === "triage" && nav.sub === "inbox"}
          onClick={() => go({ view: "triage", sub: "inbox" })}>
          Inbox <i>{inbox || ""}</i>
        </button>
      </div>
      <div className="dh-main">
      <span />
      <nav className="dh-rail" aria-label="Stages">
        {rail.map(([v, name], i) => <span key={v} className="dh-step">
          {i ? <b aria-hidden="true">›</b> : null}
          <button aria-current={nav.view === v ? "page" : undefined} onClick={() => go({ view: v })}>{name} <i className={WAITS.includes(v) ? "wait" : undefined}>{count(v)}</i></button>
        </span>)}
      </nav>
      <div className="dh-side end"><Clock /></div>
      </div>
    </header>
  );
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
