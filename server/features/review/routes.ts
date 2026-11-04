import type { GeminiTurn, GeminiUsage } from "../../platform/llm/gemini.ts";
import { logEvent } from "../../platform/events/events.ts";
import { q } from "../repo.ts";
import { now, parseJson } from "../../platform/db/sql.ts";
import { db } from "../../platform/db/db.ts";
import { APP, deps } from "../../platform/config.ts";
import { REVIEW_SYSTEM, cardFace, reviewCardBlock } from "../ask/prompts.ts";
import { runTurnStreaming } from "../ask/turn.ts";
import { addCardMessage, cardMessageAt, cardThread, clearCardThread } from "../ask/card-threads.ts";
import { LADDER_DAYS, dueAtOf, keptQueue, replayGrades } from "./ladder.ts";
import { reviewSchedules } from "../../platform/projections.ts";
import { pagesOf } from "../sources/blobs.ts";
import { sourceForTurn } from "../ask/context.ts";
import { sendJson, sseOpen } from "../../platform/http/http.ts";
import { route, type Route } from "../../platform/router/router.ts";
import { forModel, turnImagesRefusal } from "../images/images.ts";
import type {
  CardHistory, ReviewCard, ReviewState, SessionMapResponse, SessionTopic, SessionClaim, SessionMet, TreeNode,
} from "../../../shared/types/index.ts";

// The cap only defers: `total` still reports the true backlog.
const SESSION_CAP = 60;

export const flatten = (nodes: TreeNode[] | undefined, depth: number, out: SessionClaim[]): SessionClaim[] => {
  for (const n of nodes || []) {
    out.push({ id: n.id, label: n.label || "", depth, kind: n.kind ?? null, met: [] });
    flatten(n.children, depth + 1, out);
  }
  return out;
};

// First pairing wins: a topic needs one place.
const pairIndex = (): Map<string, { id: string; label: string | null; board_id: string; section_id: string | null; resource_id: string | null }> => {
  const m = new Map<string, { id: string; label: string | null; board_id: string; section_id: string | null; resource_id: string | null }>();
  for (const p of q.pairsWithDeck.all()) if (!m.has(p.deck)) m.set(p.deck, p);
  return m;
};

const treeOf = (sectionId: string | null | undefined): { title: string; question: string; claims: SessionClaim[] } | null => {
  const row = sectionId ? q.tree.get(sectionId) : null;
  const json = row && row.json ? parseJson<{ nodes?: TreeNode[] }>(row.json, {}) : null;
  return row && json ? { title: row.title || "", question: row.question || "", claims: flatten(json.nodes, 0, []) } : null;
};

// Text only, capped harder than a board turn: a shuffled queue never hits the cache.
const REVIEW_SRC_CHARS = Number(process.env.STRATA_REVIEW_SRC_CHARS ?? 24_000);
const clip = (t: string): string =>
  t.length > REVIEW_SRC_CHARS ? `${t.slice(0, REVIEW_SRC_CHARS)}\n…(truncated — you have the opening of this section, not all of it)` : t;

function reviewSource(pair: { board_id: string; section_id: string | null; resource_id: string | null }): string {
  const { files, sources } = sourceForTurn(pair.board_id, pair.section_id, pair.resource_id);
  if (sources) return clip(sources.replace(/^THE (SECTION|SOURCE) THEY HAVE OPEN/, "THE $1 THE CARD CAME FROM"));
  if (!files.length || !pair.resource_id) return "";
  // Never the whole file: use page text, or send nothing if it was never extracted.
  const pages = pagesOf(pair.resource_id);
  if (!pages.length) return "";
  return clip(`THE SOURCE THE CARD CAME FROM (this is all you have been given of it):\n\n${pages.map((t, i) => `[page ${i + 1}]\n${t}`).join("\n\n")}`);
}

const usageProps = (u?: GeminiUsage): Record<string, number> =>
  u ? { promptTokens: u.prompt, outputTokens: u.output, thoughtsTokens: u.thoughts, cachedTokens: u.cached } : {};

