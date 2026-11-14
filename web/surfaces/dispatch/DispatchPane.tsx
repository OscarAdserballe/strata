import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { StrataPath, StrataWhy } from "../../data/api.ts";
import { store } from "../../data/store.ts";
import { DISPATCH_KEY, dispatch, useDispatch, type DispatchThread, type DispatchVersion } from "../../data/entities/dispatch.ts";
import { room } from "../../shell/room.ts";
import { toast } from "../../shell/layers.ts";
import { switches } from "../../capabilities/fold/switches.ts";

type Tab = "decide" | "implementing" | "review";
const TABS: [Tab, string][] = [["decide", "Decide"], ["implementing", "Implementing"], ["review", "Review"]];
const STOP: Record<string, string> = { decide: "Decide", review: "Review", done: "Done" };

const latest = (t: DispatchThread): DispatchVersion | null => t.versions[t.versions.length - 1] ?? null;
const versionLabel = (v: DispatchVersion): string => `v${v.n}${v.landed === "review" ? " · built" : ""}`;
const notesLabel = (n: number): string => (n ? `${n} note${n === 1 ? "" : "s"}` : "");
function ago(at: number): string {
  const m = Math.max(1, Math.round((Date.now() - at) / 60000));
  return m < 60 ? `${m} min` : m < 60 * 24 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}
const hm = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** The line above the sheet: whose page, which version, and what it answers. */
export function caption(t: DispatchThread, v: DispatchVersion): string {
  const prev = t.versions.find((x) => x.n === v.n - 1);
  const why = !prev ? "" : v.landed === "review" && prev.landed === "decide" ? ` · after you said Go on v${prev.n}` : ` · after you sent v${prev.n} back`;
  const older = latest(t)?.n !== v.n ? " · an older version" : "";
  return `Claude's page · ${versionLabel(v)} · ${hm(v.at)}${why}${older}`;
}
/** The resource the address bar names, so a reload lands on the same version. */
const urlResource = (): string | null => new URLSearchParams(location.search).get("resource");

// Polls the pane while it is shown: quickly while Claude holds a thread, backing off to two minutes when nothing moves.
function usePanePoll(busy: boolean): void {
  useEffect(() => {
    let idle = 0, timer = 0;
    const tick = () => {
      timer = window.setTimeout(async () => {
        if (!document.hidden) {
          const was = store.get(DISPATCH_KEY);
          await store.refetch(DISPATCH_KEY).catch(() => {});
          idle = store.get(DISPATCH_KEY) === was ? idle + 1 : 0;
        }
        tick();
      }, busy && idle < 8 ? 15_000 : Math.min(120_000, 30_000 * 2 ** Math.min(2, idle)));
    };
    tick();
    const back = () => { if (!document.hidden) { idle = 0; void store.refetch(DISPATCH_KEY).catch(() => {}); } };
    document.addEventListener("visibilitychange", back);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", back); };
  }, [busy]);
}

// The minute changes on its own clock, so only this re-renders.
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const h = window.setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(h); }, []);
  return <span className="dp-clock">{hm(now.getTime())} · {now.toLocaleDateString([], { weekday: "long" })}</span>;
}

// Strata's own notes layer, its count and its switch, set above the sheet instead of in a reader bar.
function NotesChip() {
  const sw = useSyncExternalStore(switches.subscribe, switches.getSnapshot);
  return <button type="button" className={"dp-notes" + (sw.on.notes ? "" : " off")} aria-pressed={sw.on.notes}
    title={`${sw.on.notes ? "hide" : "show"} notes`} onClick={() => switches.flip("notes")}><i />notes <b>{sw.count.notes}</b></button>;
}

