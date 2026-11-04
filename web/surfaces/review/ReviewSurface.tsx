import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReviewCard, ReviewState, ReviewTreeResponse } from "../../../shared/types/index.ts";
import type { CardFaces } from "../../../shared/cards/card-tidy.ts";
import { registerKeys } from "../../capabilities/keys/registry.ts";
import { cardPrompt } from "../../capabilities/card/drill-order.ts";
import { facesOf } from "../../../shared/cards/faces.ts";
import { TOUCH, PHONE } from "../../platform/device.js";
import { courseOf } from "../../shell/format.js";
import { StrataAPI, StrataWhy, StrataWireDown } from "../../data/api.ts";
import { grades, reviewGradeRequest } from "../../data/entities/grades.ts";
import { afterGrade, shuffled } from "../../data/entities/review.ts";
import { end as arrived } from "../../platform/rum.ts";
import CardForm from "../../capabilities/card/CardForm.tsx";
import CardMeta from "../../capabilities/card/CardMeta.tsx";
import CardControls, { gradeActions } from "../../capabilities/card/CardControls.tsx";
import CardFace, { type FaceCard } from "../../capabilities/card/CardFace.tsx";
import Composer, { type ComposerProps } from "../../capabilities/card/Composer.tsx";
import type { ComposerDraft } from "../../capabilities/card/composing.ts";
import { loadSessionMap, sessionMapNow, type SessionMapProps } from "./session-map-load.ts";
import Ask from "../../capabilities/ask/Ask.tsx";
import { closeAsk, openAsk } from "../../capabilities/ask/control.ts";
import { cardThreadKey } from "../../capabilities/ask/threads.ts";
import { useProvideHere } from "../../shell/here.ts";
import CardHistory from "../../capabilities/card/CardHistory.tsx";
import ClaimTree, { Line } from "../../engines/tree/ClaimTree.tsx";

export type ReviewItem = ReviewCard & FaceCard;
export type OpenAt = { board: string; resource?: string | null };
interface Trees {
  known(slug: string): ReviewTreeResponse | null;
  read(slug: string): Promise<ReviewTreeResponse>;
}


function SessionMap(props: SessionMapProps) {
  const [chunk, setChunk] = useState(sessionMapNow);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!chunk) loadSessionMap().then(setChunk, () => setFailed(true)); }, []);
  return chunk ? <chunk.default {...props} />
    : failed ? <div className="rdone"><button className="lask-go" onClick={props.onClose}>{PHONE ? "done" : "back to the boards"}</button></div>
    : null;
}
const SESSION_MS = 5 * 60 * 1000;

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function WhereThisSits({ card, trees }: { card: ReviewItem; trees: Trees }) {
  const [tree, setTree] = useState<ReviewTreeResponse | null>(null);
  // one fetch per course for the sitting: a section's tree does not change mid-review
  useEffect(() => {
    if (!card || !card.course) return;
    const slug = card.course;
    const known = trees.known(slug);
    if (known) { setTree(known); return; }
    setTree(null);
    let live = true;
    trees.read(slug).then((r) => { if (live) setTree(r); }, () => {});
    return () => { live = false; };
  }, [card && card.course]);

  if (!tree || !tree.tree || !tree.tree.claims.length) return null;
  const here = typeof card.node === "string" ? card.node : null;
  return (
    <div className="rtree">
      <div className="rtree-h">
        <span className="rtree-lbl">where this sits</span>
        <span className="rtree-src">{tree.label || tree.courseTitle}</span>
      </div>
      {tree.tree.question ? <div className="smq-root"><Line text={tree.tree.question} max={PHONE ? 110 : 180} /></div> : null}
      <ClaimTree claims={tree.tree.claims} here={here} dim={false} />
      {!here ? <div className="rtree-no">this card was authored, not distilled — it has no place in this tree</div> : null}
    </div>
  );
}


function until(ts: number | null | undefined) {
  if (!ts) return "";
  const h = Math.max(0, (ts - Date.now()) / 36e5);
  if (h < 20) return "later today";
  if (h < 40) return "tomorrow";
  const d = Math.round(h / 24);
  if (d < 14) return `in ${d} days`;
  return `in ${Math.round(d / 7)} weeks`;
}

