/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type ReactNS from "react";
import type { ReactNode } from "react";
import type { BoardPlan, DeckSummary, Pair, ResourceMeta, Section } from "../../../shared/types/index.ts";
import type { CardFaces } from "../../../shared/cards/card-tidy.ts";
import type { registerKeys as RegisterKeys } from "../../capabilities/keys/registry.ts";
import type { cardPrompt as CardPrompt } from "../../capabilities/card/drill-order.ts";
import type { facesOf as FacesOf } from "../../../shared/cards/faces.ts";
import type { StrataAPI as API } from "../../data/api.ts";
import type { begin as Begin, end as End } from "../../platform/rum.ts";
import {
  afterGrade, countOf, crammableMine, cramSources, loadPrefs, pileOf, savePrefs, shuffled, tickedDecks,
  type CramDeck, type CramPrefs,
} from "./cram.ts";
import type { default as CardFormT } from "../../capabilities/card/CardForm.tsx";
import type { default as CardMetaT } from "../../capabilities/card/CardMeta.tsx";
import type { default as CardHistoryT } from "../../capabilities/card/CardHistory.tsx";
import type { deckOf as DeckOf } from "../../capabilities/card/saveCard.ts";
import type { default as CardControlsT, gradeActions as GradeActions } from "../../capabilities/card/CardControls.tsx";
import type { default as CardFaceT, FaceCard } from "../../capabilities/card/CardFace.tsx";
import type { default as AskT } from "../../capabilities/ask/Ask.tsx";
import type { closeAsk as CloseAsk, openAsk as OpenAsk } from "../../capabilities/ask/control.ts";
import type { cardThreadKey as CardThreadKey } from "../../capabilities/ask/threads.ts";
import type { useProvideHere as UseProvideHere } from "../../shell/here.ts";
import type { default as ComposerT, ComposerProps } from "../../capabilities/card/Composer.tsx";
import type { ComposerDraft } from "../../capabilities/card/composing.ts";

// lazy chunk: import only types, or esbuild hoists shared code into the boot bundle; deps come via bind()
export interface CramHost {
  React: typeof ReactNS; TOUCH: boolean; PHONE: boolean;
  registerKeys: typeof RegisterKeys; cardPrompt: typeof CardPrompt; facesOf: typeof FacesOf; StrataAPI: typeof API;
  begin: typeof Begin; arrived: typeof End;
  CardForm: typeof CardFormT; CardMeta: typeof CardMetaT; CardHistory: typeof CardHistoryT; deckOf: typeof DeckOf;
  CardControls: typeof CardControlsT; gradeActions: typeof GradeActions; CardFace: typeof CardFaceT;
  Ask: typeof AskT; closeAsk: typeof CloseAsk; openAsk: typeof OpenAsk; cardThreadKey: typeof CardThreadKey;
  useProvideHere: typeof UseProvideHere; Composer: typeof ComposerT;
}
let React: typeof ReactNS, TOUCH = false, PHONE = false;
let useState: typeof ReactNS.useState, useEffect: typeof ReactNS.useEffect, useMemo: typeof ReactNS.useMemo, useRef: typeof ReactNS.useRef;
let registerKeys: typeof RegisterKeys, cardPrompt: typeof CardPrompt, facesOf: typeof FacesOf, StrataAPI: typeof API;
let begin: typeof Begin, arrived: typeof End;
let CardForm: typeof CardFormT, CardMeta: typeof CardMetaT, CardHistory: typeof CardHistoryT, deckOf: typeof DeckOf;
let CardControls: typeof CardControlsT, gradeActions: typeof GradeActions, CardFace: typeof CardFaceT;
let Ask: typeof AskT, closeAsk: typeof CloseAsk, openAsk: typeof OpenAsk, cardThreadKey: typeof CardThreadKey;
let useProvideHere: typeof UseProvideHere, Composer: typeof ComposerT;
export function bind(host: CramHost) {
  ({ React, TOUCH, PHONE, registerKeys, cardPrompt, facesOf, StrataAPI, begin, arrived, CardForm, CardMeta, CardHistory, deckOf,
    CardControls, gradeActions, CardFace, Ask, closeAsk, openAsk, cardThreadKey, useProvideHere, Composer } = host);
  // the host's React, so hooks share one instance
  ({ useState, useEffect, useMemo, useRef } = React);
}