/** The whole Dispatch screen around the room's reader, which arrives as children and is never re-rendered by it. */
export default function DispatchPane({ children }: { children: ReactNode }) {
  const pane = useDispatch();
  const threads = pane?.threads ?? [];
  const [tab, setTab] = useState<Tab | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState<{ thread: string; n: number } | null>(null);
  const booted = useRef(false);
  usePanePoll(threads.some((t) => t.stage === "implementing"));

  // Implementing lists what is being built before what is still being written, so its order is that too.
  const of = (s: Tab) => threads.filter((t) => t.stage === s)
    .sort((a, b) => (s === "implementing" ? Number(a.lands === "decide") - Number(b.lands === "decide") : 0) || b.updatedAt - a.updatedAt);
  const here = tab ? of(tab) : [];
  const open = here.find((t) => t.id === openId) ?? null;

  function show(t: DispatchThread, v: DispatchVersion | null): void {
    setShown(v ? { thread: t.id, n: v.n } : null);
    if (v && pane?.board) void room.openBoard(pane.board, v.resourceId);
  }
  function pick(t: DispatchThread, s: Tab = t.stage as Tab): void {
    setTab(s); setOpenId(t.id); show(t, latest(t));
  }
  function choose(s: Tab): void {
    setTab(s);
    const first = of(s)[0];
    if (first) pick(first, s); else { setOpenId(null); setShown(null); }
  }

  // First answer: the version the address bar names, else the first thread waiting on you.
  useEffect(() => {
    if (!pane || booted.current) return;
    booted.current = true;
    const rid = urlResource();
    const at = rid ? threads.find((t) => t.versions.some((v) => v.resourceId === rid)) : undefined;
    if (at && at.stage !== "done") {
      setTab(at.stage as Tab); setOpenId(at.id);
      const v = at.versions.find((x) => x.resourceId === rid)!;
      show(at, v);
      return;
    }
    choose(of("decide").length ? "decide" : of("review").length ? "review" : of("implementing").length ? "implementing" : "decide");
  }, [pane]);

  const t = shown ? threads.find((x) => x.id === shown.thread) : null;
  const v = t && shown ? t.versions.find((x) => x.n === shown.n) : null;

  async function press(th: DispatchThread, kind: "go" | "back"): Promise<void> {
    const s = th.stage as Tab, rest = of(s).filter((x) => x.id !== th.id);
    const next = rest[0];
    if (next) pick(next, s); else { setOpenId(null); setShown(null); }
    try { await dispatch.press(th.id, kind); }
    catch (e) { toast(StrataWhy(e, kind === "go" ? "Go didn't reach Claude" : "Send back didn't reach Claude"), 4200); }
  }

  const blank = !pane ? "Loading…"
    : !shown ? (tab === "implementing" && open ? "Claude is preparing the first page. It shows up in Decide when it is ready."
      : tab === "implementing" ? "Nothing with Claude right now."
      : tab === "review" ? "Nothing to review. Built pages show up here." : "Nothing to decide. Send a thread from the backlog in Focus.")
    : null;

  const capt = t && v ? caption(t, v) : null;
  return <>
    <header className={`dp-head on-${tab ?? "decide"}`}>
      <div className="dp-side-top">
        <nav className="dp-modes" aria-label="Mode">
          <a href={StrataPath("/dashboard")}>Focus</a>
          <span aria-current="page">Dispatch</span>
        </nav>
        <a className="dp-inbox" href={StrataPath("/dashboard#inbox")}>Inbox <i>{pane?.inbox ?? ""}</i></a>
      </div>
      <nav className="dp-rail" aria-label="Stages">
        {TABS.map(([s, name], i) => <span key={s} className="dp-step">
          {i ? <i aria-hidden="true">›</i> : null}
          <button type="button" aria-current={tab === s ? "true" : undefined} onClick={() => choose(s)}>
            {name} <b>{s === "implementing" ? `(${of(s).length})` : of(s).length}</b>
          </button>
        </span>)}
      </nav>
      <div className="dp-side-top end"><Clock /></div>
    </header>
    <div className={`dp-body on-${tab ?? "decide"}`}>
      <aside className="dispatch-pane" aria-label="Dispatch threads">
        <div className="dp-list">
          {tab === "implementing" ? <Implementing threads={here} openId={openId} onPick={(x) => pick(x)} />
            : here.map((x) => x.id === openId
              ? <OpenCard key={x.id} t={x} shown={shown?.thread === x.id ? shown.n : null} board={pane?.board ?? null}
                  onVersion={(ver) => show(x, ver)} onPress={(kind) => void press(x, kind)} />
              : <button key={x.id} type="button" className="dp-card" onClick={() => pick(x)}
                  onPointerDown={() => { if (pane?.board) room.warmBoard(pane.board); }}>
                  <span className="dp-title">{x.title}</span>
                  <span className="dp-meta">{latest(x) ? versionLabel(latest(x)!) : ""}</span>
                </button>)}
        </div>
      </aside>
      <div className="dispatch-room">
        <div className="dp-caption"><span>{capt ?? ""}</span>{capt ? <NotesChip /> : null}</div>
        <div className="dp-sheet">
          {children}
          {blank ? <div className="dispatch-blank"><p>{blank}</p></div> : null}
        </div>
      </div>
    </div>
  </>;
}

function OpenCard({ t, shown, board, onVersion, onPress }: { t: DispatchThread; shown: number | null; board: string | null;
  onVersion(v: DispatchVersion): void; onPress(kind: "go" | "back"): void }) {
  const review = t.stage === "review";
  const refs = t.links.map((l) => l.ref).join(" · ");
  return (
    <section className="dp-card open" aria-label={t.title}>
      <span className="dp-title">{t.title}</span>
      {refs ? <span className="dp-meta">{refs}</span> : null}
      <ol className="dp-versions" reversed>
        {[...t.versions].reverse().map((v) => <li key={v.n}>
          <button type="button" aria-current={shown === v.n ? "true" : undefined} onClick={() => onVersion(v)}
            onPointerDown={() => { if (board) room.warmBoard(board); }}>
            <b>{versionLabel(v)}</b><span>{notesLabel(v.notes)}</span>
          </button>
        </li>)}
      </ol>
      <div className="dp-acts">
        <button type="button" className={"dp-go" + (review ? " merge" : "")} onClick={() => onPress("go")}>{review ? "Go → merge" : "Go →"}</button>
        <button type="button" className="dp-back" onClick={() => onPress("back")}>Send back</button>
      </div>
    </section>
  );
}

function Implementing({ threads, openId, onPick }: { threads: DispatchThread[]; openId: string | null; onPick(t: DispatchThread): void }) {
  const building = threads.filter((t) => t.lands !== "decide"), preparing = threads.filter((t) => t.lands === "decide");
  const row = (t: DispatchThread) => (
    <div key={t.id} className={"dp-impl" + (t.id === openId ? " open" : "")}>
      <button type="button" className="dp-title" onClick={() => onPick(t)}>{t.title}</button>
      <span className="dp-meta">
        {t.press ? `${t.press.kind === "send" ? "sent" : t.press.kind === "go" ? "Go" : "sent back"} ${ago(t.press.at)} ago · ` : ""}next stop {STOP[t.lands ?? "decide"]}
        {t.press?.sessionUrl ? <a href={t.press.sessionUrl} target="_blank" rel="noopener">session ↗</a> : null}
      </span>
    </div>
  );
  return <>
    {building.length ? <h3 className="dp-group">Building · {building.length}</h3> : null}
    {building.map(row)}
    {preparing.length ? <h3 className="dp-group">Preparing a page · {preparing.length}</h3> : null}
    {preparing.map(row)}
    {!threads.length ? <p className="dp-none">Nothing with Claude right now.</p> : null}
  </>;
}
