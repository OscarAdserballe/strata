// Every kind of thing an agent can read, and the tables it is read from (the drift test checks these).
import { q } from "../repo.ts";
import { pagesOf } from "../sources/blobs.ts";
import { importStatus, imports } from "../imports/pump.ts";
import { rangeText, type ContentRange } from "../../../shared/imports/import-plan.ts";
import { idOf, parseRef, HANDLE, type Collection, type Ref } from "../../../shared/agent/ids.ts";
import { SECTION_TO_END } from "../../platform/db/schema.ts";
import { externalPath } from "../../platform/config.ts";
import { parseJson } from "../../platform/db/sql.ts";
import { agentRepo as a, type ChatRow, type KeptRow, type SourceRow } from "./repo.ts";
import { count, facesOfCard, indent, oneLine, paged, pagedText, tokensOf, when } from "./render.ts";
import { noteOfThread } from "../../../shared/reading/notes.ts";
import { compileAnchor, quoteOfAnchor, type QuoteText } from "../../../shared/reading/compile-quote.ts";
import { quoteTextOfDeck } from "../decks/decks.ts";
import { pageTextStatus } from "../imports/pump.ts";

export class AgentError extends Error {}
const fail = (msg: string): never => { throw new AgentError(msg); };

/** What each kind is built from. A table a board or deck owns must appear here or in HIDDEN. */
export const KINDS: { kind: string; tables: string[] }[] = [
  { kind: "board", tables: ["boards", "board_notes", "board_prefs"] },
  { kind: "plan", tables: ["board_groups", "board_milestones", "board_places"] },
  { kind: "source", tables: ["resources", "resource_blobs", "pairs", "imports", "page_states"] },
  { kind: "section", tables: ["sections", "trees", "source_trees"] },
  { kind: "card", tables: ["cards", "card_edits", "card_drops", "courses", "review_receipts"] },
  { kind: "kept", tables: ["card_keeps"] },
  { kind: "highlight", tables: ["marks", "mark_replies"] },
  { kind: "question", tables: ["minted"] },
  { kind: "chat", tables: ["messages", "card_messages", "asks"] },
];
export const HIDDEN: Record<string, string> = {};

// ---------- boards ----------

export interface Board { id: string; title: string; handle: string | null; purpose: string | null; ref: string }

export function boardOf(raw: unknown): Board {
  const s = String(raw ?? "").trim();
  if (!s) fail("Name a board: its handle or id. whoami lists them.");
  const id = HANDLE.test(s) ? (a.boardByHandle.get(s)?.id ?? s) : s;
  const b = a.boardMeta.get(id);
  if (!b) return fail(`No board "${s}". whoami lists your boards with their ids and handles.`);
  return { ...b, ref: b.handle ?? b.id };
}
const boardById = (id: string): Board => boardOf(id);

interface DeckInfo { resource_id: string | null; section_id: string | null; label: string | null }
const decksOf = (board: string): Map<string, DeckInfo> => new Map(a.decksOf.all(board).map((d) => [d.deck, d]));
const size = (tokens: number | null | undefined): string => tokens ? ` · ~${tokens} tokens` : "";
const titleOf = (s: Pick<SourceRow, "filename"> | undefined): string => String(s?.filename ?? "untitled").replace(/\.(pdf|md|markdown|txt|html?)$/i, "");
const sourcesOf = (board: string): Map<string, SourceRow> => new Map(a.sourcesOf.all(board).map((s) => [s.id, s]));

function sourceStatus(s: SourceRow, kept: number, cards: number): string {
  const state = s.done_at ? `finished ${when.day(s.done_at)}` : "reading";
  const studied = cards || !a.unstudied.get(s.id) ? `${kept} kept / ${cards} cards` : "not studied, no flashcards";
  return `${s.kind ?? "text"} · ${studied} · ${state}`;
}

export function boardList(): string {
  const lines = a.boardsAll.all().filter((b) => b.type !== "inbox" || a.sourceCounts.get(b.id)!.n > 0).map((b) => {
    const c = a.sourceCounts.get(b.id)!;
    const kept = a.keptCount.get(b.id)?.n ?? 0;
    const name = b.handle ? `${b.handle} (${b.id})` : b.id;
    return `- ${name} — ${b.title} · ${c.n} sources · ${kept} kept · last touched ${when.day(b.touched_at ?? b.created_at)}`;
  });
  return `# Your boards\n\n${lines.join("\n") || "No boards yet."}\n\nPass a board's handle or id as \`board\`.`;
}

// ---------- outline ----------

function boardOutline(b: Board): string {
  const notes = a.notesMeta.get(b.id);
  const plan = { groups: q.groupsOf.all(b.id), milestones: q.milestonesOf.all(b.id) };
  const kept = a.keptOfBoard.all(b.id);
  const keptTokens = kept.reduce((n, k) => { const f = facesOfCard(k.type, k.payload); return n + tokensOf(f.question + f.answer) + 25; }, 0);
  const minted = a.mintedFull.all(b.id);
  const marks = a.marksFull.all(b.id);
  const srcs = a.sourcesOf.all(b.id);
  const keptBy = new Map(a.keptCountsByCourse.all(b.id).map((r) => [r.course, r.n]));
  const cardsBy = new Map(a.cardCountsByCourse.all(b.id).map((r) => [r.course, r.n]));
  const decks = [...decksOf(b.id).entries()];
  const sectionsBy = new Map<string, number>();
  for (const s of q.sectionsOfBoard.all(b.id)) sectionsBy.set(s.resource_id, (sectionsBy.get(s.resource_id) ?? 0) + 1);
  const per = (rid: string, m: Map<string, number>) => decks.filter(([, d]) => d.resource_id === rid).reduce((n, [slug]) => n + (m.get(slug) ?? 0), 0);
  const open = minted.filter((m) => m.state === "open").length;
  const words = notes?.text.trim() ? notes.text.trim().split(/\s+/).length : 0;
  const chat = a.chatCount.get(b.id, b.id)!;
  return [
    `# ${b.title}`,
    `id: ${b.id}${b.handle ? ` · handle: ${b.handle}` : " · no handle (apply set_handle to give it one)"}`,
    b.purpose ? `purpose: ${b.purpose}` : "purpose: (none set)",
    "",
    "## Collections",
    `- ${b.ref}/log — home note · ${words} words · ~${tokensOf(notes?.text ?? "")} tokens${notes ? ` · updated ${when.day(notes.updated_at)}` : ""}`,
    `- ${b.ref}/plan — ${count(plan.groups.length, "group")} · ${count(plan.milestones.length, "milestone")} (${plan.milestones.filter((m) => m.done_at).length} done)`,
    `- ${b.ref}/kept — ${count(kept.length, "card")} · ~${keptTokens} tokens`,
    `- ${b.ref}/questions — ${open} open · ${minted.length - open} answered`,
    `- ${b.ref}/highlights — ${marks.length} (${marks.filter((m) => m.note).length} with notes)`,
    `- ${b.ref}/comments — ${commentTally(talksOf(b, sourcesOf(b.id)))}`,
    `- ${b.ref}/sources — ${srcs.length} (${srcs.filter((s) => s.done_at).length} finished)`,
    `- ${b.ref}/chat — ${count(chat.n, "message")} with the board's model${chat.cleared ? ` (${chat.cleared} cleared)` : ""}`,
    "",
    "## Sources",
    ...(srcs.length ? srcs.map((s) => `- ${idOf("source", s.id)} "${titleOf(s)}" · ${count(sectionsBy.get(s.id) ?? 0, "section")} · ${sourceStatus(s, per(s.id, keptBy), per(s.id, cardsBy))}`) : ["None yet."]),
  ].join("\n");
}