export type CramCard = FaceCard & { id: string; deck?: string | null; course?: string };
interface Loaded { slug: string; cards: CramCard[]; kept: Set<string> | null }
type Phase = "choose" | "round" | "end";
interface Live {
  phase: Phase; card: CramCard | null; answered: boolean; picked: number | null; editing: boolean; round: number;
  missed: number; pile: CramCard[] | null; start: () => Promise<void>; again: (onlyMissed: boolean) => void;
  close: () => void; composing: boolean;
}

export interface CramProps {
  boardId: string;
  title: string;
  pairs: Pair[] | null | undefined;
  resources: ResourceMeta[] | null | undefined;
  sections: Section[] | null | undefined;
  decks: DeckSummary[] | null | undefined;
  plan: BoardPlan | null | undefined;
  mine: CramCard[] | null | undefined;
  deckCards: (slug: string) => Promise<CramCard[] | null | undefined>;
  onEditSave: (card: CramCard, patch: CardFaces) => Promise<CramCard>;
  onDeleteCard?: ((card: CramCard) => unknown) | null;
  onJump?: ((card: CramCard) => void) | null;
  onClose: () => void;
  composer: ComposerDraft | null;
  onNewCard?: ((card: CramCard, question: string, answer: string) => void) | null;
  onComposerSave: ComposerProps["onSave"];
  onComposerCancel: () => void;
}