export interface ReviewProps {
  initial: ReviewState | null;
  onClose: () => void;
  onOpen?: ((at: OpenAt) => void) | null;
  composer: ComposerDraft | null;
  onNewCard?: ((card: ReviewItem | null, question?: string, answer?: string) => void) | null;
  onComposerSave: ComposerProps["onSave"];
  onComposerCancel: () => void;
  onEditSave: (card: ReviewItem, patch: CardFaces) => Promise<ReviewItem>;
  onDeleteCard?: ((card: ReviewItem) => unknown) | null;
}

interface Live {
  card: ReviewItem | null; answered: boolean; revealed: boolean; picked: number | null; ending: boolean;
  judged: number; editing: boolean; composing: boolean; left: number;
}

function ReviewSurface({ initial, onClose, onOpen, composer, onNewCard, onComposerSave, onComposerCancel, onEditSave, onDeleteCard }: ReviewProps) {
  // `initial` is home's fresh queue, so the first card draws with no round trip
  const [queue, setQueue] = useState<ReviewItem[] | null>(() => (initial ? (initial.cards.length ? shuffled(initial.cards) : []) : null));
  const [doneN, setDoneN] = useState(0);
  const [ending, setEnding] = useState(false);
  const [endsAt, setEndsAt] = useState<number | null>(() => (initial && initial.cards.length ? Date.now() + SESSION_MS : null));
  const [remaining, setRemaining] = useState(SESSION_MS);
  const [judged, setJudged] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [finished, setFinished] = useState<{ nextDueAt: number | null } | null>(() => (initial && !initial.cards.length ? { nextDueAt: initial.nextDueAt } : null));
  const [error, setError] = useState(false);
  const [dropped, setDropped] = useState("");
  const saveState = useSyncExternalStore(grades.subscribe, grades.getSnapshot);
  const live = useRef(true);
  const savingGrade = saveState.pending > 0;
  const gradeError = saveState.error ? StrataWhy(saveState.error, "Some reviews haven't saved yet. Retry before leaving.") : "";
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // an id, not a boolean: the queue can advance while an async save is in flight
  const [editing, setEditing] = useState<string | null>(null);

  const card = queue && queue.length ? queue[0] : null;
  useEffect(() => { if (card || finished) arrived("review.open"); }, [!!(card || finished)]);
  useEffect(() => { const t = setTimeout(() => loadSessionMap().catch(() => {}), 1000); return () => clearTimeout(t); }, []);
  const answered = revealed || picked !== null;
  const isEditing = !!(card && editing === card.id);

  // bound once, so it reads the present through a ref
  const ref = useRef({} as Live);
  ref.current = { card, answered, revealed, picked, ending, judged,
    editing: isEditing, composing: !!composer, left: queue ? queue.length : 0 };
  useProvideHere(() => {
    const c = ref.current.card;
    return { surface: "review", card: c ? { id: c.id, deck: c.course, course: c.course, role: "subject",
      prompt: cardPrompt(c) as string, rung: c.rung ?? null, picked: ref.current.picked ?? null, revealed: !!ref.current.answered } : null };
  });

  function endSession() {
    if (ref.current.ending || !ref.current.judged) {
      if (!grades.getSnapshot().pending) onClose();
      return;
    }
    setEnding(true);
    StrataAPI.log("review_end", { review: true, reason: "manual", judged: ref.current.judged, left: ref.current.left });
  }

  const started = (r: ReviewState) => StrataAPI.log("review_start", { review: true, due: r.total, cards: r.cards.length, minutes: SESSION_MS / 6e4 });
  function load(first: boolean) {
    StrataAPI.review().then((r) => {
      if (!live.current) return;
      if (r.cards.length) {
        setQueue(shuffled(r.cards));
        if (first) { setEndsAt(Date.now() + SESSION_MS); started(r); }
      } else { setQueue([]); setFinished({ nextDueAt: r.nextDueAt }); if (!first) StrataAPI.log("review_done", { review: true }); }
    }).catch(() => setError(true));
  }
  useEffect(() => {
    // release focus: an input behind the veil (the library's paste line) would swallow the keys
    try { const a = document.activeElement as HTMLElement | null; if (a && a !== document.body && a.blur) a.blur(); } catch (e) { /* no DOM */ }
    if (!initial) load(true);
    else if (initial.cards.length) started(initial);
  }, []);

  // Date.now rather than decrementing state, so the clock survives a sleeping tab
  useEffect(() => {
    if (!endsAt || ending || finished) return;
    const tick = () => {
      const left = Math.max(0, endsAt - Date.now());
      setRemaining(left);
      if (!left) {
        StrataAPI.log("review_nudge", { review: true, judged: ref.current.judged, left: ref.current.left });
        return false;
      }
      return true;
    };
    if (!tick()) return;
    const interval = window.setInterval(() => { if (!tick()) window.clearInterval(interval); }, 1000);
    return () => window.clearInterval(interval);
  }, [endsAt, ending, finished]);

  const shownAt = useRef(0);
  function logCard(event: string, extra?: Record<string, unknown>) {
    const c = ref.current.card; if (!c) return;
    StrataAPI.log(event, {
      review: true, deck: c.deck || null, card: c.id, type: c.type, rung: c.rung,
      ...(event === "card_show" || !shownAt.current ? {} : { ms: Date.now() - shownAt.current }),
      ...(extra || {}),
    });
  }
  useEffect(() => { shownAt.current = Date.now(); if (card) logCard("card_show"); }, [card && card.id, judged]);

  function reveal() {
    if (ref.current.answered || !ref.current.card) return;
    setRevealed(true); logCard("card_reveal");
  }
  function grade(got: boolean) {
    const c = ref.current.card;
    if (!c || !ref.current.answered) return;
    // pause on an unsaved grade: later verdicts must not run ahead of a lost one
    if (grades.getSnapshot().error) return;
    // offline the save path refuses writes, so the card stays on screen ungraded
    if (StrataWireDown()) { setDropped("offline: this card waits for the connection"); return; }
    const request = reviewGradeRequest(c, got, Date.now() - shownAt.current);
    grades.grade(request, (e) => { if (live.current) setDropped(StrataWhy(e, "a grade wasn't saved")); });
    // advance at once while the ordered saves run behind; seal this encounter until the next one draws
    ref.current.card = null;
    setRevealed(false); setPicked(null);
    setDoneN(n => request.got ? n + 1 : n); setJudged(n => n + 1);
    setQueue((qu) => (qu?.[0]?.id === c.id ? afterGrade(qu, c, request.got) : qu));
  }
  // ↵ reuses the tree read the reveal started, never a round trip of its own
  const treeReads = useRef<Record<string, Promise<ReviewTreeResponse>>>({});
  const treeKnown = useRef<Record<string, ReviewTreeResponse>>({});
  const [placed, setPlaced] = useState<Record<string, boolean>>({});
  const trees = useRef<Trees>({
    known: (slug) => treeKnown.current[slug] || null,
    read: (slug) => treeReads.current[slug] || (treeReads.current[slug] = StrataAPI.reviewTree(slug).then((t) => {
      treeKnown.current[slug] = t;
      if (live.current) setPlaced((p) => (slug in p ? p : { ...p, [slug]: !!(t && t.board) }));
      return t;
    }, (e) => { delete treeReads.current[slug]; throw e; })),
  }).current;
  function jump() {
    const c = ref.current.card;
    if (!c || !ref.current.answered || !onOpen) return;
    const go = (t: ReviewTreeResponse | null) => {
      if (!t || !t.board) { setDropped("this card is on no board"); return; }
      StrataAPI.log("jump_to_source", { review: true, card: c.id, deck: c.deck || null });
      onOpen({ board: t.board, resource: t.resource || null });
    };
    const known = trees.known(c.course);
    if (known) { go(known); return; }
    trees.read(c.course).then((t) => { if (live.current) go(t); },
      (e) => { if (live.current) setDropped(StrataWhy(e, "couldn't find where this card lives")); });
  }
  function pick(i: number) {
    const c = ref.current.card;
    if (!c || ref.current.picked !== null) return;
    setPicked(i); logCard("review_pick", { picked: i, hit: i === c.correct });
  }
  useEffect(() => { setEditing(null); }, [card && card.id]);
  function saveEdit(c: ReviewItem, patch: CardFaces) {
    const put = (card: ReviewItem) => setQueue((qu) => (qu || []).map((x) => (x.id === c.id ? { ...x, ...card } : x)));
    return onEditSave(c, patch).catch((e) => { if (e && e.theirs) put(e.theirs); throw e; }).then((merged) => {
      put(merged);
      // a late save must not close an editor since opened on another card
      setEditing((id) => (id === c.id ? null : id));
      StrataAPI.log("card_edit", { review: true, deck: c.deck || null, card: c.id, faces: Object.keys(patch).join(",") });
    });
  }

  async function deleteCard(c: ReviewItem) {
    await onDeleteCard!(c);
    if (ref.current.card && ref.current.card.id === c.id) {
      setRevealed(false); setPicked(null);
    }
    setQueue((qu) => (qu || []).filter((x) => x.id !== c.id));
    setEditing((id) => (id === c.id ? null : id));
  }

  // an effect, since updaters must stay pure; refetching before receipts would bring graded cards back
  useEffect(() => { if (queue && !queue.length && !finished && !savingGrade) load(false); }, [queue, finished, savingGrade]);
  function advance() {
    const c = ref.current.card; if (!c) return;
    if (!ref.current.answered && c.type !== "mcq") reveal();
  }

  // capture phase, so the room's bubble-phase handler never hears these keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      e.stopPropagation();
      const k = (e.key || "").toLowerCase();
      const c = ref.current.card;
      // the nested composer owns the keyboard even if its textarea briefly loses focus
      if (ref.current.composing) {
        if (k === "escape") { e.preventDefault(); onComposerCancel(); }
        return;
      }
      if (k === "escape" && ref.current.editing) { e.preventDefault(); setEditing(null); return; }
      if (k === "escape" && closeAsk()) { e.preventDefault(); return; }
      if (k === "escape") { e.preventDefault(); endSession(); return; }
      if (ref.current.ending || !c) return;
      if (k === "e" && !ref.current.editing && !grades.hasCard(c.id)) { e.preventDefault(); setEditing(c.id); return; }
      if (ref.current.editing) return;
      if (k === " ") { e.preventDefault(); advance(); return; }
      if (k === "/") { e.preventDefault(); openAsk(); return; }
      // !e.repeat: a held key must not answer and judge in one press
      if (c.type === "mcq" && ref.current.picked === null) {
        if (k >= "1" && k <= "4" && !e.repeat) { e.preventDefault(); pick(+k - 1); }
        return;
      }
      if (ref.current.answered && (k === "1" || k === "2") && !e.repeat) { e.preventDefault(); grade(k === "2"); return; }
      if (k === "enter" && ref.current.answered && !e.repeat) { e.preventDefault(); jump(); return; }
      if (!ref.current.answered && (k === "1" || k === "2") && !e.repeat) { e.preventDefault(); reveal(); return; }
    };
    return registerKeys({ screen: "review", over: true, owns: true, onKey });
  }, []);

  return (
    <div className="veil reviewv">
      <div className="rwrap">
        <div className="rhead">
          <span className="ltitle">{ending ? "Today" : "Review"}</span>
          <span className="lsub">{ending ? "where the reviewing went" : "today’s cards, every board"}</span>
          <span className="grow" />
          {!ending && card ? <span className={"rtimer" + (remaining <= 6e4 ? " low" : "")}
            title={remaining ? "five-minute review nudge" : "five minutes — keep going if you want"}>{clock(remaining)}</span> : null}
          {!composer && onNewCard ? <button className="seg" onClick={() => onNewCard(ending ? null : card)}
            title="make a card without leaving the review">new card</button> : null}
          <button className="seg" disabled={savingGrade && (ending || !card)} onClick={() => endSession()}
            title={ending ? "back to the boards (esc)" : judged ? "end the sitting and see the day (esc)" : "back to the boards (esc)"}>✕</button>
        </div>
        {gradeError ? <p role="alert">{gradeError} <button onClick={() => grades.retry()}>Retry saving reviews</button></p>
          : dropped ? <p className="rdropped" onClick={() => setDropped("")}>{dropped}</p> : null}
        {composer ? (
          <div className="rcard rcompose">
            <Composer front0={composer.front} answer={composer.answer} anchor={composer.anchor}
              closing={!!composer.mintId} review onSave={onComposerSave} onCancel={onComposerCancel} />
          </div>
        ) : error ? <div className="rdone"><div className="rdone-line">couldn’t load the review — the wire may be down</div></div>
        : queue === null ? null
        : (ending || !card) && savingGrade ? gradeError ? null : <div className="rdone"><div className="rdone-line" role="status">Finishing review…</div></div>
        : ending ? <SessionMap onClose={onClose} onOpen={onOpen} left={queue.length} />
        : card ? (
          <div className="rcard" onClick={TOUCH ? advance : undefined}>
            {/* the meta row eats its taps: on touch a tap anywhere on the card reveals */}
            <CardMeta card={card} from={PHONE ? courseOf(card.courseTitle) : card.courseTitle} where={card.courseTitle}
              editing={isEditing} canEdit={!grades.hasCard(card.id)} onEdit={(c) => setEditing(c.id)}
              revealed={answered} extra={{ review: true, rung: card.rung }} />
            {isEditing ? (
              <CardForm key={card.id} card={card} faces={facesOf(card.type)}
                onSave={(patch) => saveEdit(card, patch)} onCancel={() => setEditing(null)}
                onDelete={onDeleteCard ? () => deleteCard(card) : undefined} />
            ) : (<>
              <CardFace card={card} revealed={revealed} picked={picked} onPick={pick} />

              <CardControls
                actions={[
                  ...(answered && !gradeError ? gradeActions(grade) : []),
                  !answered && card.type !== "mcq" ? { id: "reveal", label: "reveal", kbd: "space", live: true, on: advance } : null,
                  answered && onOpen && placed[card.course] !== false ? { id: "jump", label: "go to where this lives", kbd: "↵", on: jump } : null,
                ]}
                hints={[!answered && card.type === "mcq" ? { id: "pick", text: "answer", kbd: "1–4" } : null]} />
            </>)}
            <div className="rule" />
            <div className="count">{queue.length} to go</div>
            <div className="rend" onClick={(e) => e.stopPropagation()}>
              <button className="rendb" onClick={() => endSession()}>{judged ? "end here — see the day" : "end here"}</button>
            </div>
            {answered ? <><CardHistory key={card.id} card={card} /><WhereThisSits card={card} trees={trees} /></> : null}
          </div>
        ) : finished && doneN ? <SessionMap onClose={onClose} onOpen={onOpen} left={0} when={until(finished.nextDueAt)} />
        : finished ? (
          <div className="rdone">
            <div className="rdone-mark">✓</div>
            <div className="rdone-line">nothing due right now</div>
            {finished.nextDueAt ? <div className="rdone-when">next cards {until(finished.nextDueAt)}</div> : null}
            <button className="lask-go" onClick={onClose}>{PHONE ? "done" : "back to the boards"}</button>
          </div>
        ) : null}
      </div>
      {/* one Ask per card (key), so a thread left open doesn't open over the next card */}
      {card && !finished ? <Ask key={card.id} thread={cardThreadKey(card.course, card.id)} name="this card’s thread"
        placeholder="ask about this card…" locked={answered ? null : "turn the card over to ask about it"}
        onCompose={onNewCard ? (q, a) => onNewCard(card, q, a) : null}
        feedback={{ board: null, card: card.id, deck: card.deck, context: { review: true, card } }} /> : null}
    </div>
  );
}

export default ReviewSurface;