export function outline(boardArg: unknown, idArg: unknown, budget: number, cursor: unknown): string {
  if (idArg) return render(refOf(idArg, boardArg), {}, cursor, budget, true);
  if (!boardArg) return boardList();
  return pagedText("", boardOutline(boardOf(boardArg)), cursor, budget, (c) => `get_outline({ board: "${String(boardArg)}", cursor: "${c}" })`);
}

// ---------- refs ----------

function refOf(raw: unknown, boardArg?: unknown): Ref {
  const r = parseRef(String(raw ?? ""));
  if (!r) return fail(`"${String(raw)}" is not an id. Ids look like src_…, card_…, q_…, or <board>/kept. get_guide({ topic: "ids" }) explains them.`);
  if (r.kind === "board" && boardArg && !a.boardMeta.get(r.board) && !a.boardByHandle.get(r.board)) return fail(`No board or item "${String(raw)}".`);
  return r;
}

const boardOfItem = (kind: string, id: string): Board => {
  const row = kind === "source" ? a.resourceBoard.get(id) : kind === "question" ? a.mintedBoard.get(id)
    : kind === "highlight" ? a.markBoard.get(id) : kind === "group" ? a.groupBoard.get(id) : kind === "milestone" ? a.milestoneBoard.get(id) : undefined;
  if (!row) return fail(`No ${kind} ${idOf(kind as never, id)}.`);
  return boardById(row.board_id);
};

export interface Filter { group?: string; source?: string; since?: string; state?: string; noted?: boolean; milestone?: string }

/** The app link that opens a source, from the origin the agent reached us on. */
export const openLink = (origin: string, boardId: string, rid: string): string =>
  `${origin}${externalPath("")}?board=${encodeURIComponent(boardId)}&resource=${encodeURIComponent(rid)}`;

export function render(r: Ref, filter: Filter, cursor: unknown, budget: number, short = false, site = ""): string {
  switch (r.kind) {
    case "board": return short ? boardOutline(boardOf(r.board)) : boardContext(boardOf(r.board), cursor, budget);
    case "collection": return collection(boardOf(r.board), r.name, filter, cursor, budget, short);
    case "source": return sourceContext(r.id, cursor, budget, short, site);
    case "section": return sectionContext(r.id, short);
    case "deck": return deckContext(r.id, cursor, budget, short);
    case "card": return cardContext(r.id);
    case "question": return questionContext(r.id);
    case "highlight": return highlightContext(r.id);
    case "comment": return commentContext(r.id);
    case "group": return groupContext(r.id);
    case "milestone": return milestoneContext(r.id);
    case "import": return importContext(r.id);
  }
}

// ---------- collections ----------

const sinceOf = (s: unknown): number | null => {
  if (s === undefined || s === null || s === "") return null;
  const t = Date.parse(String(s));
  return Number.isFinite(t) ? t : fail(`"since" must be a date like 2026-10-01, not "${String(s)}".`);
};

function groupIdOf(b: Board, g: string): string {
  const raw = g.replace(/^grp_/, "");
  const found = q.groupsOf.all(b.id).find((x) => x.id === raw || x.name.toLowerCase() === g.toLowerCase());
  return found ? found.id : fail(`No group "${g}" on ${b.ref}. ${b.ref}/plan lists the groups.`);
}
function sourcesInGroup(b: Board, group: string): Set<string> {
  const gid = groupIdOf(b, group);
  const pairs = q.pairsOf.all(b.id);
  const set = new Set<string>();
  for (const p of q.placesOf.all(b.id)) {
    if (p.group_id !== gid) continue;
    const pair = pairs.find((x) => x.id === p.item);
    set.add(pair?.resource_id ?? p.item);
  }
  return set;
}
const sourceIdOf = (s: string): string => s.replace(/^src_/, "");

/** Each deck's text read once per answer: a book's pages are parsed once, not per card. */
type DeckTexts = (deck: string) => QuoteText | null;
const deckTexts = (board: string): DeckTexts => {
  const m = new Map<string, QuoteText | null>();
  return (deck) => { if (!m.has(deck)) m.set(deck, quoteTextOfDeck(board, deck)); return m.get(deck) ?? null; };
};

/** Where a card sits: its quote compiled against its source, the same compile the reader and edit_cards use. */
function placeOfCard(payload: string, src: QuoteText | null): string {
  const source = parseJson<{ source?: unknown }>(payload, {}).source;
  const q = quoteOfAnchor(source);
  const said = q ? `${q.page ? `p. ${q.page} · ` : ""}"${oneLine(q.quote, 200)}"` : oneLine(String(source ?? ""), 120) || "nowhere";
  if (!src) return `${said} · not placed (its deck reads no source here)`;
  const r = compileAnchor(source, src);
  return r.ok ? `${said} · compiles` : `${said} · DOES NOT COMPILE: ${r.error}`;
}

function cardLine(b: Board, k: { id: string; course: string; type: string; payload: string }, decks: Map<string, DeckInfo>, srcs: Map<string, SourceRow>, keptAt: number | null, texts: DeckTexts): string {
  const f = facesOfCard(k.type, k.payload);
  const d = decks.get(k.course);
  const from = d?.resource_id ? `${idOf("source", d.resource_id)} "${titleOf(srcs.get(d.resource_id))}"${d.label && d.label !== srcs.get(d.resource_id)?.filename ? ` › ${d.label}` : ""}` : `${idOf("deck", k.course)}`;
  const at = placeOfCard(k.payload, texts(k.course));
  return [`- **${f.question}**`, f.answer ? indent(f.answer) : "", `  ${idOf("card", k.id)} · from ${from} · at ${at}${keptAt ? ` · kept ${when.day(keptAt)}` : ""}`].filter(Boolean).join("\n");
}

