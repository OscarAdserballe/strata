/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// Distil: a project's kept cards, notes and open questions, grouped by Claude into ideas you fold into fewer cards.
import type ReactNS from "react";
import type { DistilFace, DistilIdea, DistilMap, DistilMark, DistilMeta, DistilSuggestion, Minted } from "../../../shared/types/index.ts";
import type { StrataAPI as API } from "../../data/api.ts";
import type { distil as DistilT } from "../../data/entities/distil.ts";
import type { begin as Begin, end as End } from "../../platform/rum.ts";
import { ideaId } from "../../../shared/cards/distil-id.ts";

export interface DistilHost { React: typeof ReactNS; StrataAPI: typeof API; distil: typeof DistilT; begin: typeof Begin; arrived: typeof End; why: (e: unknown, fallback: string) => string }
let React: typeof ReactNS, StrataAPI: typeof API, distil: typeof DistilT, begin: typeof Begin, arrived: typeof End;
let why: DistilHost["why"];
let useState: typeof ReactNS.useState, useEffect: typeof ReactNS.useEffect, useMemo: typeof ReactNS.useMemo;
export function bindDistil(host: DistilHost) {
  ({ React, StrataAPI, distil, begin, arrived, why } = host);
  ({ useState, useEffect, useMemo } = React);
}

const KIND_LABEL: Record<DistilSuggestion["kind"], string> = { merge: "merge ideas", tighten: "tighten", answer: "answer your ask", conflict: "conflict", split: "split the card" };
const MARK_LABEL: Record<DistilMark["kind"], string> = { kept: "kept card", note: "note", ask: "ask" };
const metaOf = (m: Minted): DistilMeta | null => ((m.meta as { distil?: DistilMeta } | null)?.distil ?? null);

/** Two ideas the reader merged are one idea: the union of marks, under the id those marks name. */
export function mergeIdeas(a: DistilIdea, b: DistilIdea): DistilIdea {
  const marks = Array.from(new Set([...a.marks, ...b.marks]));
  return { ...a, id: ideaId(marks), marks, why: [a.why, b.why].filter(Boolean).join(" "),
    draft: { front: a.draft.front, back: [a.draft.back, b.draft.back].filter(Boolean).join(" ") },
    suggestions: [...a.suggestions, ...b.suggestions].filter((s) => s.kind !== "merge") };
}

interface Work { cards: DistilFace[]; drafted: DistilMeta["drafted"]; dismissed: string[] }
const workOf = (i: DistilIdea): Work => ({ cards: [i.draft], drafted: "agent", dismissed: [] });

export interface DistilProps {
  boardId: string;
  decks: string[];
  /** the board's own cards; a distilled one carries meta.distil */
  minted: Minted[];
  onBack: () => void;
}

