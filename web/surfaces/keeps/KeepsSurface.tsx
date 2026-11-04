/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import type ReactNS from "react";
import type { DragEvent, MouseEvent, ReactNode } from "react";
import type { BoardState, CollectionGroup, LibraryBoard, Minted, Pair, ReviewTreeResponse, SessionClaim } from "../../../shared/types/index.ts";
import type { CardFaces } from "../../../shared/cards/card-tidy.ts";
import type { registerKeys as RegisterKeys } from "../../capabilities/keys/registry.ts";
import type { StrataAPI as API, StrataWhy as Why } from "../../data/api.ts";
import type { cardPrompt as CardPrompt } from "../../capabilities/card/drill-order.ts";
import type { facesOf as FacesOf } from "../../../shared/cards/faces.ts";
import type { ago as Ago } from "../../shell/format.js";
import type { nest as Nest, Line as LineT, Nested } from "../../engines/tree/ClaimTree.tsx";
import type { liftSynthesis as LiftSynthesis } from "../../engines/tree/tree.ts";
import type { default as CardFormT, EditButton as EditButtonT, Preview as PreviewT } from "../../capabilities/card/CardForm.tsx";
import type { FaceCard } from "../../capabilities/card/CardFace.tsx";
import type { default as CardHistoryT } from "../../capabilities/card/CardHistory.tsx";
import type { default as CardDeletedT } from "../../capabilities/card/CardDeleted.tsx";
import type { deckOf as DeckOf, saveAuthored as SaveAuthored } from "../../capabilities/card/saveCard.ts";
import type { default as FeedbackNoteT } from "../../capabilities/feedback/FeedbackNote.tsx";
import type { default as AskT, Compose } from "../../capabilities/ask/Ask.tsx";
import type { useProvideHere as UseProvideHere } from "../../shell/here.ts";
import type { useEntity as UseEntity } from "../../data/store.ts";
import type { holdKeeps as HoldKeeps, keeps as Keeps, keepsKey as KeepsKey, KeptSet } from "../../data/entities/keeps.ts";

// lazy chunk: import only types, or esbuild hoists shared code into the boot bundle; deps come via bind()
export interface KeepsHost {
  React: typeof ReactNS;
  registerKeys: typeof RegisterKeys; StrataAPI: typeof API; StrataWhy: typeof Why;
  cardPrompt: typeof CardPrompt; facesOf: typeof FacesOf; ago: typeof Ago;
  nest: typeof Nest; Line: typeof LineT; liftSynthesis: typeof LiftSynthesis;
  CardForm: typeof CardFormT; EditButton: typeof EditButtonT; Preview: typeof PreviewT;
  CardHistory: typeof CardHistoryT; CardDeleted: typeof CardDeletedT; deckOf: typeof DeckOf; saveAuthored: typeof SaveAuthored;
  FeedbackNote: typeof FeedbackNoteT; Ask: typeof AskT; useProvideHere: typeof UseProvideHere;
  useEntity: typeof UseEntity; holdKeeps: typeof HoldKeeps; keeps: typeof Keeps; keepsKey: typeof KeepsKey;
}
let React: typeof ReactNS, Fragment: typeof ReactNS.Fragment;
let useState: typeof ReactNS.useState, useEffect: typeof ReactNS.useEffect, useRef: typeof ReactNS.useRef;
let registerKeys: typeof RegisterKeys, StrataAPI: typeof API, StrataWhy: typeof Why;
let cardPrompt: typeof CardPrompt, facesOf: typeof FacesOf, ago: typeof Ago;
let nest: typeof Nest, Line: typeof LineT, liftSynthesis: typeof LiftSynthesis;
let CardForm: typeof CardFormT, EditButton: typeof EditButtonT, Preview: typeof PreviewT;
let CardHistory: typeof CardHistoryT, CardDeleted: typeof CardDeletedT, deckOf: typeof DeckOf, saveAuthored: typeof SaveAuthored;
let FeedbackNote: typeof FeedbackNoteT, Ask: typeof AskT, useProvideHere: typeof UseProvideHere;
let useEntity: typeof UseEntity, holdKeeps: typeof HoldKeeps, keeps: typeof Keeps, keepsKey: typeof KeepsKey;
export function bind(host: KeepsHost) {
  ({ React, registerKeys, StrataAPI, StrataWhy, cardPrompt, facesOf, ago, nest, Line, liftSynthesis, CardForm, EditButton, Preview,
    CardHistory, CardDeleted, deckOf, saveAuthored, FeedbackNote, Ask, useProvideHere, useEntity, holdKeeps, keeps, keepsKey } = host);
  // the host's React, so hooks share one instance
  ({ Fragment, useState, useEffect, useRef } = React);
}

const NO_IDS: string[] = [];

export type KeepCard = FaceCard & { id: string; deck?: string; edited?: unknown; authored?: unknown };
export interface Spot { id: string; side: string }
export interface KeepsCommon {
  onBoardState?: ((state: BoardState) => void) | null;
  onDeckChanged?: ((slug: string) => void) | null;
  editing: Spot | null;
  setEditing: (e: Spot | null) => void;
  onEditSave: (card: KeepCard, patch: CardFaces) => Promise<KeepCard | null | undefined>;
  onDeleteCard?: ((card: KeepCard) => unknown) | null;
  onRestoreCard: (card: KeepCard) => unknown;
  onCompose: Compose;
  onClose: () => void;
}