function collection(b: Board, name: Collection, f: Filter, cursor: unknown, budget: number, short: boolean): string {
  const again = (c: string) => `get_context({ id: "${b.ref}/${name}"${Object.keys(f).length ? `, filter: ${JSON.stringify(f)}` : ""}, cursor: "${c}" })`;
  const srcs = sourcesOf(b.id);
  switch (name) {
    case "log": {
      const text = a.notesMeta.get(b.id)?.text ?? "";
      return text.trim() ? pagedText(`# Log · ${b.title}`, text, cursor, budget, again) : `# Log · ${b.title}\n\nThe home note is empty.`;
    }
    case "plan": return planContext(b, srcs);
    case "sources": {
      const keptBy = new Map(a.keptCountsByCourse.all(b.id).map((r) => [r.course, r.n]));
      const cardsBy = new Map(a.cardCountsByCourse.all(b.id).map((r) => [r.course, r.n]));
      const decks = [...decksOf(b.id).entries()];
      const per = (rid: string, m: Map<string, number>) => decks.filter(([, d]) => d.resource_id === rid).reduce((n, [s]) => n + (m.get(s) ?? 0), 0);
      const items = [...srcs.values()].map((s) => `- ${idOf("source", s.id)} "${titleOf(s)}" · ${sourceStatus(s, per(s.id, keptBy), per(s.id, cardsBy))} · added ${when.day(s.created_at)}`);
      return paged(`# Sources · ${b.title}`, items, cursor, budget, again);
    }
    case "kept": {
      const decks = decksOf(b.id);
      let rows: KeptRow[] = a.keptOfBoard.all(b.id);
      const since = sinceOf(f.since);
      if (since !== null) rows = rows.filter((k) => k.created_at >= since);
      if (f.group) { const set = sourcesInGroup(b, f.group); rows = rows.filter((k) => set.has(decks.get(k.course)?.resource_id ?? "")); }
      if (f.source) { const sid = sourceIdOf(f.source); rows = rows.filter((k) => decks.get(k.course)?.resource_id === sid); }
      const texts = deckTexts(b.id);
      const items = rows.map((k) => short ? `- ${oneLine(facesOfCard(k.type, k.payload).question)} · ${idOf("card", k.id)}` : cardLine(b, k, decks, srcs, k.created_at, texts));
      return paged(`# Kept · ${b.title}${f.group ? ` · group "${f.group}"` : ""}${f.source ? ` · ${f.source}` : ""}`, items, cursor, budget, again, "No kept cards match.");
    }
    case "questions": {
      let rows = a.mintedFull.all(b.id);
      if (f.state === "open") rows = rows.filter((m) => m.state === "open");
      else if (f.state === "answered") rows = rows.filter((m) => m.state !== "open");
      const items = rows.map((m) => short ? `- [${m.state === "open" ? "open" : "answered"}] ${oneLine(m.front)} · ${idOf("question", m.id)}`
        : [`- [${m.state === "open" ? "open" : "answered"}] **${m.front}**`, m.back ? indent(m.back) : "", `  ${idOf("question", m.id)} · asked ${when.day(m.created_at)}${m.source ? ` · ${oneLine(m.source, 80)}` : ""}`].filter(Boolean).join("\n"));
      return paged(`# Questions · ${b.title}${f.state ? ` · ${f.state}` : ""}`, items, cursor, budget, again, "No questions match.");
    }
    case "highlights": {
      let rows = a.marksFull.all(b.id);
      if (f.noted) rows = rows.filter((m) => m.note?.trim());
      if (f.source) { const sid = sourceIdOf(f.source); rows = rows.filter((m) => m.resource_id === sid); }
      const said = repliesByMark(b.id);
      const items = rows.map((m) => {
        const where = `${idOf("source", m.resource_id)} "${titleOf(srcs.get(m.resource_id))}"${m.page ? ` p. ${m.page}` : ""}`;
        const rs = said.get(m.id) ?? [];
        return short ? `- "${oneLine(m.quote, 100)}"${m.note ? ` — ${oneLine(m.note, 80)}` : ""}${rs.length ? ` · ${rs.length} repl${rs.length > 1 ? "ies" : "y"}` : ""} · ${idOf("highlight", m.id)}`
          : [`- > ${oneLine(m.quote, 600)}`, m.note ? `  note: ${m.note}` : "", ...rs.map((r) => `  ${r.author === "agent" ? "agent" : "you"}: ${r.text}`),
            `  ${idOf("highlight", m.id)} · ${where} · ${when.day(m.created_at)}`].filter(Boolean).join("\n");
      });
      return paged(`# Highlights · ${b.title}${f.noted ? " · with notes" : ""}`, items, cursor, budget, again, "No highlights match.");
    }
    case "comments": return commentsCollection(b, f, srcs, cursor, budget, short, again);
    case "chat": {
      const decks = decksOf(b.id);
      let rows = a.chatOf.all(b.id, b.id);
      const since = sinceOf(f.since);
      if (since !== null) rows = rows.filter((m) => m.created_at >= since);
      if (f.source) { const sid = sourceIdOf(f.source); rows = rows.filter((m) => (m.resource_id ?? decks.get(m.course ?? "")?.resource_id) === sid); }
      const items = rows.map((m) => short ? `- ${when.minute(m.created_at)} · ${speaker(m)}: ${oneLine(m.text, 120)}`
        : [`- ${when.minute(m.created_at)} · **${speaker(m)}** · ${chatWhere(m, srcs)}${m.archived ? " · cleared" : ""}`, indent(m.text.trim())].join("\n"));
      return paged(`# Chat · ${b.title} · newest first${f.source ? ` · ${f.source}` : ""}`, items, cursor, budget, again, "No chat matches.");
    }
  }
}

const speaker = (m: ChatRow): string => m.role === "user" ? "you" : "model";
function chatWhere(m: ChatRow, srcs: Map<string, SourceRow>): string {
  if (m.card) return `on ${idOf("card", m.card)}`;
  const at = m.words ? ` at the words "${oneLine(m.words, 80)}"` : "";
  return m.resource_id ? `on ${idOf("source", m.resource_id)} "${titleOf(srcs.get(m.resource_id))}"${at}` : "board chat";
}