export default function Distil({ boardId, decks, minted, onBack }: DistilProps) {
  // a proposal, like the plan draft: it lives here until a keep writes it through the save path
  const [map, setMap] = useState<DistilMap | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"map" | "idea" | "done">("map");
  const [at, setAt] = useState<string | null>(null);
  const [work, setWork] = useState<Record<string, Work>>({});
  const [left, setLeft] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const done = useMemo(() => {
    const by = new Map<string, { meta: DistilMeta; cards: Minted[] }>();
    for (const m of minted) {
      const d = metaOf(m);
      if (!d) continue;
      const g = by.get(d.idea) ?? { meta: d, cards: [] };
      g.cards.push(m);
      by.set(d.idea, g);
    }
    return Array.from(by.values());
  }, [minted]);
  const doneIds = useMemo(() => new Set(done.map((d) => d.meta.idea)), [done]);

  useEffect(() => {
    let live = true;
    begin("distil.map");
    StrataAPI.distilMap(boardId, decks).then((m) => { if (live) { setMap(m); arrived("distil.map"); } },
      (e) => { if (live) setError(why(e, "couldn't group your marks")); });
    return () => { live = false; };
  }, [boardId, decks.join("\n")]);

  const byRef = useMemo(() => new Map((map?.marks ?? []).map((m) => [m.ref, m])), [map]);
  const ideas = map?.ideas ?? [];
  const idea = ideas.find((i) => i.id === at) ?? null;
  const w = idea ? work[idea.id] ?? workOf(idea) : null;
  const setW = (fn: (w: Work) => Work) => idea && setWork((all) => ({ ...all, [idea.id]: fn(all[idea.id] ?? workOf(idea)) }));
  const open = ideas.filter((i) => !doneIds.has(i.id) && !left.includes(i.id));
  const next = (after: string | null) => { const n = open.find((i) => i.id !== after); setAt(n ? n.id : null); setView(n ? "idea" : "done"); };

  function merge(a: DistilIdea, withId: string) {
    const b = ideas.find((i) => i.id === withId);
    if (!b || !map) return;
    const m = mergeIdeas(a, b);
    setMap({ ...map, ideas: ideas.flatMap((i) => (i.id === a.id ? [m] : i.id === b.id ? [] : [i])) });
    if (at === a.id || at === b.id) setAt(m.id);
  }
  function take(s: DistilSuggestion) {
    if (!idea) return;
    if (s.kind === "merge" && s.with) { merge(idea, s.with); return; }
    setW((x) => ({ ...x, cards: s.cards ? s.cards : s.draft ? [s.draft] : x.cards, drafted: "agent", dismissed: [...x.dismissed, s.id] }));
  }
  const dismiss = (s: DistilSuggestion) => setW((x) => ({ ...x, dismissed: [...x.dismissed, s.id] }));
  const editCard = (i: number, patch: Partial<DistilFace>) =>
    setW((x) => ({ ...x, drafted: x.drafted === "you" ? "you" : "edited", cards: x.cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const yourWords = () => setW((x) => ({ ...x, drafted: "you", cards: x.cards.map((c) => ({ front: c.front, back: "" })) }));

  async function keep() {
    if (!idea || !w || busy) return;
    const cards = w.cards.map((c) => ({ front: c.front.trim(), back: c.back.trim() }));
    if (cards.some((c) => !c.front || !c.back)) { setError("Write a question and an answer on each card."); return; }
    setBusy(true); setError("");
    begin("distil.keep");
    try {
      await distil.keep(boardId, { idea: idea.id, title: idea.title, deck: idea.deck, cards, from: idea.marks, drafted: w.drafted });
      arrived("distil.keep");
      next(idea.id);
    } catch (e) { setError(why(e, "couldn't keep that card")); }
    finally { setBusy(false); }
  }
  async function undo(meta: DistilMeta, deck: string) {
    setBusy(true); setError("");
    try { await distil.undo(boardId, meta.idea, meta.from, deck); }
    catch (e) { setError(why(e, "couldn't undo that")); }
    finally { setBusy(false); }
  }

  const tally = (refs: string[]) => {
    const n = { kept: 0, note: 0, ask: 0 };
    for (const r of refs) { const m = byRef.get(r); if (m) n[m.kind]++; }
    return (Object.keys(n) as DistilMark["kind"][]).filter((k) => n[k]).map((k) => `${n[k]} ${MARK_LABEL[k]}${n[k] === 1 ? "" : "s"}`).join(" · ");
  };
  const sugRow = (s: DistilSuggestion, i: DistilIdea, inMap: boolean) => (
    <div key={s.id} className="dst-sug" data-kind={s.kind}>
      <div className="dst-sug-k">{KIND_LABEL[s.kind]}</div>
      <div className="dst-sug-t">{s.text}</div>
      {s.cards ? <ol className="dst-sug-cards">{s.cards.map((c, j) => <li key={j}>{c.front}</li>)}</ol> : null}
      {s.draft && !inMap ? <div className="dst-sug-draft"><b>{s.draft.front}</b> {s.draft.back}</div> : null}
      {s.kind !== "conflict" ? <button className="dst-take" disabled={busy} onClick={() => (inMap && s.with ? merge(i, s.with) : take(s))}>{s.kind === "merge" ? "merge" : "take"}</button> : null}
      {!inMap ? <button className="cram-link" onClick={() => dismiss(s)}>dismiss</button> : null}
    </div>
  );

  if (error && !map) return <div className="cram-choose"><p className="dst-err">{error}</p><button className="lask-go" onClick={onBack}>back</button></div>;
  if (!map) return <div className="cram-choose"><p className="cram-quiet">Claude is grouping your marks…</p></div>;

  const keptN = done.reduce((n, d) => n + d.cards.length, 0), foldedN = done.reduce((n, d) => n + d.meta.from.length, 0);
  const head = (
    <div className="dst-head">
      <span className="dst-big">{map.marks.length} marks → {ideas.length} idea{ideas.length === 1 ? "" : "s"}</span>
      <span className="grow" />
      {view !== "map" ? <button onClick={() => setView("map")}>map</button> : null}
      <button className={view === "done" ? "on" : ""} onClick={() => setView("done")}>done · {keptN}</button>
    </div>
  );

  if (view === "done") return (
    <div className="cram-choose dst">
      {head}
      <div className="dst-tally" data-strata-id="distil-tally">{foldedN} marks → {keptN} card{keptN === 1 ? "" : "s"}</div>
      {done.length ? done.map(({ meta, cards }) => (
        <div key={meta.idea} className="dst-done">
          <div className="dst-done-t">{meta.title || "An idea"} <span className="cram-n">{meta.from.length} → {cards.length}</span></div>
          {cards.map((c) => <div key={c.id} className="dst-done-c"><b>{c.front}</b> {c.back}</div>)}
          <button className="cram-link" disabled={busy} onClick={() => undo(meta, String(cards[0]?.cardId ?? "").split("/")[0])}>undo: its marks come back</button>
        </div>
      )) : <p className="cram-quiet">Nothing kept yet. Every card you keep here lands in review, and the kept cards it folds in leave it.</p>}
      {error ? <p className="dst-err">{error}</p> : null}
      <div className="cram-foot"><button className="cram-link" onClick={onBack}>back to cram</button><span className="grow" />
        {open.length ? <button className="lask-go" onClick={() => next(null)}>next idea</button> : null}</div>
    </div>
  );

  if (view === "idea" && idea && w) {
    const sugs = idea.suggestions.filter((s) => !w.dismissed.includes(s.id) && (s.kind !== "merge" || ideas.some((i) => i.id === s.with)));
    return (
      <div className="cram-choose dst dst-wide">
        {head}
        <div className="dst-idea-t">{idea.title}</div>
        <div className="dst-why">{idea.why}</div>
        <div className="dst-cols">
          <div className="dst-marks">
            <div className="cram-gh">what it folds in · {idea.marks.length}</div>
            {idea.marks.map((r) => { const m = byRef.get(r); return m ? (
              <div key={r} className="dst-mark" data-kind={m.kind}><span className="dst-mk">{MARK_LABEL[m.kind]}</span> {m.text}
                {m.said ? <div className="dst-said">{m.said}</div> : null}<div className="dst-from">{m.from}</div></div>) : null; })}
          </div>
          <div className="dst-draft">
            <div className="cram-gh">{w.cards.length === 1 ? "the card" : `${w.cards.length} cards`} · {w.drafted === "agent" ? "Claude’s draft" : "your words"}
              {w.drafted !== "you" ? <button className="cram-link dst-yours" onClick={yourWords}>write the answer yourself</button> : null}</div>
            {w.cards.map((c, i) => (
              <div key={i} className="dst-face">
                <textarea aria-label="the question" rows={2} value={c.front} onChange={(e) => editCard(i, { front: e.target.value })} />
                <textarea aria-label="the answer" rows={4} value={c.back} placeholder="the answer, in your words" onChange={(e) => editCard(i, { back: e.target.value })} />
              </div>
            ))}
            {sugs.length ? <div className="dst-sugs">{sugs.map((s) => sugRow(s, idea, false))}</div> : null}
          </div>
        </div>
        {error ? <p className="dst-err">{error}</p> : null}
        <div className="cram-foot">
          <button className="cram-link" onClick={() => { setLeft((l) => [...l, idea.id]); next(idea.id); }}>leave these alone</button>
          <span className="grow" />
          <span className="cram-total">its {tally(idea.marks.filter((r) => r.startsWith("k:")))} leave review</span>
          <button className="lask-go" disabled={busy} onClick={keep}>{busy ? "keeping…" : `keep ${w.cards.length === 1 ? "card" : `${w.cards.length} cards`}`}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="cram-choose dst">
      {head}
      {!ideas.length ? <p className="cram-quiet">{map.marks.length < 2 ? "There is not enough here to distil yet: keep cards and write notes first." : "Claude found no marks that circle the same idea."}</p> : null}
      {ideas.map((i) => {
        const kept = doneIds.has(i.id), alone = left.includes(i.id);
        return (
          <div key={i.id} className={"dst-row" + (kept ? " kept" : alone ? " alone" : "")} data-strata-id={`idea-${i.id}`}>
            <button className="dst-open" onClick={() => { setAt(i.id); setView("idea"); }} disabled={kept}>
              <span className="dst-row-t">{kept ? "✓ " : ""}{i.title}</span>
              <span className="dst-row-w">{i.why}</span>
              <span className="dst-row-n">{tally(i.marks)}</span>
            </button>
            {!kept && !alone ? i.suggestions.filter((s) => s.kind === "merge" && ideas.some((x) => x.id === s.with)).map((s) => sugRow(s, i, true)) : null}
            {alone ? <button className="cram-link" onClick={() => setLeft((l) => l.filter((x) => x !== i.id))}>bring back</button> : null}
          </div>
        );
      })}
      {map.loose.length ? <p className="cram-quiet">{map.loose.length} mark{map.loose.length === 1 ? "" : "s"} fit no idea and stay as they are.</p> : null}
      <div className="cram-foot">
        <button className="cram-link" onClick={onBack}>back to cram</button><span className="grow" />
        <button className="lask-go" disabled={!open.length} onClick={() => next(null)}>{open.length ? `start: ${open.length} idea${open.length === 1 ? "" : "s"}` : "all done"}</button>
      </div>
      <p className="cram-quiet">Nothing changes until you keep a card. Keeping one puts it in review and retires the kept cards it folds in; undo brings them back.</p>
    </div>
  );
}