const Reading = ({ what, line }: { what: string; line: string }) => (
  <div className="bench">
    <div className="sh-head"><span className="sh-what">keeps — {what}</span></div>
    <div className="bench-body"><div className="kp-quiet" style={{ padding: "14px 20px" }}>{line}</div></div>
  </div>
);

function KeepsAsk({ boardId, onCompose }: { boardId: string | null; onCompose: Compose }) {
  useProvideHere(() => ({ surface: "keeps", board: boardId || null }));
  return <Ask lazy thread={boardId ? `board:${boardId}` : "library"} name={boardId ? "this board’s thread" : "the library’s thread"}
    placeholder="ask about these cards…" onCompose={onCompose} feedback={{ board: boardId || null }} />;
}

interface EditingRowProps {
  card: KeepCard;
  onSave: (patch: CardFaces) => unknown;
  onCancel: () => void;
  onDelete?: ((card: KeepCard) => unknown) | null;
}

function EditingRow({ card, onSave, onCancel, onDelete }: EditingRowProps) {
  return (
    <div className="kpcard edit">
      <CardForm card={card} faces={facesOf(card.type)} onSave={onSave} onCancel={onCancel}
        onDelete={onDelete && deckOf(card) ? () => onDelete(card) : undefined} />
    </div>
  );
}
const CardNote = ({ card, board }: { card: KeepCard; board?: string | null }) => (
  <span onClick={(e) => e.stopPropagation()}>
    <FeedbackNote key={card.id} payload={{ kind: "card", board: board || null, card: card.id, deck: card.deck,
      context: { front: cardPrompt(card), type: card.type, where: "keeps", card } }} />
  </span>
);
interface GoneOptions extends Pick<KeepsCommon, "onDeleteCard" | "onRestoreCard" | "setEditing"> {
  reread: () => unknown;
  onGone?: (card: KeepCard) => unknown;
}
interface Gone {
  gone: Record<string, true>;
  del: ((card: KeepCard) => Promise<void>) | null;
  row: (card: KeepCard) => ReactNode;
}

function useGone({ onDeleteCard, onRestoreCard, setEditing, reread, onGone }: GoneOptions): Gone {
  const [gone, setGone] = useState<Record<string, true>>({});
  const del = (c: KeepCard) => Promise.resolve(onDeleteCard!(c)).then(() => {
    setGone((g) => ({ ...g, [c.id]: true }));
    setEditing(null);
    if (onGone) onGone(c);
  });
  const restore = (c: KeepCard) => Promise.resolve(onRestoreCard(c)).then(() => {
    reread();
    setGone((g) => { const n = { ...g }; delete n[c.id]; return n; });
  });
  const row = (c: KeepCard) => (c.id in gone ? <CardDeleted key={c.id} onRestore={() => restore(c)} /> : null);
  return { gone, del: onDeleteCard ? del : null, row };
}

function ReadButton({ open, onClick }: { open: boolean; onClick: (e: MouseEvent<HTMLButtonElement>) => void }) {
  return <button type="button" className={"ced-b rd" + (open ? " on" : "")}
    title={open ? "fold the card away" : "read the whole card — both faces, as the drill draws them"}
    onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{open ? "close" : "read"}</button>;
}
const CardRead = ({ card }: { card: KeepCard }) => (
  <div className="kpread"><Preview fields={facesOf(card.type)} draft={card} label={null} />
    {deckOf(card) ? <CardHistory card={{ id: card.id, course: deckOf(card) }} /> : null}</div>
);

interface KeptRowProps extends Pick<KeepsCommon, "editing" | "setEditing"> {
  card: KeepCard;
  side: string;
  reading: Spot | null;
  setReading: (r: Spot | null) => void;
  onSave: (card: KeepCard, patch: CardFaces) => unknown;
  onTakeBack: () => void;
  backTitle: string;
  board?: string | null;
  gone: Gone;
}

function KeptRow({ card, side, editing, setEditing, reading, setReading, onSave, onTakeBack, backTitle, board, gone }: KeptRowProps) {
  const deleted = gone.row(card);
  if (deleted) return deleted;
  if (editing && editing.id === card.id && editing.side === side)
    return <EditingRow card={card} onSave={(patch) => onSave(card, patch)} onCancel={() => setEditing(null)}
      onDelete={gone.del} />;
  const open = !!(reading && reading.id === card.id && reading.side === side);
  return (
    <>
      <div className="kpcard on" title="kept — click to hand it back"
        onClick={(e) => { e.stopPropagation(); onTakeBack(); }}>
        <span className="kppin">●</span>
        <span className="kpq"><Line text={cardPrompt(card)} /></span>
        <ReadButton open={open} onClick={(e) => { e.stopPropagation(); setReading(open ? null : { id: card.id, side }); }} />
        <EditButton edited={!!card.edited} onClick={(e) => { e.stopPropagation(); setEditing({ id: card.id, side }); }} />
        <CardNote card={card} board={board} />
        <button className="kpback" title={backTitle} onClick={(e) => { e.stopPropagation(); onTakeBack(); }}>↩</button>
      </div>
      {open ? <CardRead card={card} /> : null}
    </>
  );
}