function planContext(b: Board, srcs: Map<string, SourceRow>): string {
  const groups = q.groupsOf.all(b.id), milestones = q.milestonesOf.all(b.id), places = q.placesOf.all(b.id);
  const pairs = q.pairsOf.all(b.id);
  const itemName = (item: string) => {
    const rid = pairs.find((p) => p.id === item)?.resource_id ?? item;
    const s = srcs.get(rid);
    return s ? `${idOf("source", s.id)} "${titleOf(s)}"${s.done_at ? " (finished)" : ""}` : `pair ${item}`;
  };
  const placed = new Set<string>();
  const lines = [`# Plan · ${b.title}`, `purpose: ${b.purpose || "(none set)"}`, "", "## Groups"];
  for (const g of groups) {
    const items = places.filter((p) => p.group_id === g.id).sort((x, y) => (x.ord ?? 0) - (y.ord ?? 0));
    items.forEach((p) => placed.add(p.item));
    lines.push(`- ${idOf("group", g.id)} **${g.name}**`, ...items.map((p) => `  - ${itemName(p.item)}${p.pinned ? " · pinned" : ""}`));
  }
  if (!groups.length) lines.push("None yet.");
  const loose = [...srcs.keys()].filter((rid) => !placed.has(rid) && !pairs.some((p) => p.resource_id === rid && placed.has(p.id)));
  if (loose.length) lines.push("", "## Not in a group", ...loose.map((rid) => `- ${itemName(rid)}`));
  lines.push("", "## Milestones");
  for (const m of milestones) {
    const toward = places.filter((p) => p.milestone_id === m.id);
    lines.push(`- ${idOf("milestone", m.id)} ${m.done_at ? "[done] " : ""}**${m.name}**${m.due ? ` · due ${m.due}` : ""}${m.note ? ` · ${oneLine(m.note, 200)}` : ""}`,
      ...toward.map((p) => `  - ${itemName(p.item)}`));
  }
  if (!milestones.length) lines.push("None yet.");
  return lines.join("\n");
}

// ---------- comments: the reader's notes on live pages, and the replies under them ----------

type NoteTurn = "with_agent" | "your_turn";
const TURN_WORDS: Record<NoteTurn, string> = { with_agent: "with agent", your_turn: "your turn" };
const COMMENT_STATES = ["with_agent", "your_turn", "open"];
interface Talk { m: { id: string; resource_id: string; quote: string; note: string | null; box: string | null; created_at: number }; replies: { author: string; text: string; created_at: number }[]; turn: NoteTurn }

/** Notes on live pages: the last word says whose turn it is. A note is sent the moment it is written. */
function talksOf(b: Board, srcs: Map<string, SourceRow>): Talk[] {
  const said = repliesByMark(b.id);
  return a.marksFull.all(b.id).filter((m) => srcs.get(m.resource_id)?.kind === "html" && m.note?.trim()).map((m) => {
    const replies = said.get(m.id) ?? [];
    return { m, replies, turn: replies.length && replies[replies.length - 1].author === "agent" ? "your_turn" : "with_agent" };
  });
}

function commentTally(ts: Talk[]): string {
  const n = (s: NoteTurn) => ts.filter((t) => t.turn === s).length;
  return `${count(ts.length, "note")} (${n("with_agent")} waiting on an agent, ${n("your_turn")} the reader's turn)`;
}

const anchorOf = (t: Talk): string => t.m.box
  ? `box [data-strata-id="${t.m.box}"]${t.m.quote ? ` "${oneLine(t.m.quote, 120)}"` : ""}`
  : `words "${oneLine(t.m.quote, 200)}"`;

function talkBlock(t: Talk, srcs: Map<string, SourceRow>, withSource: boolean): string {
  return [
    `## ${idOf("highlight", t.m.id)} · ${TURN_WORDS[t.turn]} · on ${anchorOf(t)}`,
    ...(withSource ? [`in ${idOf("source", t.m.resource_id)} "${titleOf(srcs.get(t.m.resource_id))}"`] : []),
    `- you · ${when.minute(t.m.created_at)}\n${indent((t.m.note ?? "").trim())}`,
    ...t.replies.map((r) => `- ${r.author === "agent" ? "agent" : "you"} · ${when.minute(r.created_at)}\n${indent(r.text.trim())}`),
    "",
  ].join("\n");
}

function commentsCollection(b: Board, f: Filter, srcs: Map<string, SourceRow>, cursor: unknown, budget: number, short: boolean, again: (c: string) => string): string {
  if (f.state && !COMMENT_STATES.includes(f.state)) fail(`On comments, state is one of ${COMMENT_STATES.join(", ")}.`);
  let rows = talksOf(b, srcs);
  const sid = f.source ? sourceIdOf(f.source) : null;
  if (sid) rows = rows.filter((t) => t.m.resource_id === sid);
  if (f.state && f.state !== "open") rows = rows.filter((t) => t.turn === f.state);
  const origin = sid ? a.importOfResource.get(sid) : undefined;
  const head = [
    `# Comments · ${b.title}${sid ? ` · ${idOf("source", sid)} "${titleOf(srcs.get(sid))}"` : ""} · ${f.state && f.state !== "open" ? TURN_WORDS[f.state as NoteTurn] : "open"}`,
    ...(origin?.origin ? [`file: ${origin.origin}${origin.origin_ref ? ` · ${origin.origin_ref} (upload under this ref to revise the page in place)` : ""}`] : []),
    "The reader's notes on live pages, each with the replies under it. Answer with apply: reply_note { id, text }, after revising the page.",
  ].join("\n");
  const items = rows.map((t) => short ? `- ${idOf("highlight", t.m.id)} · ${TURN_WORDS[t.turn]} · on ${anchorOf(t)} · ${count(t.replies.length, "reply", "replies")}` : talkBlock(t, srcs, !sid));
  return paged(head, items, cursor, budget, again, "No comments match.");
}

function waitingComments(b: Board): string[] {
  const srcs = sourcesOf(b.id);
  const waiting = talksOf(b, srcs).filter((t) => t.turn === "with_agent");
  if (!waiting.length) return [];
  const per = new Map<string, number>();
  for (const t of waiting) per.set(t.m.resource_id, (per.get(t.m.resource_id) ?? 0) + 1);
  return ["", "## Notes on live pages waiting on an agent", ...[...per].map(([rid, n]) => `- ${count(n, "note")} on ${idOf("source", rid)} "${titleOf(srcs.get(rid))}": get_context({ id: "${b.ref}/comments", filter: { source: "${idOf("source", rid)}", state: "with_agent" } })`)];
}

// a comment thread became a note with replies; its old cm_ id still names that note
function commentContext(id: string): string {
  const mid = noteOfThread(id);
  if (!a.markBoard.get(mid)) fail(`${idOf("comment", id)} no longer exists. Comments are notes now: <board>/comments lists them by hl_ id.`);
  return highlightContext(mid);
}

// ---------- board overview ----------