// Review grades carry no board and `review: true`; drill grades carry their board and no flag.
const BOARD_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const count = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1_000_000;
// Prepared once: this runs on every drill keypress.
type Stmt = ReturnType<typeof db.prepare>;
let gradeSql: { receipt: Stmt; insReceipt: Stmt; insGrade: Stmt } | null = null;
const gradeStmts = () => gradeSql ??= {
  receipt: db.prepare("SELECT * FROM review_receipts WHERE id = ?"),
  insReceipt: db.prepare("INSERT INTO review_receipts (id,card,course,got,at) VALUES (?,?,?,?,?)"),
  insGrade: db.prepare("INSERT INTO events (ts,session,app,event,props) VALUES (?,?,?,'card_grade',?)"),
};

export const reviewRoutes: Route[] = [
  route("POST", "/api/review/grade", async ({ res, ssn, body, commit }) => {
    const b = await body<{ requestId: string; course: string; card: string; got: boolean; ms?: number;
      surface?: string; board?: string; pass?: number; passes?: number; solo?: boolean; pos?: number }>(8192);
    if (typeof b.requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(b.requestId)
      || typeof b.course !== "string" || typeof b.card !== "string" || typeof b.got !== "boolean") {
      sendJson(res, 400, { error: "A review needs a card, verdict and save identifier." }); return;
    }
    const drill = b.surface === "drill";
    if (b.surface !== undefined && b.surface !== "review" && !drill) { sendJson(res, 400, { error: "A grade comes from the review or the drill." }); return; }
    if (drill && (typeof b.board !== "string" || !BOARD_ID.test(b.board) || (b.solo !== undefined && typeof b.solo !== "boolean")
      || [b.pass, b.passes, b.pos].some((n) => n !== undefined && !count(n)))) {
      sendJson(res, 400, { error: "A drill grade needs the board it was drilled on." }); return;
    }
    const sql = gradeStmts();
    const previous = sql.receipt.get(b.requestId);
    if (previous) {
      if (previous.card !== b.card || previous.course !== b.course || previous.got !== Number(b.got)) {
        sendJson(res, 409, { error: "This review identifier already saved a different verdict." }); return;
      }
      sendJson(res, 200, { saved: true, at: previous.at }); return;
    }
    const card = q.card.get(b.course, b.card) ?? (drill ? q.drop.get(b.course, b.card) : undefined);
    if (!card) { sendJson(res, 404, { error: "No such card." }); return; }
    const at = now();
    const ms = Number.isFinite(b.ms) ? { ms: Math.max(0, b.ms!) } : {};
    const props = drill
      ? { board: b.board, deck: card.deck, card: card.id, type: card.type, got: b.got, requestId: b.requestId,
          solo: !!b.solo, ...(b.pass !== undefined ? { pass: b.pass } : {}), ...(b.passes !== undefined ? { passes: b.passes } : {}),
          ...(b.pos !== undefined ? { pos: b.pos } : {}), ...ms }
      : { review: true, card: card.id, deck: card.deck, type: card.type, got: b.got, requestId: b.requestId, ...ms };
    commit(() => {
      sql.insReceipt.run(b.requestId, card.id, card.course, Number(b.got), at);
      // This is authoritative state: errors must reach the client, unlike analytics.
      sql.insGrade.run(at, ssn, APP, JSON.stringify(props));
      if (drill) q.touchBoard.run(at, b.board!);
      return { status: 200, body: { saved: true, at } };
    });
  }, { receipt: "atomic", maxBody: 8192 }),
  route("GET", "/api/review/history", ({ res, url }) => {
    const card = q.card.get(url.searchParams.get("course") ?? "", url.searchParams.get("card") ?? "");
    if (!card) { sendJson(res, 404, { error: "No such card." }); return; }
    const added = q.cardAddedAt.get(card.id, card.course);
    const history: CardHistory = {
      addedAt: added?.card_at ?? null,
      sourceAddedAt: added?.source_at ?? null,
      keptAt: q.cardKeptAt.get(card.id)?.created_at ?? null,
      reviews: q.cardReviewHistory.all(card.id).map(r => ({ at: r.ts, got: !!r.got })),
    };
    sendJson(res, 200, history);
  }),
  route("GET", "/api/review", ({ res }) => {
    const t = now();
    // Only kept cards are owed; unkept due cards are only counted.
    const kept = new Map(q.keptAll.all().map((r) => [r.id, r.created_at] as const));
    const sched = reviewSchedules(db, replayGrades);
    const { due: owed, unkeptDue, nextDueAt } = keptQueue(sched, kept, t);
    const titles = new Map((q.courses.all() as { slug: string; title: string }[]).map((c) => [c.slug, c.title]));
    const ids = new Set(q.cardIds.all().map((c) => c.id));
    const selected = owed.filter(([id]) => ids.has(id)).sort((a,b) => a[1].dueAt-b[1].dueAt);
    const due: ReviewCard[] = [];
    for (const [id, s] of selected.slice(0, SESSION_CAP)) {
      const c = q.cardAny.get(id);
      if (!c) continue; // card dropped since
      due.push({
        ...parseJson<Record<string, unknown>>(c.payload, {}),
        id: c.id, deck: c.deck, type: c.type, ord: c.ord,
        // Sent back as If-Match, so a rewrite on another device is refused, not overwritten.
        rev: c.rev ?? 0,
        course: c.course, courseTitle: titles.get(c.course) ?? c.course,
        rung: s.rung, dueAt: dueAtOf(s),
      });
    }
    due.sort((a, b) => a.dueAt - b.dueAt);
    const body: ReviewState = { cards: due, total: selected.length, nextDueAt, unkeptDue };
    sendJson(res, 200, body);
  }),

  // `since` is the client's local midnight: only the browser knows the timezone.
  route("GET", "/api/review/session", ({ res, url }) => {
    const t = now();
    const asked = Number(url.searchParams.get("since"));
    const since = Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(asked, t - 7 * 864e5), t) : t - 18 * 36e5;

    const grades = q.sessionGrades.all(since);
    const byId = new Map(q.allCards.all().map((c) => [c.id, c]));

    // One row per card met, not per grade: a missed card can come round twice in a sitting.
    const met = new Map<string, SessionMet & { course: string; node: string | null }>();
    for (const g of grades) {
      const c = byId.get(g.card);
      if (!c) continue; // card dropped since
      const p = parseJson<Record<string, unknown>>(c.payload, {});
      const front = String((c.type === "mcq" ? p.stem : c.type === "trick" ? p.problem : p.front) ?? "");
      const got = !!g.got;
      const prev = met.get(g.card);
      if (prev) { prev.got = got; prev.missed = prev.missed || !got; continue; }
      met.set(g.card, {
        card: c.id, front, type: c.type, got, missed: !got,
        course: c.course, node: typeof p.node === "string" ? p.node : null,
      });
    }

    // A gap this long ends one sitting and starts the next.
    const GAP = 20 * 6e4;
    let sittings = 0, minutesMs = 0, sitStart = 0, last = 0;
    for (const g of grades) {
      if (!sitStart || g.ts - last > GAP) { if (sitStart) minutesMs += last - sitStart; sittings++; sitStart = g.ts; }
      last = g.ts;
    }
    if (sitStart) minutesMs += last - sitStart;

    // Same fold and kept gate as the queue, so the map and the launcher never disagree.
    const kept = new Map(q.keptAll.all().map((r) => [r.id, r.created_at] as const));
    const sched = reviewSchedules(db, replayGrades);
    const dueByCourse = new Map<string, number>();
    let dueLeft = 0;
    for (const [id, s] of keptQueue(sched, kept, t).due) {
      const c = byId.get(id);
      if (!c) continue;
      dueLeft++;
      dueByCourse.set(c.course, (dueByCourse.get(c.course) || 0) + 1);
    }

    const deckTotals = new Map<string, number>();
    for (const c of byId.values()) deckTotals.set(c.course, (deckTotals.get(c.course) || 0) + 1);

    const titles = new Map((q.courses.all() as { slug: string; title: string }[]).map((c) => [c.slug, c.title]));
    const pairs = pairIndex();
    const boardTitles = new Map<string, string>();

    const topics = new Map<string, SessionTopic>();
    for (const m of met.values()) {
      let topic = topics.get(m.course);
      if (!topic) {
        const pair = pairs.get(m.course) || null;
        let boardTitle: string | null = null;
        if (pair) {
          if (!boardTitles.has(pair.board_id)) {
            const b = q.board.get(pair.board_id);
            boardTitles.set(pair.board_id, b ? b.title : "");
          }
          boardTitle = boardTitles.get(pair.board_id) || null;
        }
        topic = {
          course: m.course, courseTitle: titles.get(m.course) ?? m.course,
          label: pair ? pair.label : null, board: pair ? pair.board_id : null, boardTitle,
          section: pair ? pair.section_id : null, resource: pair ? pair.resource_id : null,
          met: 0, got: 0, missed: 0,
          deckTotal: deckTotals.get(m.course) || 0, dueLeft: dueByCourse.get(m.course) || 0,
          tree: treeOf(pair && pair.section_id),
          loose: [],
        };
        topics.set(m.course, topic);
      }
      const card: SessionMet = { card: m.card, front: m.front, type: m.type, got: m.got, missed: m.missed };
      topic.met++;
      if (m.missed) topic.missed++; else topic.got++;
      const claim = m.node && topic.tree ? topic.tree.claims.find((c) => c.id === m.node) : null;
      if (claim) claim.met.push(card); else topic.loose.push(card);
    }

    const list = [...topics.values()].sort((a, b) =>
      b.missed - a.missed || b.met - a.met || a.courseTitle.localeCompare(b.courseTitle));

    const body: SessionMapResponse = {
      since,
      cards: met.size,
      got: [...met.values()].filter((m) => !m.missed).length,
      missed: [...met.values()].filter((m) => m.missed).length,
      sittings, minutes: Math.round(minutesMs / 6e4), dueLeft, topics: list,
    };
    sendJson(res, 200, body);
  }),

  route("GET", "/api/review/tree", ({ res, url }) => {
    const course = url.searchParams.get("course") || "";
    const pair = course ? pairIndex().get(course) || null : null;
    const tree = treeOf(pair && pair.section_id);
    const titles = new Map((q.courses.all() as { slug: string; title: string }[]).map((c) => [c.slug, c.title]));
    sendJson(res, 200, {
      course,
      courseTitle: titles.get(course) ?? course,
      label: pair ? pair.label : null,
      board: pair ? pair.board_id : null,
      pair: pair ? pair.id : null,
      section: pair ? pair.section_id : null,
      resource: pair ? pair.resource_id : null,
      tree,
    });
  }),
  // The event carries no board: asking about a card must not bump touched_at and reorder the launcher.
  route("POST", "/api/review/chat", async ({ res, ssn, body, phase, open, close }) => {
    const b = await body<{ card?: string; course?: string; message?: string; rung?: number; picked?: number | null; history?: { role?: string; text?: string }[] }>();
    const userMsg = String(b.message ?? "").trim();
    if (!userMsg) { sendJson(res, 400, { error: "empty message" }); return; }
    const badImages = turnImagesRefusal(userMsg); if (badImages) { sendJson(res, 400, { error: badImages }); return; }
    const row = b.card && b.course ? q.card.get(String(b.course), String(b.card)) : undefined;
    if (!row) { sendJson(res, 404, { error: "no such card" }); return; }

    const p = parseJson<Record<string, unknown>>(row.payload, {});
    const titles = new Map((q.courses.all() as { slug: string; title: string }[]).map((c) => [c.slug, c.title]));
    const pair = pairIndex().get(row.course) || null;
    const tree = treeOf(pair && pair.section_id);
    const node = typeof p.node === "string" ? p.node : null;
    const claim = node && tree ? tree.claims.find((c) => c.id === node) : null;
    const rung = Number.isFinite(b.rung) ? Math.min(Math.max(Number(b.rung), 0), LADDER_DAYS.length - 1) : null;

    const face = cardFace(row.type, p, typeof b.picked === "number" ? b.picked : null);
    const where = reviewCardBlock({
      courseTitle: titles.get(row.course) ?? row.course,
      where: pair ? pair.label : null,
      claim: claim ? claim.label : null,
      holdingDays: rung ? LADDER_DAYS[rung] : null,
      type: row.type, prompt: face.prompt, answer: face.answer, picked: face.picked,
    });
    const sources = pair ? reviewSource(pair) : "";
    const send = sseOpen(res);
    if (phase.at === "done") {
      const d = (phase.body ?? {}) as { userIdx?: number; replyIdx?: number; error?: string };
      if (phase.status !== 200) { send("error", { error: d.error ?? "model error" }); res.end(); return; }
      send("start", { userIdx: d.userIdx, replyIdx: d.replyIdx });
      send("delta", { t: cardMessageAt(row.course, row.id, d.replyIdx ?? -1)?.text ?? "" });
      // Send the thread so a reply lost to a broken stream is shown again.
      send("done", { ...d, messages: cardThread(row.course, row.id) }); res.end(); return;
    }
    let userIdx: number;
    if (phase.at === "open") {
      userIdx = Number((phase.body as { userIdx?: unknown } | null)?.userIdx);
      const asked = cardMessageAt(row.course, row.id, userIdx);
      if (!asked || asked.archived || asked.role !== "user" || asked.text !== userMsg) {
        const out = close(() => ({ status: 409, body: { error: "Conversation changed while the reply was being written. Please try again." } }));
        send("error", out.body); res.end(); return;
      }
    } else {
      userIdx = open(() => ({ status: 202, body: { userIdx: addCardMessage(row.course, row.id, "user", userMsg) } })).body.userIdx;
    }
    const kept = cardThread(row.course, row.id).filter((m) => m.idx !== userIdx);
    const history: GeminiTurn[] = kept
      .filter((m, i) => m.role !== "user" || kept[i + 1]?.role === "assistant")
      .map((m) => ({ role: (m.role === "user" ? "user" : "model") as "user" | "model", ...forModel(m.text) }));
    // The card's own pictures ride ahead of the question's: the model reads the card it is asked about.
    const onCard = forModel(where);
    const question = forModel(userMsg, onCard.files?.length ?? 0);
    const images = [...(onCard.files ?? []), ...(question.files ?? [])];

    const t0 = Date.now();
    send("start", { userIdx });
    let firstAt = 0, result;
    try {
      result = await runTurnStreaming({ history, userMsg: question.text, images: images.length ? images : undefined, sources, where: onCard.text, system: REVIEW_SYSTEM }, deps,
        (t) => { if (!firstAt) firstAt = Date.now(); send("delta", { t }); });
    } catch (e) {
      console.error(`[review chat ${row.id}]`, e);
      // the question stays stored and the receipt open: the same key resumes from here
      send("error", { error: e instanceof Error ? e.message : "model error", resumable: true }); res.end(); return;
    }
    const out = close(() => {
      const asked = cardMessageAt(row.course, row.id, userIdx);
      if (!asked || asked.archived) return { status: 409, body: { error: "Conversation changed while the reply was being written. Please try again." } };
      return { status: 200, body: { userIdx, replyIdx: addCardMessage(row.course, row.id, "assistant", result.reply) } };
    });
    logEvent(db, APP, "review_chat", {
      review: true, card: row.id, course: row.course, deck: row.deck, type: row.type, rung,
      ms: Date.now() - t0, ttfbMs: firstAt ? firstAt - t0 : null,
      turns: history.length, srcChars: sources.length, grounded: !!sources,
      ...usageProps(result.usage),
    }, ssn);
    send(out.status === 200 ? "done" : "error", { ...(out.body as object), messages: cardThread(row.course, row.id) });
    res.end();
  }, { receipt: "stream" }),
  route("GET", "/api/review/chat", ({ res, url }) => {
    const course = url.searchParams.get("course") ?? "", card = url.searchParams.get("card") ?? "";
    sendJson(res, 200, { messages: cardThread(course, card), before: null });
  }),
  route("DELETE", "/api/review/chat", ({ res, url, commit }) => {
    const course = url.searchParams.get("course") ?? "", card = url.searchParams.get("card") ?? "";
    commit(() => { clearCardThread(course, card); return { status: 200, body: { messages: [] } }; });
  }, { receipt: "atomic" }),
];