interface CoverageRowProps {
  label: string; kept: number; total: number;
  middle: string;
  benched: boolean; lastKeepAt: number | null;
  what: string;
  onOpen: () => void;
}

function CoverageRow({ label, kept, total, middle, benched, lastKeepAt, what, onOpen }: CoverageRowProps) {
  return (
    <div className={"bcov" + (benched ? "" : " dark")}
      title={benched ? `open this ${what}'s keeps` : `never curated — open this ${what}'s keeps and decide`}
      onClick={onOpen}>
      <span className="bcov-label"><Line text={label} /></span>
      <span className="bcov-stats">
        {"★" + kept + "/" + total}
        {middle}
        {" · "}
        {!benched ? "never curated" : lastKeepAt ? "last curated " + ago(lastKeepAt) : "curated — nothing kept"}
      </span>
    </div>
  );
}

interface KeepOpsOptions extends Pick<KeepsCommon, "onBoardState" | "onDeckChanged"> {
  refetch: () => unknown;
  setErr: (err: string | null) => void;
}

function useKeepOps({ onBoardState, onDeckChanged, refetch, setErr }: KeepOpsOptions) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const settle = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refetch, 800);
  };
  function unkeep(deck: string, id: string, applyLocal: () => void) {
    setErr(null);
    applyLocal();
    keeps.toggle(deck, id, false)
      .then((r) => {
        if (r.state) {
          if (onBoardState) onBoardState(r.state);
          if (onDeckChanged) onDeckChanged(deck);
        }
        settle();
      })
      .catch((e) => { setErr(StrataWhy(e, "that take-back didn't land")); refetch(); });
  }
  return { unkeep };
}

const makeSaveEdit = (onEditSave: KeepsCommon["onEditSave"], setEditing: KeepsCommon["setEditing"], patchLocal: (id: string, merged: KeepCard) => void) =>
  (c: KeepCard, patch: CardFaces) =>
  Promise.resolve(onEditSave(c, patch)).then((merged) => {
    if (merged) patchLocal(c.id, merged);
    setEditing(null);
  });

export interface DeckKeepsProps extends KeepsCommon {
  slug: string;
  title: string;
  minted: Minted[] | null;
  pairs: Pair[] | null;
  boardId: string | null;
  composing: boolean;
}
interface DeckRow { key: string; keep: () => void; edit: (() => void) | null }

