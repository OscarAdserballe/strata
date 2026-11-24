// The prompts drawer: the guide Claude reads, topic by topic, as free text you can rewrite for this room.
// A saved topic replaces the shipped text for every run after it; Reset puts the shipped text back.
import { useEffect, useState, useSyncExternalStore } from "react";
import { StrataWhy } from "../../data/api.ts";
import { prompts, usePrompts, type Prompt } from "../../data/entities/prompts.ts";
import type { DispatchVersion } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";
import { hm } from "./parts.tsx";

// Open state lives here, not at the root, so opening the drawer re-renders only what shows it.
let shown: { topic: string } | null = null;
const subs = new Set<() => void>();
const set = (v: typeof shown) => { shown = v; subs.forEach((f) => f()); };
const useShown = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => shown);
export const openPrompts = (topic = "routine"): void => set({ topic });
const closePrompts = (): void => set(null);

// The topics a Dispatch run reads first, then the rest in the guide's order.
const FIRST = ["routine", "proposal", "built"];
const ordered = (ts: Prompt[]): Prompt[] => [...ts].sort((a, b) => (FIRST.indexOf(a.topic) + 1 || 99) - (FIRST.indexOf(b.topic) + 1 || 99));
const when = (at: number): string => `${new Date(at).toLocaleDateString([], { day: "numeric", month: "short" })} ${hm(at)}`;

export function PromptsButton() {
  return <button className="dh-prompts" onClick={() => openPrompts()} title="What Claude reads on each run">Prompts</button>;
}

export default function PromptsDrawer() {
  const on = useShown();
  return on ? <Drawer topic={on.topic} /> : null;
}

function Drawer({ topic }: { topic: string }) {
  const all = usePrompts(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [peek, setPeek] = useState(false);
  const list = all ? ordered(all.topics) : [];
  const p = list.find((t) => t.topic === topic) ?? list[0];
  const draft = p ? drafts[p.topic] ?? p.text : "";
  const dirty = !!p && p.topic in drafts && drafts[p.topic] !== p.text;
  useEffect(() => { setPeek(false); }, [topic]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closePrompts(); } };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);

  const save = (text: string | null) => {
    if (!p) return;
    const t = p.topic;
    setDrafts(({ [t]: _gone, ...rest }) => rest);
    prompts.save(t, text).then(() => toast(text === null ? `${t}: back to the shipped guide` : `${t}: the next run reads your text`))
      .catch((e) => toast(StrataWhy(e, "not saved"), 4200));
  };
  const leave = () => {
    if (Object.entries(drafts).some(([t, d]) => d !== list.find((x) => x.topic === t)?.text) && !confirm("Close without saving your changes?")) return;
    closePrompts();
  };

  return <>
    <div className="pr-scrim" onClick={leave} />
    <aside className="pr-drawer" role="dialog" aria-label="Prompts">
      <header>
        <div><b>Prompts</b><p>What Claude reads on every run. Your text replaces the shipped guide in this room, from the next run on.</p></div>
        <button className="pr-x" aria-label="Close" onClick={leave}>×</button>
      </header>
      <nav className="pr-tabs" role="tablist">
        {list.map((t) => <button key={t.topic} role="tab" aria-selected={t.topic === p?.topic} onClick={() => openPrompts(t.topic)}>
          {t.topic}{t.own ? <i title="your text" /> : null}{t.topic in drafts && drafts[t.topic] !== t.text ? " •" : ""}</button>)}
      </nav>
      {!p ? <p className="pr-wait">Opening…</p> : <>
        <p className="pr-state" data-own={p.own || undefined}>
          {p.own ? <>Your text · saved {when(p.updatedAt!)}</> : "Shipped guide, unedited"}
          {p.shippedChanged ? <> · <button className="pr-link warn" onClick={() => setPeek(!peek)}>{peek ? "Hide" : "The shipped text changed since you edited"}</button></> : null}
        </p>
        {peek ? <pre className="pr-peek" aria-label="The shipped text">{p.shipped}</pre> : null}
        <textarea className="pr-text" spellCheck={false} value={draft} aria-label={`The ${p.topic} prompt`}
          onChange={(e) => { const v = e.target.value; setDrafts((d) => ({ ...d, [p.topic]: v })); }} />
        <footer>
          <button className="btn dark" disabled={!dirty} onClick={() => save(draft)}>Save</button>
          {dirty ? <button className="btn quiet" onClick={() => setDrafts(({ [p.topic]: _gone, ...rest }) => rest)}>Discard</button> : null}
          <span />
          {p.own ? <button className="btn quiet" onClick={() => { if (confirm(`Put the shipped ${p.topic} guide back? Your text is not kept.`)) save(null); }}>Reset to shipped</button> : null}
        </footer>
      </>}
    </aside>
  </>;
}

/** The ⓘ beside "Claude heard": which topics were in your own text when this version was posted. */
export function Told({ v }: { v: DispatchVersion }) {
  const [open, setOpen] = useState(false);
  const told = v.told;
  return <span className="pr-told">
    <button className="pr-i" aria-expanded={open} aria-label="What this run was told" onClick={() => setOpen(!open)}>i</button>
    {open ? <span className="pr-pop" role="dialog" aria-label="What this run was told">
      <b>What this run was told</b>
      {told === null || told === undefined ? <span className="pr-row">Posted before Strata kept this.</span>
        : !told.length ? <span className="pr-row">The shipped guide, every topic.</span>
        : told.map((t) => <span key={t.topic} className="pr-row"><span>{t.topic}</span><em>your text · {when(t.at)}</em></span>)}
      {told?.length ? <span className="pr-row dim">Every other topic: the shipped guide.</span> : null}
      <button className="pr-link" onClick={() => { setOpen(false); openPrompts(told?.[0]?.topic); }}>Edit prompts →</button>
    </span> : null}
  </span>;
}