function boardContext(b: Board, cursor: unknown, budget: number): string {
  const notes = a.notesMeta.get(b.id)?.text ?? "";
  const tail = notes.trim() ? notes.trimEnd().split("\n").slice(-30).join("\n") : "(empty)";
  const open = a.mintedFull.all(b.id).filter((m) => m.state === "open").slice(-10);
  const milestones = q.milestonesOf.all(b.id);
  const text = [
    `# ${b.title}`,
    `id: ${b.id}${b.handle ? ` · handle: ${b.handle}` : ""}`,
    `purpose: ${b.purpose || "(none set)"}`,
    "",
    "## Milestones",
    ...(milestones.length ? milestones.map((m) => `- ${m.done_at ? "[done] " : ""}${m.name}${m.due ? ` · due ${m.due}` : ""}`) : ["None yet."]),
    "",
    "## Last 14 days",
    changes(b, new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10), undefined, 15, undefined, 4000, true),
    "",
    "## Open questions",
    ...(open.length ? open.map((m) => `- ${oneLine(m.front, 200)} · ${idOf("question", m.id)}`) : ["None."]),
    ...waitingComments(b),
    "",
    "## Log (last lines)",
    tail,
    "",
    `More: get_context on ${b.ref}/kept, ${b.ref}/questions, ${b.ref}/highlights, ${b.ref}/comments, ${b.ref}/plan, ${b.ref}/log, ${b.ref}/chat, or get_outline({ board: "${b.ref}" }).`,
  ].join("\n");
  return pagedText("", text, cursor, budget, (c) => `get_context({ id: "${b.ref}", cursor: "${c}" })`);
}

// ---------- items ----------

function sourceContext(rid: string, cursor: unknown, budget: number, short: boolean, site = ""): string {
  const s = a.sourceOne.get(rid) ?? fail(`No source ${idOf("source", rid)}.`);
  const b = boardById(s.board_id);
  const sections = q.sectionsOf.all(rid);
  const trees = new Map(q.treesOfResource.all(rid).map((t) => [t.section_id, t]));
  const decks = [...decksOf(b.id).entries()].filter(([, d]) => d.resource_id === rid);
  const keptBy = new Map(a.keptCountsByCourse.all(b.id).map((r) => [r.course, r.n]));
  const cardsBy = new Map(a.cardCountsByCourse.all(b.id).map((r) => [r.course, r.n]));
  const origin = a.importOfResource.get(rid);
  const lines = [
    `# ${titleOf(s)}`,
    `${idOf("source", rid)} on ${b.ref} · ${s.kind ?? "text"} · added ${when.day(s.created_at)}${s.done_at ? ` · finished ${when.day(s.done_at)}` : " · reading"}`,
    ...(site ? [`open: ${openLink(site, b.id, rid)}`] : []),
    ...(s.origin_url ? [`from ${s.origin_url}`] : []),
    ...(origin?.origin ? [`pushed from ${origin.origin}${origin.origin_ref ? ` (${origin.origin_ref})` : ""}`] : []),
    `text: get_text({ id: "${idOf("source", rid)}" })${size(s.tokens || sections.reduce((n, x) => n + (x.tokens ?? 0), 0))}`,
    "",
    "## Sections",
    ...sections.map((x) => {
      const t = trees.get(x.id);
      const deck = decks.find(([, d]) => d.section_id === x.id)?.[0];
      const pages = x.last_page === SECTION_TO_END ? `p. ${x.first_page}–end` : `p. ${x.first_page}–${x.last_page}`;
      return `- ${idOf("section", x.id)} ${x.label} · ${pages}${size(x.tokens)}${x.kind === "apparatus" ? " · front/back matter" : ""} · cards: ${cardsStatus(t)}${deck ? ` · ${keptBy.get(deck) ?? 0} kept / ${cardsBy.get(deck) ?? 0} · ${idOf("deck", deck)}` : ""}`;
    }),
  ];
  if (short) return lines.join("\n");
  const tree = q.sourceTree.get(rid)?.ascii ?? (sections.length === 1 ? trees.get(sections[0].id)?.ascii : null);
  if (tree) lines.push("", "## Concept tree", "```", tree.trim(), "```");
  const noted = a.marksFull.all(b.id).filter((m) => m.resource_id === rid && m.note?.trim()).slice(0, 20);
  if (noted.length) lines.push("", "## Your highlights with notes", ...noted.map((m) => `- > ${oneLine(m.quote, 300)}\n  note: ${m.note}`));
  const talk = talksOf(b, sourcesOf(b.id)).filter((t) => t.m.resource_id === rid);
  if (talk.length) lines.push("", "## Comments", `${commentTally(talk)}: get_context({ id: "${b.ref}/comments", filter: { source: "${idOf("source", rid)}" } })`);
  const kept = a.pageStateOf.get(rid);
  if (kept) lines.push("", `## What the page saved · ${when.day(kept.updated_at)}`, "The reader's own state in this live page (window.strata.save):", "```json", prettyJson(kept.value), "```");
  return pagedText("", lines.join("\n"), cursor, budget, (c) => `get_context({ id: "${idOf("source", rid)}", cursor: "${c}" })`);
}

const prettyJson = (raw: string): string => { try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; } };

// what the reader's progress card says of a section's cards: a run in flight says since when, a failed one why
function cardsStatus(t: { status: string; error?: string | null; updated_at?: number } | undefined): string {
  if (!t) return "none";
  if (t.status === "unstudied") return "none (not studied; the reader can make them)";
  if (t.status === "error") return `error${t.error ? ` (${oneLine(t.error, 200)})` : ""}`;
  if (["queued", "preparing", "running", "carding"].includes(t.status) && t.updated_at) return `${t.status} since ${when.minute(t.updated_at)}`;
  return t.status;
}

function sectionContext(sid: string, short: boolean): string {
  const x = q.section.get(sid) ?? fail(`No section ${idOf("section", sid)}.`);
  const s = a.sourceOne.get(x.resource_id);
  const t = q.tree.get(sid);
  const deck = a.decksOf.all(x.board_id).find((d) => d.section_id === sid)?.deck;
  const lines = [
    `# ${x.label}`,
    `${idOf("section", sid)} of ${idOf("source", x.resource_id)} "${titleOf(s)}" · p. ${x.first_page}–${x.last_page === SECTION_TO_END ? "end" : x.last_page}${size(x.tokens)}`,
    `cards: ${cardsStatus(t)}${deck ? ` · ${idOf("deck", deck)}` : ""} · text: get_text({ id: "${idOf("section", sid)}" })`,
  ];
  if (!short && t?.ascii) lines.push("", "## Concept tree", "```", t.ascii.trim(), "```");
  return lines.join("\n");
}