function DeckKeeps({ slug, title, minted, pairs, boardId, onBoardState, onDeckChanged, editing, setEditing, onEditSave, onDeleteCard, onRestoreCard, onCompose, composing, onClose }: DeckKeepsProps) {
  const [cards, setCards] = useState<KeepCard[] | null>(null);
  const [tree, setTree] = useState<ReviewTreeResponse | null>(null);
  const keptIds = useEntity<KeptSet, string[]>(keepsKey(slug), (v) => (v && v.ids) || NO_IDS);
  const [reading, setReading] = useState<Spot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragOn, setDragOn] = useState(false);
  const [cur, setCur] = useState<string | null>(null);
  const rereadKeeps = () => StrataAPI.deckKeeps(slug).then((r) => holdKeeps(slug, r)).catch(() => {});
  const gone = useGone({ onDeleteCard, onRestoreCard, setEditing, reread: rereadKeeps, onGone: rereadKeeps });
  // capture phase so the room never hears j/k/↵; must stay above the loading return (rules of hooks)
  const rowsRef = useRef<DeckRow[]>([]);
  const keyRef = useRef({} as { cur: string | null; editing: Spot | null; composing: boolean });
  keyRef.current = { cur, editing, composing };
  // functional update: the handler's closure is from the first render
  const toggleRead = (row: DeckRow) => setReading((r) => (r && r.id === row.key && r.side === "deck" ? null : { id: row.key, side: "deck" }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (keyRef.current.editing || keyRef.current.composing) return;
      const rows = rowsRef.current; if (!rows.length) return;
      const k = e.key;
      const i = rows.findIndex((r) => r.key === keyRef.current.cur);
      const go = (j: number) => { e.preventDefault(); e.stopPropagation(); setCur(rows[Math.max(0, Math.min(rows.length - 1, j))].key); };
      if (k === "ArrowDown" || k === "j") { go(i < 0 ? 0 : i + 1); return; }
      if (k === "ArrowUp" || k === "k") { go(i < 0 ? 0 : i - 1); return; }
      if (i < 0) { if (k === "e") { e.preventDefault(); e.stopPropagation(); } return; }
      // check the code too: some keyboards (and automation) name the key differently
      if (k === "Enter" || e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); e.stopPropagation(); toggleRead(rows[i]); return; }
      if (k === "s" || k === "S") { e.preventDefault(); e.stopPropagation(); rows[i].keep(); }
      if (k === "e") { e.preventDefault(); e.stopPropagation(); if (rows[i].edit) rows[i].edit(); }
    };
    return registerKeys({ screen: "keeps", over: true, onKey });
  }, []);
  useEffect(() => {
    if (!cur) return;
    const el = document.querySelector(`.bench-deck [data-row="${CSS.escape(cur)}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [cur]);
  const [fetchedQ, setFetchedQ] = useState<{ minted: Minted[]; pairs: Pair[] } | null>(null);
  useEffect(() => {
    if (minted != null) return;
    let live = true;
    StrataAPI.getBoard(boardId!)
      .then((r) => { if (live) setFetchedQ({ minted: r.minted || [], pairs: r.pairs || [] }); })
      .catch(() => { if (live) setFetchedQ({ minted: [], pairs: [] }); });
    return () => { live = false; };
  }, [slug]);
  const allQuestions = minted != null ? minted : ((fetchedQ && fetchedQ.minted) || []);
  const pairList = pairs != null ? pairs : ((fetchedQ && fetchedQ.pairs) || []);
  const pairRes = new Map(pairList.map((p) => [p.id, p.resourceId]));
  const deckRids = new Set<string | null | undefined>(pairList
    .filter((p) => p.deck && String(p.deck).split("/")[0] === slug)
    .map((p) => p.resourceId).filter(Boolean));
  const questions = deckRids.size
    ? allQuestions.filter((m) => m.pairId && deckRids.has(pairRes.get(m.pairId)))
    : allQuestions;
  const tookState = (r: { state?: BoardState }) => { if (minted == null && r.state) setFetchedQ({ minted: r.state.minted || [], pairs: r.state.pairs || [] }); };

  useEffect(() => {
    let live = true;
    setCards(null); setTree(null); setErr(null);
    Promise.all([
      StrataAPI.deck(slug),
      StrataAPI.reviewTree(slug).catch(() => null),
      // on a failed read keep the current set; an empty one would show nothing kept
      StrataAPI.deckKeeps(slug).catch(() => null),
    ]).then(([d, t, k]) => {
      if (!live) return;
      const cs = (d.cards || []).slice().sort((a, b) => (a.ord || 0) - (b.ord || 0));
      setCards(cs); setTree(t); if (k) holdKeeps(slug, k);
      // no board: choosing what to keep must not reorder the launcher
      StrataAPI.log("bench_open", { deck: slug, cards: cs.length, tree: !!(t && t.tree) });
    }).catch((e) => { if (live) { setCards([]); setErr(StrataWhy(e, "couldn't read the deck")); } });
    return () => { live = false; };
  }, [slug]);

  function post(id: string, keep: boolean) {
    setErr(null);
    keeps.toggle(slug, id, keep)
      .then((r) => {
        if (r.state) {
          setCards((cs) => cs!.filter((c) => !(c.authored && !keep && c.id === id)));
          tookState(r);
          if (onBoardState) onBoardState(r.state);
          if (onDeckChanged) onDeckChanged(slug);
        }
      })
      .catch((e) => {
        setErr(StrataWhy(e, "that keep didn't land"));
        StrataAPI.deckKeeps(slug).then((r) => holdKeeps(slug, r)).catch(() => {});
      });
  }

  // only append if the card is ours; a question already in another deck answers 400
  function keepQuestion(m: Minted) {
    setErr(null);
    keeps.keepQuestion(slug, boardId!, m.id)
      .then((r) => {
        if (r.card && String(r.card.id).split("/")[0] === slug)
          setCards((cs) => (cs!.some((x) => x.id === r.card.id) ? cs : cs!.concat([r.card])));
        tookState(r);
        if (r.state && onBoardState) onBoardState(r.state);
        if (onDeckChanged) onDeckChanged(slug);
      })
      .catch((e) => setErr(StrataWhy(e, "that keep didn't land")));
  }

  const saveEdit = makeSaveEdit(onEditSave, setEditing, (id, merged) =>
    setCards((cs) => cs!.map((x) => (x.id === id ? { ...x, ...merged } : x))));
  function saveMint(m: Minted, patch: CardFaces) {
    return saveAuthored(boardId!, m.id, patch).then((r) => {
      tookState(r as { state?: BoardState });
      if (r.state && onBoardState) onBoardState(r.state as BoardState);
      setEditing(null);
    });
  }

  if (cards === null) return <Reading what={title || slug} line="reading the deck…" />;

  const kept = new Set(keptIds);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const treeClaims = tree && tree.tree && tree.tree.claims && tree.tree.claims.length ? tree.tree.claims : null;
  const claimIds = new Set((treeClaims || []).map((c) => c.id));
  const terms = cards.filter((c) => c.introduces && !c.authored);
  const placed = new Map<string, KeepCard[]>();
  const loose: KeepCard[] = [];
  for (const c of cards) {
    if (c.introduces || c.authored) continue;
    const node = typeof c.node === "string" && claimIds.has(c.node) ? c.node : null;
    if (!node) { loose.push(c); continue; }
    if (!placed.has(node)) placed.set(node, []);
    placed.get(node)!.push(c);
  }
  const claims = treeClaims && placed.size ? treeClaims : null;

  const keptUnder = (node: string) => (placed.get(node) || []).filter((c) => kept.has(c.id));
  const ideas = claims ? claims.filter((c) => keptUnder(c.id).length > 0).length : 0;
  const keptN = keptIds.reduce((n, id) => n + (byId.has(id) ? 1 : 0), 0);

  function tapCard(c: KeepCard) {
    post(c.id, !kept.has(c.id));
  }

  const editHere = (c: KeepCard, side: string) => editing && editing.id === c.id && editing.side === side;
  const readHere = (id: string, side: string) => !!(reading && reading.id === id && reading.side === side);
  const readToggle = (id: string, side: string) => (e: MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); setReading(readHere(id, side) ? null : { id, side }); };

  const deckRows: DeckRow[] = [];
  rowsRef.current = deckRows;
  const noteRow = (key: string, keep: () => void, edit: (() => void) | null) => { deckRows.push({ key, keep, edit }); return key; };

  const questionRow = (m: Minted) => {
    const home = m.cardId ? String(m.cardId).split("/")[0] : null;
    const foreign = !!(home && home !== slug);
    const isKept = !!(m.cardId && !foreign && kept.has(m.cardId));
    const open = m.state !== "closed";
    const pseudo: KeepCard = { id: "mint:" + m.id, type: "flashcard", front: m.front, back: m.back || "" };
    if (!isKept && !foreign && editHere(pseudo, "band"))
      return <EditingRow key={m.id} card={pseudo} onSave={(patch) => saveMint(m, patch)} onCancel={() => setEditing(null)} />;
    const rd = readHere(pseudo.id, "deck");
    const keep = () => {
      if (foreign) return;
      if (isKept) { post(m.cardId!, false); return; }
      if (open) { setErr("that one is still open — close it in the drill first (a card closes on your sentence)"); return; }
      keepQuestion(m);
    };
    noteRow(pseudo.id, keep, !isKept && !foreign ? () => setEditing({ id: pseudo.id, side: "band" }) : null);
    return (
      <Fragment key={m.id}>
      <div className={"kpcard" + (isKept || foreign ? " on held" : open ? " kpopen" : "") + (cur === pseudo.id ? " cur" : "")}
        data-row={pseudo.id}
        title={rd ? "click to fold the card away" : "click to read the whole question — the ○ at its left keeps it"}
        onClick={(e) => { e.stopPropagation(); setCur(pseudo.id); setReading(rd ? null : { id: pseudo.id, side: "deck" }); }}>
        <button type="button" className="kppin"
          title={isKept ? "kept — it is a real card of this deck now; click to make it a question again"
            : foreign ? `kept into ${home} — a question has one home; take it back from that bench`
            : open ? "still open — close it in the drill first (a card closes on your sentence)"
            : "keep this question — it becomes a real card of this deck, and the ladder can finally hold it (s)"}
          disabled={foreign}
          onClick={(e) => { e.stopPropagation(); setCur(pseudo.id); keep(); }}>{isKept || foreign ? "●" : open ? "…" : "○"}</button>
        <span className="kpq"><Line text={m.front} /></span>
        {foreign ? <span className="kpfrom" title="its card lives in another deck">kept · {home}</span> : null}
        {m.deck ? <span className="kpfrom" title={"filed under “" + m.deck + "” — a way of looking, not a home; kept, it lives here"}>{m.deck}</span> : null}
        {open ? <span className="kpfrom">open</span> : null}
        <ReadButton open={rd} onClick={readToggle(pseudo.id, "deck")} />
        {!isKept && !foreign
          ? <EditButton edited={false} onClick={(e) => { e.stopPropagation(); setEditing({ id: "mint:" + m.id, side: "band" }); }} />
          : null}
      </div>
      {rd ? <CardRead card={pseudo} /> : null}
      </Fragment>
    );
  };

  const cardRow = (c: KeepCard) => {
    const deleted = gone.row(c);
    if (deleted) return deleted;
    if (editHere(c, "deck"))
      return <EditingRow key={c.id} card={c} onSave={(patch) => saveEdit(c, patch)} onCancel={() => setEditing(null)}
        onDelete={gone.del} />;
    const on = kept.has(c.id);
    const rd = readHere(c.id, "deck");
    noteRow(c.id, () => tapCard(c), () => setEditing({ id: c.id, side: "deck" }));
    return (
      <Fragment key={c.id}>
      <div className={"kpcard" + (on ? " on held" : "") + (cur === c.id ? " cur" : "")}
        data-row={c.id}
        title={rd ? "click to fold the card away" : "click to read the whole card — the ○ at its left keeps it"}
        draggable={!on}
        onDragStart={(e) => { try { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "copy"; } catch (x) { /* not a browser that drags */ } }}
        onClick={(e) => { e.stopPropagation(); setCur(c.id); setReading(rd ? null : { id: c.id, side: "deck" }); }}>
        <button type="button" className="kppin" title={on ? "kept — spoken for; click to let it go (s)" : "keep this card (s)"}
          onClick={(e) => { e.stopPropagation(); setCur(c.id); tapCard(c); }}>{on ? "●" : "○"}</button>
        <span className="kpq"><Line text={cardPrompt(c)} /></span>
        <ReadButton open={rd} onClick={readToggle(c.id, "deck")} />
        <EditButton edited={!!c.edited} onClick={(e) => { e.stopPropagation(); setEditing({ id: c.id, side: "deck" }); }} />
        <CardNote card={c} board={boardId} />
      </div>
      {rd ? <CardRead card={c} /> : null}
      </Fragment>
    );
  };

  const claimNode = (c: Nested<SessionClaim>, noKids?: boolean): ReactNode => {
    const held = keptUnder(c.id);
    const lit = held.length > 0;
    const cs = placed.get(c.id) || [];
    return (
      <li key={c.id} className={"smnode kpnode" + (lit ? " lit" : "")}>
        <div className="smclabel kpclaim">
          <span className="smcid">{String(c.id).replace(/^n/, "")}</span>
          <span className="smctext"><Line text={c.label} /></span>
          {lit ? <span className="kpheld">kept{held.length > 1 ? " ×" + held.length : ""}</span> : null}
        </div>
        {cs.map(cardRow)}
        {c.children.length && !noKids
          ? <ul className="smtree sub">{c.children.map((k) => claimNode(k))}</ul>
          : null}
      </li>
    );
  };
  const { root: synth, pillars } = claims ? liftSynthesis(nest(claims)) : { root: null, pillars: [] };
  // rows are pushed while drawing, so reset the ref before the draw
  deckRows.length = 0;

  function dropKeep(e: DragEvent<HTMLDivElement>) {
    e.preventDefault(); setDragOn(false);
    let id = "";
    try { id = e.dataTransfer.getData("text/plain"); } catch (x) { /* nothing riding it */ }
    if (id && byId.has(id) && !kept.has(id)) post(id, true);
  }

  return (
    <div className="bench">
      <div className="sh-head">
        <span className="sh-what">keeps — {(tree && tree.label) || title || slug}</span>
        <span className="grow" />
        <span className="sh-note">
          {claims ? `${ideas} idea${ideas === 1 ? "" : "s"} · ` : ""}{keptN} kept of {cards.length}
        </span>
        <button className="sh-back" onClick={onClose} title="back to the card (esc, or r again)">done ›</button>
      </div>
      {err ? <div className="kp-err" style={{ padding: "8px 20px 0" }}>{err}</div> : null}
      <div className="bench-body">
        <div className={"bench-keep" + (dragOn ? " over" : "")}
          onDragOver={(e) => { e.preventDefault(); if (!dragOn) setDragOn(true); }}
          // dragleave also fires when entering a child; only clear when leaving the pane itself
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOn(false); }}
          onDrop={dropKeep}>
          <div className="bn-h">
            keeping {keptN}{claims ? ` · ${ideas} idea${ideas === 1 ? "" : "s"}` : ""}
          </div>
          <div className="kp-why">what lands here is what the review will owe — the rest was processing</div>
          {keptIds.map((id) => {
            const c = byId.get(id);
            if (!c) return null;
            return <KeptRow key={id} card={c} side="keep" editing={editing} setEditing={setEditing}
              reading={reading} setReading={setReading} board={boardId} gone={gone}
              onSave={saveEdit} onTakeBack={() => post(id, false)} backTitle="back to the deck — not kept after all" />;
          })}
          {!keptN
            ? <div className="kp-quiet">nothing kept yet — click a card on the right (or drag it over) and it lands here</div>
            : null}
        </div>
        <div className="bench-deck">
          <div className="bn-h">
            the whole deck · {cards.length} card{cards.length === 1 ? "" : "s"}
            {questions.length ? ` · ${questions.length} question${questions.length === 1 ? "" : "s"} of yours` : ""}
          </div>
          {claims && tree!.tree!.question ? <div className="smq-root"><Line text={tree!.tree!.question} max={150} /></div> : null}
          {questions.length ? (
            <div className="kp-band">
              <div className="kp-bandl">your cards — asked {deckRids.size ? "over this deck’s source" : "on this board"}; keeping one makes it a card of this deck</div>
              {questions.map(questionRow)}
            </div>
          ) : null}
          {terms.length ? (
            <div className="kp-band">
              <div className="kp-bandl">terms — not claims, kept one by one</div>
              {terms.map(cardRow)}
            </div>
          ) : null}
          {claims && synth ? (
            <div className="kp-band kp-synth">
              <div className="kp-bandl">the whole — the source in one claim</div>
              <ul className="smtree kptree">{claimNode(synth, true)}</ul>
            </div>
          ) : null}
          {claims
            ? <ul className="smtree kptree">{pillars.map((c) => claimNode(c))}</ul>
            : <>
                <div className="kp-quiet">{treeClaims ? "the tree never met these cards — cards only" : "no tree here — cards only"}</div>
                {cards.filter((c) => !c.introduces && !c.authored).map(cardRow)}
              </>}
          {claims && loose.length ? (
            <div className="kp-band">
              <div className="kp-bandl">loose — no claim holds these</div>
              {loose.map(cardRow)}
            </div>
          ) : null}
          {!cards.length ? <div className="kp-quiet">nothing in this deck to keep</div> : null}
        </div>
      </div>
      <KeepsAsk boardId={boardId} onCompose={onCompose} />
      <div className="sh-foot"><kbd>↓</kbd><kbd>↑</kbd> through the deck · <kbd>↵</kbd> read · <kbd>s</kbd> keep · <kbd>e</kbd> rewrite · <kbd>esc</kbd> done — only kept cards return for review</div>
    </div>
  );
}

export interface BoardKeepsProps extends KeepsCommon {
  boardId: string;
  title: string;
  onOpenDeck: (slug: string, label: string) => void;
}

export function BoardKeeps({ boardId, title, onOpenDeck, onBoardState, onDeckChanged, editing, setEditing, onEditSave, onDeleteCard, onRestoreCard, onCompose, onClose }: BoardKeepsProps) {
  const [groups, setGroups] = useState<CollectionGroup[] | null>(null);
  const [reading, setReading] = useState<Spot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refetch = () => StrataAPI.boardCollection(boardId)
    .then((r) => setGroups(r.groups || [])).catch(() => {});
  const ops = useKeepOps({ onBoardState, onDeckChanged, refetch, setErr });
  const gone = useGone({ onDeleteCard, onRestoreCard, setEditing, reread: refetch });

  useEffect(() => {
    let live = true;
    setGroups(null); setErr(null);
    StrataAPI.boardCollection(boardId)
      .then((r) => { if (live) setGroups(r.groups || []); })
      .catch((e) => { if (live) { setGroups([]); setErr(StrataWhy(e, "couldn't read the board")); } });
    // `at`, not `board`: /api/log bumps touched_at for a board, and this must not reorder the launcher
    StrataAPI.log("bench_board_open", { at: boardId });
    return () => { live = false; };
  }, [boardId]);

  const takeBack = (g: CollectionGroup, id: string) => ops.unkeep(g.deck, id, () =>
    setGroups((gs) => gs!.map((x) => (x.deck === g.deck ? { ...x, cards: x.cards.filter((c) => c.id !== id), kept: Math.max(0, x.kept - 1) } : x))));

  const saveEdit = makeSaveEdit(onEditSave, setEditing, (id, merged) =>
    setGroups((gs) => gs!.map((g) => ({ ...g, cards: g.cards.map((x) => (x.id === id ? { ...x, ...merged } : x)) }))));

  if (groups === null) return <Reading what={title || "the board"} line="reading the board…" />;

  const keptN = groups.reduce((n, g) => n + g.kept, 0);
  const ideasN = groups.reduce((n, g) => n + (g.ideasKept || 0), 0);
  const curatedN = groups.filter((g) => g.kept > 0).length;

  return (
    <div className="bench">
      <div className="sh-head">
        <span className="sh-what">keeps — {title || "the board"} · the whole board</span>
        <span className="grow" />
        <span className="sh-note">
          keeping {keptN}{ideasN ? ` · ${ideasN} idea${ideasN === 1 ? "" : "s"}` : ""} · across {curatedN} of {groups.length} deck{groups.length === 1 ? "" : "s"}
        </span>
        <button className="sh-back" onClick={onClose} title="back to the room (esc, or r again)">done ›</button>
      </div>
      {err ? <div className="kp-err" style={{ padding: "8px 20px 0" }}>{err}</div> : null}
      <div className="bench-body">
        <div className="bench-keep">
          <div className="bn-h">the collection — what this board keeps</div>
          <div className="kp-why">grouped the way the board reads — take one back from here, and its deck lets it go</div>
          {groups.filter((g) => g.cards.length).map((g) => (
            <div key={g.deck} className="bkgroup">
              <div className="bkg-h">{g.label} <span className="bkg-n">{g.kept}</span></div>
              {g.cards.map((c) => (
                <KeptRow key={c.id} card={c} side="board" editing={editing} setEditing={setEditing}
                  reading={reading} setReading={setReading} board={boardId} gone={gone}
                  onSave={saveEdit} onTakeBack={() => takeBack(g, c.id)} backTitle="back to its deck — not kept after all" />
              ))}
            </div>
          ))}
          {!keptN ? <div className="kp-quiet">nothing kept on this board yet — the rows on the right are where that changes</div> : null}
        </div>
        <div className="bench-deck">
          <div className="bn-h">the board's decks · {groups.length} — dark rows the bench has never seen</div>
          {groups.map((g) => (
            <CoverageRow key={g.deck} label={g.label} kept={g.kept} total={g.total}
              middle={g.ideasTotal != null ? ` · ${g.ideasKept} of ${g.ideasTotal} ideas` : " · cards only"}
              benched={g.benched} lastKeepAt={g.lastKeepAt} what="deck"
              onOpen={() => onOpenDeck(g.deck, g.label)} />
          ))}
          {!groups.length ? <div className="kp-quiet">no decks on this board yet — a source has to be read into cards first</div> : null}
        </div>
      </div>
      <KeepsAsk boardId={boardId} onCompose={onCompose} />
      <div className="sh-foot"><kbd>esc</kbd> back to the room · click a row to curate that deck</div>
    </div>
  );
}

export interface LibraryKeepsProps extends KeepsCommon {
  onOpenBoard: (boardId: string, title: string) => void;
}

export function LibraryKeeps({ onOpenBoard, onBoardState, onDeckChanged, editing, setEditing, onEditSave, onDeleteCard, onRestoreCard, onCompose, onClose }: LibraryKeepsProps) {
  const [lib, setLib] = useState<{ boards: LibraryBoard[]; unfiled: CollectionGroup[] } | null>(null);
  const [reading, setReading] = useState<Spot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refetch = () => StrataAPI.libraryCollection()
    .then((r) => setLib({ boards: r.boards || [], unfiled: r.unfiled || [] })).catch(() => {});
  const ops = useKeepOps({ onBoardState, onDeckChanged, refetch, setErr });
  const gone = useGone({ onDeleteCard, onRestoreCard, setEditing, reread: refetch });

  useEffect(() => {
    let live = true;
    StrataAPI.libraryCollection()
      .then((r) => { if (live) setLib({ boards: r.boards || [], unfiled: r.unfiled || [] }); })
      .catch((e) => { if (live) { setLib({ boards: [], unfiled: [] }); setErr(StrataWhy(e, "couldn't read the library")); } });
    StrataAPI.log("bench_library_open", {});
    return () => { live = false; };
  }, []);

  const takeBack = (g: CollectionGroup, id: string) => ops.unkeep(g.deck, id, () => setLib((L) => L && {
    boards: L.boards.map((b) => ({ ...b, groups: b.groups.map((x) => (x.deck === g.deck ? { ...x, cards: x.cards.filter((c) => c.id !== id), kept: Math.max(0, x.kept - 1) } : x)) })),
    unfiled: L.unfiled.map((x) => (x.deck === g.deck ? { ...x, cards: x.cards.filter((c) => c.id !== id), kept: Math.max(0, x.kept - 1) } : x)),
  }));

  const saveEdit = makeSaveEdit(onEditSave, setEditing, (id, merged) => setLib((L) => L && {
    boards: L.boards.map((b) => ({ ...b, groups: b.groups.map((gr) => ({ ...gr, cards: gr.cards.map((x) => (x.id === id ? { ...x, ...merged } : x)) })) })),
    unfiled: L.unfiled.map((gr) => ({ ...gr, cards: gr.cards.map((x) => (x.id === id ? { ...x, ...merged } : x)) })),
  }));

  if (lib === null) return <Reading what="the library" line="reading the library…" />;

  const keptN = lib.boards.reduce((n, b) => n + b.kept, 0) + lib.unfiled.reduce((n, g) => n + g.kept, 0);
  const curatedB = lib.boards.filter((b) => b.kept > 0).length;
  const keptGroup = (g: CollectionGroup) => (
    <div key={g.deck} className="bkgroup">
      <div className="bkg-h">{g.label} <span className="bkg-n">{g.kept}</span></div>
      {g.cards.map((c) => (
        <KeptRow key={c.id} card={c} side="library" editing={editing} setEditing={setEditing}
          reading={reading} setReading={setReading} gone={gone}
          onSave={saveEdit} onTakeBack={() => takeBack(g, c.id)} backTitle="back to its deck — not kept after all" />
      ))}
    </div>
  );

  return (
    <div className="bench">
      <div className="sh-head">
        <span className="sh-what">keeps — the library · every board</span>
        <span className="grow" />
        <span className="sh-note">
          keeping {keptN} · across {curatedB} of {lib.boards.length} board{lib.boards.length === 1 ? "" : "s"}
        </span>
        <button className="sh-back" onClick={onClose} title="back to the boards (esc, or r)">done ›</button>
      </div>
      {err ? <div className="kp-err" style={{ padding: "8px 20px 0" }}>{err}</div> : null}
      <div className="bench-body">
        <div className="bench-keep">
          <div className="bn-h">the collection — everything you keep</div>
          <div className="kp-why">board by board, chapter by chapter — the whole of what the review is owed</div>
          {lib.boards.filter((b) => b.kept > 0).map((b) => (
            <div key={b.id} className="blgroup">
              <div className="blg-h">{b.title} <span className="bkg-n">{b.kept}</span></div>
              {b.groups.filter((g) => g.cards.length).map(keptGroup)}
            </div>
          ))}
          {lib.unfiled.length ? (
            <div className="blgroup">
              <div className="blg-h">unfiled — kept, but no board's shelf reaches these</div>
              {lib.unfiled.map(keptGroup)}
            </div>
          ) : null}
          {!keptN ? <div className="kp-quiet">nothing kept anywhere yet — the boards on the right are where that changes</div> : null}
        </div>
        <div className="bench-deck">
          <div className="bn-h">the library's boards · {lib.boards.length} — dark rows the bench has never seen</div>
          {lib.boards.map((b) => {
            const ideas = b.groups.reduce((n, g) => n + (g.ideasKept || 0), 0);
            return (
              <CoverageRow key={b.id} label={b.title} kept={b.kept} total={b.total}
                middle={(ideas ? ` · ${ideas} idea${ideas === 1 ? "" : "s"}` : "")
                  + ` · across ${b.decksBenched} of ${b.decksTotal} deck${b.decksTotal === 1 ? "" : "s"}`}
                benched={b.benched} lastKeepAt={b.lastKeepAt} what="board"
                onOpen={() => onOpenBoard(b.id, b.title)} />
            );
          })}
          {!lib.boards.length ? <div className="kp-quiet">no boards hold a deck yet — nothing to curate</div> : null}
        </div>
      </div>
      <KeepsAsk boardId={null} onCompose={onCompose} />
      <div className="sh-foot"><kbd>esc</kbd> back to the boards · click a board to open its bench</div>
    </div>
  );
}

export default DeckKeeps;