function CramSurface({ boardId, title, pairs, resources, sections, decks, plan, mine, deckCards, onEditSave, onDeleteCard, onJump, onClose,
  composer, onNewCard, onComposerSave, onComposerCancel }: CramProps) {
  const sources = useMemo(() => cramSources(pairs || [], resources || [], sections || [], decks || [], plan),
    [pairs, resources, sections, decks, plan]);
  const label = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sources) for (const d of s.decks) m.set(d.slug, s.book ? `${s.label} · ${d.label}` : s.label);
    return m;
  }, [sources]);
  const yours = useMemo(() => crammableMine(mine || []), [mine]);

  const [prefs, setPrefsState] = useState(() => loadPrefs(boardId));
  const setPrefs = (fn: CramPrefs | ((p: CramPrefs) => CramPrefs)) => setPrefsState((p) => { const n = typeof fn === "function" ? fn(p) : fn; savePrefs(boardId, n); return n; });
  const ticked = useMemo(() => tickedDecks(sources, prefs), [sources, prefs]);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const loads = useRef<Record<string, Promise<Loaded>>>({});
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const load = (slug: string) => {
    if (!loads.current[slug]) {
      loads.current[slug] = Promise.all([
        deckCards(slug),
        StrataAPI.deckKeeps(slug).then((r) => new Set<string>(r.ids || [])).catch(() => null),
      ]).then(([cards, kept]) => {
        const d: Loaded = { slug, cards: cards || [], kept };
        setLoaded((x) => ({ ...x, [slug]: d }));
        return d;
      });
    }
    return loads.current[slug];
  };
  useEffect(() => { for (const s of ticked) load(s); }, [ticked]);

  const allHere = Array.from(ticked).every((s) => loaded[s]);
  const pile = useMemo(() => (allHere ? pileOf(Array.from(ticked).map((s) => loaded[s]), yours, prefs) : null),
    [allHere, ticked, loaded, yours, prefs]);
  const listed = Array.from(ticked).reduce((n, s) => {
    const d = sources.flatMap((x) => x.decks).find((x) => x.slug === s);
    return n + (d ? countOf(d, prefs.kept) : 0);
  }, 0) + (prefs.mine ? yours.length : 0);

  const [phase, setPhase] = useState<Phase>("choose");
  const [round, setRound] = useState(0);
  const [queue, setQueue] = useState<CramCard[]>([]);
  const [roundCards, setRoundCards] = useState<CramCard[]>([]);
  const [missed, setMissed] = useState(() => new Set<string>());
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const card = phase === "round" && queue.length ? queue[0] : null;
  const answered = revealed || picked !== null;
  const course = card ? String(card.course || String(card.deck || "").split("/")[0]) : "";
  useProvideHere(() => ({ surface: "cram", board: boardId,
    card: card ? { id: card.id, deck: course, course, role: "subject", prompt: cardPrompt(card) as string,
      picked, revealed: answered } : null }));
  const recalled = roundCards.length - new Set(queue.map((c) => c.id)).size;

  useEffect(() => { arrived("cram.open"); }, []);
  useEffect(() => { if (card) arrived("cram.start"); }, [!!card]);
  useEffect(() => {
    try { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body && a.blur) a.blur(); } catch (e) { /* no DOM */ }
  }, []);

  function begin1(cards: CramCard[], n: number) {
    setRound(n); setRoundCards(cards); setQueue(shuffled(cards)); setMissed(new Set());
    setRevealed(false); setPicked(null); setEditing(null); setPhase(cards.length ? "round" : "choose");
    StrataAPI.log("cram_round", { cram: true, at: boardId, round: n, cards: cards.length });
  }
  async function start() {
    if (starting) return;
    begin("cram.start");
    setStarting(true);
    try {
      const got = await Promise.all(Array.from(ticked).map(load));
      const cards = pileOf(got, yours, prefs);
      if (!cards.length) return;
      StrataAPI.log("cram_start", { cram: true, at: boardId, cards: cards.length, decks: ticked.size, kept: prefs.kept, mine: prefs.mine });
      begin1(cards, 1);
    } finally { setStarting(false); }
  }
  useEffect(() => { if (phase === "round" && !queue.length) setPhase("end"); }, [phase, queue.length]);
  const again = (onlyMissed: boolean) => begin1(onlyMissed ? roundCards.filter((c) => missed.has(c.id)) : (pile || roundCards), round + 1);

  const shownAt = useRef(0);
  useEffect(() => { shownAt.current = Date.now(); }, [card && card.id, round]);
  function grade(got: boolean) {
    const c = ref.current.card;
    if (!c || !ref.current.answered) return;
    StrataAPI.log("cram_grade", { cram: true, at: boardId, card: c.id, deck: c.deck || null, type: c.type,
      got, round: ref.current.round, ms: Math.max(0, Date.now() - shownAt.current) });
    if (!got) setMissed((m) => new Set(m).add(c.id));
    setRevealed(false); setPicked(null);
    setQueue((qu) => (qu[0]?.id !== c.id ? qu : afterGrade(qu, got)));
  }
  function reveal() { if (ref.current.card && !ref.current.answered) setRevealed(true); }
  function pick(i: number) { if (ref.current.card && ref.current.picked === null) setPicked(i); }
  function drop() {
    const c = ref.current.card; if (!c) return;
    setPrefs((p) => ({ ...p, dropped: Array.from(new Set([...p.dropped, c.id])) }));
    setRoundCards((rc) => rc.filter((x) => x.id !== c.id));
    setRevealed(false); setPicked(null);
    setQueue((qu) => qu.filter((x) => x.id !== c.id));
    StrataAPI.log("cram_drop", { cram: true, at: boardId, card: c.id, deck: c.deck || null });
  }
  // update the drawn decks and the cached reads together, or Start deals stale words
  function rewriteDecks(fn: (cards: CramCard[]) => CramCard[]) {
    setLoaded((ld) => Object.fromEntries(Object.entries(ld).map(([k, d]) => [k, { ...d, cards: fn(d.cards) }])));
    for (const k of Object.keys(loads.current)) loads.current[k] = loads.current[k].then((d) => ({ ...d, cards: fn(d.cards) }));
  }
  function saveEdit(c: CramCard, patch: CardFaces) {
    const adopt = (merged: CramCard) => {
      const put = (x: CramCard) => (x.id === c.id ? { ...x, ...merged } : x);
      setQueue((qu) => qu.map(put)); setRoundCards((rc) => rc.map(put));
      // update the cram's copy too, or the next round deals the old words
      rewriteDecks((cards) => cards.map(put));
    };
    return onEditSave(c, patch).catch((e) => { if (e && e.theirs) adopt(e.theirs); throw e; }).then((merged) => {
      adopt(merged);
      setEditing((id) => (id === c.id ? null : id));
    });
  }

  async function deleteCard(c: CramCard) {
    await onDeleteCard!(c);
    const out = (list: CramCard[]) => list.filter((x) => x.id !== c.id);
    if (ref.current.card && ref.current.card.id === c.id) { setRevealed(false); setPicked(null); }
    setQueue(out); setRoundCards(out);
    rewriteDecks(out);
    setEditing((id) => (id === c.id ? null : id));
  }
  function jump() {
    const c = ref.current.card;
    if (!c || !ref.current.answered || c.mine || !onJump) return;
    StrataAPI.log("jump_to_source", { cram: true, at: boardId, card: c.id });
    onJump(c);
  }

  // capture phase, so the room behind never hears these keys
  const ref = useRef({} as Live);
  ref.current = { phase, card, answered, picked, editing: !!(card && editing === card.id), round, missed: missed.size, pile, start, again, close: onClose,
    composing: !!composer };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      const el = e.target as HTMLInputElement | null;
      const box = !!el && el.tagName === "INPUT" && el.type === "checkbox";
      if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !box))) return;
      e.stopPropagation();
      const k = (e.key || "").toLowerCase();
      const s = ref.current;
      if (s.composing) { if (k === "escape") { e.preventDefault(); onComposerCancel(); } return; }
      if (k === "/" && !s.editing) { e.preventDefault(); openAsk(); return; }
      if (k === "escape" && s.editing) { e.preventDefault(); setEditing(null); return; }
      if (s.editing) return;
      if (k === "escape" && closeAsk()) { e.preventDefault(); return; }
      if (k === "escape") { e.preventDefault(); if (s.phase === "choose") s.close(); else setPhase("choose"); return; }
      if (s.phase === "choose") {
        if ((k === "enter" || (k === " " && !box)) && !e.repeat) { e.preventDefault(); s.start(); }
        return;
      }
      if (s.phase === "end") {
        if (k === "1" && s.missed && !e.repeat) { e.preventDefault(); s.again(true); }
        else if ((k === "2" || k === " " || k === "enter") && !e.repeat) { e.preventDefault(); s.again(false); }
        return;
      }
      const c = s.card; if (!c) return;
      if (k === "e") { e.preventDefault(); setEditing(c.id); return; }
      if (k === "d" && !e.repeat) { e.preventDefault(); drop(); return; }
      if (k === " ") { e.preventDefault(); if (c.type !== "mcq") reveal(); return; }
      if (c.type === "mcq" && s.picked === null) {
        if (k >= "1" && k <= "4" && !e.repeat) { e.preventDefault(); pick(+k - 1); }
        return;
      }
      if ((k === "1" || k === "2") && !e.repeat) { e.preventDefault(); if (s.answered) grade(k === "2"); else reveal(); return; }
      if (k === "enter" && s.answered && !e.repeat) { e.preventDefault(); jump(); }
    };
    return registerKeys({ screen: "cram", over: true, owns: true, onKey });
  }, []);

  const setTicked = (slugs: string[], on: boolean) => setPrefs((p) => {
    const cur = tickedDecks(sources, p);
    for (const s of slugs) { if (on) cur.add(s); else cur.delete(s); }
    return { ...p, decks: Array.from(cur) };
  });
  const groups = [...(plan?.groups || []).map((g) => ({ id: g.id, name: g.name })), { id: null, name: (plan?.groups || []).length ? "Ungrouped" : "Sources" }]
    .map((g) => ({ ...g, rows: sources.filter((s) => s.group === g.id) })).filter((g) => g.rows.length);
  const tick = (slugs: string[], children: ReactNode, cls?: string) => {
    const n = slugs.filter((s) => ticked.has(s)).length;
    return (
      <label className={"cram-tick" + (cls ? " " + cls : "")}>
        <input type="checkbox" checked={n > 0 && n === slugs.length}
          ref={(el) => { if (el) el.indeterminate = n > 0 && n < slugs.length; }}
          onChange={(e) => setTicked(slugs, e.target.checked)} />
        {children}
      </label>
    );
  };
  const n = (d: CramDeck) => countOf(d, prefs.kept);
  const sum = (ds: CramDeck[]) => ds.reduce((a, d) => a + n(d), 0);

  const chooser = (
    <div className="cram-choose">
      <div className="cram-modes" role="group" aria-label="Which cards">
        <button className={prefs.kept ? "on" : ""} onClick={() => setPrefs((p) => ({ ...p, kept: true }))}>★ kept</button>
        <button className={!prefs.kept ? "on" : ""} onClick={() => setPrefs((p) => ({ ...p, kept: false }))}>every card</button>
        <span className="grow" />
        <button className="cram-all" onClick={() => setPrefs((p) => ({ ...p, decks: null, mine: true }))}>all</button>
        <button className="cram-all" onClick={() => setPrefs((p) => ({ ...p, decks: [], mine: false }))}>none</button>
      </div>
      {groups.map((g) => {
        const slugs = g.rows.flatMap((s) => s.decks.map((d) => d.slug));
        return (
          <div key={g.id || "-"} className="cram-group">
            {tick(slugs, <span className="cram-name">{g.name}</span>, "cram-gh")}
            {g.rows.map((s) => {
              const ds = s.decks.map((d) => d.slug);
              const book = s.book;
              const on = ds.filter((x) => ticked.has(x)).length;
              return (
                <div key={s.key} className="cram-src">
                  <div className="cram-row">
                    {tick(ds, <span className="cram-name">{s.label}</span>)}
                    {book ? <button className="cram-open" aria-expanded={!!open[s.key]}
                      onClick={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))}>
                      {on === ds.length ? `${ds.length} chapter${ds.length === 1 ? "" : "s"}` : `${on} of ${ds.length} chapters`} {open[s.key] ? "▴" : "▾"}</button> : null}
                    <span className="cram-n">{sum(s.decks)}</span>
                  </div>
                  {book && open[s.key] ? s.decks.map((d) => (
                    <div key={d.slug} className="cram-row cram-ch">
                      {tick([d.slug], <span className="cram-name">{d.label}</span>)}
                      <span className="cram-n">{n(d)}</span>
                    </div>
                  )) : null}
                </div>
              );
            })}
          </div>
        );
      })}
      <div className="cram-group">
        <div className="cram-row">
          <label className="cram-tick">
            <input type="checkbox" checked={prefs.mine} onChange={(e) => setPrefs((p) => ({ ...p, mine: e.target.checked }))} />
            <span className="cram-name">Your cards</span>
          </label>
          <span className="cram-n">{yours.length}</span>
        </div>
      </div>
      {!sources.length && !yours.length ? <p className="cram-quiet">This board has no cards yet.</p> : null}
      <div className="cram-foot">
        <span className="cram-total">
          {pile ? pile.length : listed} card{(pile ? pile.length : listed) === 1 ? "" : "s"}
          {prefs.dropped.length ? <> · {prefs.dropped.length} dropped <button className="cram-link"
            onClick={() => setPrefs((p) => ({ ...p, dropped: [] }))}>bring back</button></> : null}
        </span>
        <span className="grow" />
        <button className="lask-go" disabled={starting || (pile ? !pile.length : !listed)} onClick={start}>
          {starting ? "loading…" : "Start"}{!TOUCH ? <kbd>↵</kbd> : null}</button>
      </div>
      <p className="cram-quiet">Off the review schedule: nothing here moves a card’s next review or counts as seen.</p>
    </div>
  );

  const missedN = missed.size;
  const allN = pile ? pile.length : roundCards.length;
  return (
    <div className="veil reviewv cramv">
      <div className="rwrap">
        <div className="rhead">
          <span className="ltitle">Cram</span>
          <span className="lsub">{title || "this board"}{phase !== "choose" ? ` · round ${round}` : ""}</span>
          <span className="grow" />
          {phase !== "choose" ? <button className="seg" onClick={() => setPhase("choose")} title="choose again (esc)">choose</button> : null}
          <button className="seg" onClick={onClose} title="back to the board">✕</button>
        </div>
        {composer ? (
          <div className="rcard rcompose">
            <Composer front0={composer.front} answer={composer.answer} anchor={composer.anchor}
              closing={!!composer.mintId} review onSave={onComposerSave} onCancel={onComposerCancel} />
          </div>
        ) : phase === "choose" ? chooser
        : phase === "end" ? (
          <div className="rdone">
            <div className="rdone-mark">✓</div>
            <div className="rdone-line">Round {round} done: {roundCards.length} card{roundCards.length === 1 ? "" : "s"} recalled</div>
            <div className="rdone-when">{missedN ? `${missedN} needed another go` : "every one first time"}</div>
            <div className="cram-again">
              {missedN ? <button className="lask-go" onClick={() => again(true)}>{!TOUCH ? <kbd>1</kbd> : null}only the {missedN} missed</button> : null}
              <button className="lask-go" onClick={() => again(false)}>{!TOUCH ? <kbd>2</kbd> : null}again: all {allN}</button>
            </div>
          </div>
        ) : card ? (
          <div className="rcard cram-card" onClick={TOUCH && !answered && card.type !== "mcq" ? reveal : undefined}>
            <div className="cram-bar" aria-hidden="true"><i style={{ width: `${Math.round(100 * recalled / Math.max(1, roundCards.length))}%` }} /></div>
            <CardMeta card={card} from={card.mine ? null : label.get(deckOf(card)) || ""} board={boardId}
              editing={editing === card.id} onEdit={(c) => setEditing(c.id)} revealed={answered} extra={{ cram: true }} />
            {editing === card.id ? (
              <CardForm key={card.id} card={card} faces={facesOf(card.type)}
                onSave={(patch) => saveEdit(card, patch)} onCancel={() => setEditing(null)}
                onDelete={onDeleteCard && !card.mine ? () => deleteCard(card) : undefined} />
            ) : (<>
              <CardFace card={card} revealed={revealed} picked={picked} onPick={pick} />
              <CardControls
                actions={[
                  ...(answered ? gradeActions(grade) : []),
                  !answered && card.type !== "mcq" ? { id: "reveal", label: "reveal", kbd: "space", live: true, on: reveal } : null,
                  { id: "drop", label: "not on the exam", kbd: "d", on: drop, title: "drop this card from the cram — bring it back from the chooser" },
                  answered && onJump && !card.mine ? { id: "jump", label: "go to where this lives", kbd: "↵", on: jump } : null,
                ]}
                hints={[!answered && card.type === "mcq" ? { id: "pick", text: "answer", kbd: "1–4" } : null]} />
            </>)}
            <div className="rule" />
            <div className="count">{recalled} of {roundCards.length} recalled{missedN ? ` · ${missedN} missed` : ""}{PHONE ? "" : " · misses come round again"}</div>
            <div className="cram-off">grades here stay in the cram — they don’t move the review schedule</div>
            {/* its own key: sharing CardForm's key left a dead, focused editor in the DOM */}
            {answered && !card.mine ? <CardHistory key={"history:" + card.id} card={{ id: card.id, course: deckOf(card) }} /> : null}
          </div>
        ) : null}
      </div>
      {card ? <Ask key={card.id} thread={card.mine ? null : cardThreadKey(course, card.id)} name="this card’s thread"
        placeholder="ask about this card…"
        locked={card.mine ? "your own question — ask about it on its board" : answered ? null : "turn the card over to ask about it"}
        onCompose={onNewCard ? (q, a) => onNewCard(card, q, a) : null}
        feedback={{ board: boardId, card: card.id, deck: card.deck, context: { cram: true, card } }} /> : null}
    </div>
  );
}

export default CramSurface;