function deckContext(slug: string, cursor: unknown, budget: number, short: boolean): string {
  const course = q.course.get(slug) ?? fail(`No deck ${idOf("deck", slug)}.`);
  const where = a.deckBoard.get(slug);
  const b = where ? boardById(where.board_id) : null;
  const srcs = b ? sourcesOf(b.id) : new Map<string, SourceRow>();
  const decks = b ? decksOf(b.id) : new Map<string, DeckInfo>();
  const cards = q.cardsOf.all(slug), texts = deckTexts(where?.board_id ?? "");
  const items = cards.map((c) => {
    const kept = a.keptAt.get(c.id)?.created_at ?? null;
    return short ? `- ${kept ? "★ " : ""}${oneLine(facesOfCard(c.type, c.payload).question)} · ${idOf("card", c.id)}`
      : cardLine(b ?? ({ ref: "" } as Board), { ...c, course: slug }, decks, srcs, kept, texts);
  });
  return paged(`# Deck · ${course.title}${b ? ` · on ${b.ref}` : ""}`, items, cursor, budget, (c) => `get_context({ id: "${idOf("deck", slug)}", cursor: "${c}" })`);
}

function cardContext(id: string): string {
  const c = a.cardById.get(id) ?? fail(`No card ${idOf("card", id)}. It may have been dropped or regenerated.`);
  const f = facesOfCard(c.type, c.payload);
  const where = a.deckBoard.get(c.course);
  const s = where?.resource_id ? a.sourceOne.get(where.resource_id) : undefined;
  const section = where?.section_id ? q.section.get(where.section_id) : undefined;
  const kept = a.keptAt.get(id)?.created_at;
  const grades = a.gradesOfCard.all(id);
  const at = placeOfCard(c.payload, where ? quoteTextOfDeck(where.board_id, c.course) : null);
  return [
    `# Card`,
    `${idOf("card", id)} · ${f.type} · ${kept ? `kept ${when.day(kept)}` : "not kept"}`,
    `from ${s ? `${idOf("source", s.id)} "${titleOf(s)}"` : idOf("deck", c.course)}${section ? ` › ${idOf("section", section.id)} ${section.label}` : ""}`,
    `at: ${at}`,
    "",
    `**Q:** ${f.question}`,
    "",
    `**A:** ${f.answer || "(no answer face)"}`,
    "",
    "## Last grades",
    ...(grades.length ? grades.map((g) => `- ${when.minute(g.at)} · ${g.got ? "got" : "missed"}`) : ["Never graded."]),
  ].join("\n");
}

function questionContext(id: string): string {
  const b = boardOfItem("question", id);
  const m = a.mintedOne.get(b.id, id)!;
  return [`# Question`, `${idOf("question", id)} on ${b.ref} · ${m.state === "open" ? "open" : "answered"} · asked ${when.day(m.created_at)}`, "",
    `**Q:** ${m.front}`, "", m.back ? `**Your answer:** ${m.back}` : "No answer yet. Only you write the answer.", ...(m.source ? ["", `came up: ${m.source}`] : [])].join("\n");
}

function highlightContext(id: string): string {
  const b = boardOfItem("highlight", id);
  const m = a.marksFull.all(b.id).find((x) => x.id === id)!;
  const s = a.sourceOne.get(m.resource_id);
  const rs = repliesByMark(b.id).get(id) ?? [];
  return [`# Highlight`, `${idOf("highlight", id)} · ${idOf("source", m.resource_id)} "${titleOf(s)}"${m.page ? ` p. ${m.page}` : ""} · ${when.day(m.created_at)}`, "",
    `> ${m.quote}`, ...(m.note ? ["", `note: ${m.note}`] : []),
    ...(rs.length ? ["", "## Replies", ...rs.map((r) => `- ${r.author === "agent" ? "agent" : "you"} · ${when.day(r.created_at)}: ${r.text}`)] : []),
    ...(m.note ? ["", `Answer under the note with apply: reply_note { id: "${idOf("highlight", id)}", text }.`] : [])].join("\n");
}

/** The replies under a board's notes, by mark: one read for a whole listing. */
function repliesByMark(board: string): Map<string, { author: string; text: string; created_at: number }[]> {
  const out = new Map<string, { author: string; text: string; created_at: number }[]>();
  for (const r of q.repliesOf.all(board)) { if (!out.has(r.mark_id)) out.set(r.mark_id, []); out.get(r.mark_id)!.push(r); }
  return out;
}

function groupContext(id: string): string {
  const b = boardOfItem("group", id);
  const plan = planContext(b, sourcesOf(b.id)).split("\n");
  const at = plan.findIndex((l) => l.startsWith(`- ${idOf("group", id)} `));
  const end = plan.findIndex((l, i) => i > at && !l.startsWith("  "));
  return [`# Group on ${b.ref}`, ...plan.slice(at, end < 0 ? undefined : end)].join("\n");
}

function milestoneContext(id: string): string {
  const b = boardOfItem("milestone", id);
  const plan = planContext(b, sourcesOf(b.id)).split("\n");
  const at = plan.findIndex((l) => l.startsWith(`- ${idOf("milestone", id)} `));
  const end = plan.findIndex((l, i) => i > at && !l.startsWith("  "));
  return [`# Milestone on ${b.ref}`, ...plan.slice(at, end < 0 ? undefined : end)].join("\n");
}

export function importContext(id: string, origin = ""): string {
  const row = imports.get(id) ?? fail(`No upload ${idOf("import", id)}. A later revision of the same file replaces an earlier upload.`);
  const st = importStatus(row);
  const g = st.generation;
  const stage: Record<string, string> = {
    uploading: `waiting for the file (${st.received} of ${st.size} bytes received); PUT it to the upload link`,
    stored: "received; text extraction is queued", extracting: `extracting text${st.pages ? ` (page ${st.page} of ${st.pages})` : ""}`,
    sizing: "measuring", awaiting_groups: "waiting for you to choose how to split it, in the app", queued: "splitting into sections",
    finalizing: "saving", imported: "imported", error: `failed: ${st.error ?? "unknown error"}`, cancelled: "cancelled",
  };
  const lines = [`# Upload ${idOf("import", id)}`, `${st.filename} → ${boardById(st.board_id).ref} · ${stage[st.stage] ?? st.stage}`];
  if (st.resource_id) {
    lines.push(`source: ${idOf("source", st.resource_id)} · ${q.sectionsOf.all(st.resource_id).length} sections`);
    if (origin) lines.push(`open: ${openLink(origin, st.board_id, st.resource_id)}`);
    if (g) lines.push(g.unstudied ? "cards: none (not studied; the reader can make them from the page)" : g.disabled ? "cards: not generated (no model key on this room)" : `cards: ${g.ready} of ${g.total} sections ready${g.busy ? `, ${g.busy} in progress` : ""}${g.failed ? `, ${g.failed} failed${g.error ? ` (${g.error})` : ""}` : ""}`);
  }
  return lines.join("\n");
}

// ---------- text ----------

const pageCache = new Map<string, string[]>();
function pages(rid: string): string[] {
  const hit = pageCache.get(rid);
  if (hit) { pageCache.delete(rid); pageCache.set(rid, hit); return hit; }
  const read = pagesOf(rid);
  pageCache.set(rid, read);
  if (pageCache.size > 4) pageCache.delete(pageCache.keys().next().value!);
  return read;
}
export const forgetPages = (rid: string): boolean => pageCache.delete(rid);

function pageRange(spec: unknown, total: number): [number, number] | null {
  if (spec === undefined || spec === null || spec === "") return null;
  const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(String(spec).trim());
  if (!m) return fail(`"pages" is a page or a range like "12-18".`);
  const from = Math.max(1, Number(m[1])), to = Math.min(total, Number(m[2] ?? m[1]));
  return from <= to ? [from, to] : fail(`Pages ${String(spec)} are outside this source (it has ${total}).`);
}
const pagesText = (all: string[], from: number, to: number) => all.slice(from - 1, to).map((t, i) => `[page ${from + i}]\n${t}`).join("\n\n");

export function text(idArg: unknown, pagesArg: unknown, cursor: unknown, budget: number): string {
  const r = refOf(idArg);
  const again = (c: string) => `get_text({ id: "${String(idArg)}"${pagesArg ? `, pages: "${String(pagesArg)}"` : ""}, cursor: "${c}" })`;
  if (r.kind === "source") {
    const s = a.sourceOne.get(r.id) ?? fail(`No source ${String(idArg)}.`);
    const all = s.kind === "pdf" ? pages(r.id) : [];
    if (all.length) {
      const range = pageRange(pagesArg, all.length) ?? [1, all.length];
      return pagedText(`# ${titleOf(s)} · pages ${range[0]}–${range[1]} of ${all.length}`, pagesText(all, range[0], range[1]), cursor, budget, again);
    }
    const body = a.sourceText.get(r.id)?.text;
    if (!body) return fail(`${String(idArg)} has no extracted text${s.kind === "pdf" ? `: ${pageTextStatus(r.id) ?? "a scanned PDF?"}` : ""}.`);
    return pagedText(`# ${titleOf(s)}`, body, cursor, budget, again);
  }
  if (r.kind === "section") {
    const x = q.section.get(r.id) ?? fail(`No section ${String(idArg)}.`);
    const all = pages(x.resource_id);
    if (!all.length) return text(idOf("source", x.resource_id), pagesArg, cursor, budget);
    if (x.content_ranges && !pagesArg) return pagedText(`# ${x.label}`, rangeText(JSON.parse(x.content_ranges) as ContentRange[], all), cursor, budget, again);
    const last = x.last_page === SECTION_TO_END ? all.length : Math.min(x.last_page, all.length);
    const range = pageRange(pagesArg, last) ?? [x.first_page, last];
    return pagedText(`# ${x.label} · pages ${range[0]}–${range[1]}`, pagesText(all, range[0], range[1]), cursor, budget, again);
  }
  return fail("get_text reads a source (src_…) or a section (sec_…). Use get_context for everything else.");
}

const clip = (s: string, budget: number): string => {
  const room = budget * 4;
  return s.length <= room ? s : `${s.slice(0, s.lastIndexOf("\n", room))}\n…cut to the size limit; narrow the request or raise max_tokens.`;
};

// ---------- changes ----------

export const CHANGE_KINDS = ["reviewed", "kept", "highlighted", "asked", "answered", "added", "finished", "logged"] as const;
type ChangeKind = (typeof CHANGE_KINDS)[number];

export function changes(b: Board, sinceArg: unknown, kindsArg: unknown, limitArg: unknown, cursor: unknown, budget: number, inline = false): string {
  const since = sinceOf(sinceArg) ?? Date.now() - 14 * 864e5;
  const want = new Set<ChangeKind>(Array.isArray(kindsArg) && kindsArg.length ? kindsArg.map(String).filter((k): k is ChangeKind => (CHANGE_KINDS as readonly string[]).includes(k)) : CHANGE_KINDS);
  const limit = Math.max(1, Math.min(200, Number(limitArg) || 50));
  const from = Number(/^o(\d+)$/.exec(String(cursor ?? ""))?.[1] ?? 0);
  const take = from + limit;
  const srcs = sourcesOf(b.id), decks = decksOf(b.id);
  const ev: { at: number; text: string }[] = [];
  if (want.has("reviewed")) {
    const cards = new Map<string, { type: string; payload: string } | undefined>();
    for (const g of a.gradesOfBoard.all(b.id, since, take + 1)) {
      if (!cards.has(g.card)) cards.set(g.card, a.cardById.get(g.card));
      const c = cards.get(g.card);
      const kept = a.keptAt.get(g.card);
      const d = decks.get(g.course);
      ev.push({ at: g.at, text: `- ${when.minute(g.at)} · **${g.got ? "got" : "missed"}** · ${idOf("card", g.card)}${kept ? " ★kept" : ""}\n  Q: ${c ? oneLine(facesOfCard(c.type, c.payload).question, 200) : "(card since regenerated)"}${d?.resource_id ? `\n  from ${idOf("source", d.resource_id)} "${titleOf(srcs.get(d.resource_id))}"` : ""}` });
    }
  }
  if (want.has("kept")) for (const k of a.keptSince.all(b.id, since, take + 1)) ev.push({ at: k.created_at, text: `- ${when.minute(k.created_at)} · kept · ${idOf("card", k.id)}\n  Q: ${oneLine(facesOfCard(k.type, k.payload).question, 200)}` });
  if (want.has("highlighted")) for (const m of a.marksSince.all(b.id, since, take + 1)) ev.push({ at: m.updated_at, text: `- ${when.minute(m.updated_at)} · highlighted · ${idOf("highlight", m.id)} in "${titleOf(srcs.get(m.resource_id))}"\n  > ${oneLine(m.quote, 160)}${m.note ? `\n  note: ${oneLine(m.note, 200)}` : ""}` });
  for (const m of a.mintedSince.all(b.id, since, take + 1)) {
    if (m.state === "open" && want.has("asked")) ev.push({ at: m.created_at, text: `- ${when.minute(m.created_at)} · asked · ${idOf("question", m.id)}\n  ${oneLine(m.front, 200)}` });
    if (m.state !== "open" && want.has("answered")) ev.push({ at: m.updated_at, text: `- ${when.minute(m.updated_at)} · answered · ${idOf("question", m.id)}\n  ${oneLine(m.front, 200)}` });
  }
  for (const s of a.resourcesSince.all(b.id, since, since, take + 1)) {
    if (want.has("added") && s.created_at >= since) ev.push({ at: s.created_at, text: `- ${when.minute(s.created_at)} · added · ${idOf("source", s.id)} "${titleOf(s)}"` });
    if (want.has("finished") && s.done_at && s.done_at >= since) ev.push({ at: s.done_at, text: `- ${when.minute(s.done_at)} · finished · ${idOf("source", s.id)} "${titleOf(s)}"` });
  }
  if (want.has("logged")) { const n = a.notesMeta.get(b.id); if (n && n.updated_at >= since) ev.push({ at: n.updated_at, text: `- ${when.minute(n.updated_at)} · log edited · ${b.ref}/log` }); }
  ev.sort((x, y) => y.at - x.at);
  const page = ev.slice(from, take);
  if (inline) return page.length ? page.map((e) => e.text).join("\n") : "Nothing.";
  const head = `# Changes · ${b.title} · since ${when.day(since)}${want.size < CHANGE_KINDS.length ? ` · ${[...want].join(", ")}` : ""}`;
  if (!page.length) return `${head}\n\nNothing ${from ? "more " : ""}since then.`;
  const more = ev.length > take ? `\n\n— more: get_changes({ board: "${b.ref}", since: "${when.day(since)}"${want.size < CHANGE_KINDS.length ? `, kinds: ${JSON.stringify([...want])}` : ""}, limit: ${limit}, cursor: "o${take}" })` : "\n\n— end";
  return `${head}\n${from + 1}–${from + page.length}${ev.length > take ? "" : ` of ${ev.length}`}\n\n${clip(page.map((e) => e.text).join("\n"), budget)}${more}`;
}

// ---------- search ----------

// A broad query stops early: only SHOWN matches are ever listed, and SCAN bounds the rows parsed for them.
const SHOWN = 25, SCAN = 400;
export const SEARCH_KINDS = ["card", "kept", "question", "highlight", "source", "log", "chat"] as const;

export function search(boardArg: unknown, queries: unknown, budget: number): string {
  if (!Array.isArray(queries) || !queries.length || queries.length > 10) return fail("queries is a list of 1 to 10 { kind, query } objects.");
  const boards = boardArg ? [boardOf(boardArg)] : a.boardsAll.all().map((x) => boardById(x.id));
  const out: string[] = [];
  for (const raw of queries) {
    const { kind, query } = (raw ?? {}) as { kind?: string; query?: string };
    if (!(SEARCH_KINDS as readonly string[]).includes(String(kind))) return fail(`kind is one of ${SEARCH_KINDS.join(", ")}.`);
    const needle = String(query ?? "").trim().toLowerCase();
    if (needle.length < 2) return fail("Each query needs at least two characters.");
    const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(needle);
    const hits: string[] = [];
    // Sources from every board, sorted newest first at the end, so "the latest talks" spans the room.
    const dated: { at: number; line: string }[] = [];
    for (const b of boards) {
      if (hits.length > SHOWN) break;
      const srcs = sourcesOf(b.id);
      if (kind === "card" || kind === "kept") {
        const plain = /^[\x20-\x7e]+$/.test(needle) && !/["\\]/.test(needle);
        const rows = kind === "kept" ? (plain ? a.keptMatching.all(b.id, needle, SCAN) : a.keptOfBoard.all(b.id))
          : (plain ? a.cardsMatching.all(b.id, needle, SCAN) : a.cardsOfBoard.all(b.id));
        for (const c of rows) {
          if (hits.length > SHOWN) break;
          const f = facesOfCard(c.type, c.payload);
          if (has(f.question) || has(f.answer)) hits.push(`- ${oneLine(f.question)} · ${idOf("card", c.id)}${kind === "kept" ? "" : a.keptAt.get(c.id) ? " ★kept" : ""} · ${b.ref}`);
        }
      } else if (kind === "question") {
        for (const m of a.mintedFull.all(b.id)) if (has(m.front) || has(m.back)) hits.push(`- [${m.state === "open" ? "open" : "answered"}] ${oneLine(m.front)} · ${idOf("question", m.id)} · ${b.ref}`);
      } else if (kind === "highlight") {
        for (const m of a.marksFull.all(b.id)) if (has(m.quote) || has(m.note)) hits.push(`- "${oneLine(m.quote, 120)}"${m.note ? ` — ${oneLine(m.note, 80)}` : ""} · ${idOf("highlight", m.id)} · "${titleOf(srcs.get(m.resource_id))}"`);
      } else if (kind === "source") {
        for (const s of srcs.values()) if (has(s.filename) || has(s.origin_url)) dated.push({ at: s.created_at, line: `- ${when.day(s.created_at)} · ${idOf("source", s.id)} "${titleOf(s)}" · ${b.ref}` });
        for (const x of q.sectionsOfBoard.all(b.id)) if (has(x.label) && x.label !== srcs.get(x.resource_id)?.filename) hits.push(`- ${idOf("section", x.id)} ${x.label} · in "${titleOf(srcs.get(x.resource_id))}"`);
      } else if (kind === "chat") {
        const plain = /^[\x20-\x7e]+$/.test(needle);
        const rows = plain ? a.chatMatching.all(b.id, needle, b.id, needle, SCAN) : a.chatOf.all(b.id, b.id);
        for (const m of rows) {
          if (hits.length > SHOWN) break;
          if (has(m.text)) hits.push(`- ${when.day(m.created_at)} · ${speaker(m)}: ${oneLine(m.text, 160)} · ${chatWhere(m, srcs)} · ${b.ref}/chat`);
        }
      } else {
        const lines = (a.notesMeta.get(b.id)?.text ?? "").split("\n");
        lines.forEach((l, i) => { if (has(l)) hits.push(`- ${b.ref}/log line ${i + 1}: ${oneLine(l, 200)}`); });
      }
    }
    if (dated.length) hits.unshift(...dated.sort((x, y) => y.at - x.at).map((d) => d.line));
    const many = hits.length > SHOWN;
    out.push(`## ${kind}: "${String(query)}" · ${many ? `more than ${SHOWN} matches` : `${hits.length} match${hits.length === 1 ? "" : "es"}`}`,
      ...(hits.length ? hits.slice(0, SHOWN) : ["No matches."]), ...(many ? ["…and more; narrow the query or name a board."] : []), "");
  }
  return `# Search\n\n${clip(out.join("\n").trimEnd(), budget)}`;
}
