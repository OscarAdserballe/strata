import type { GeminiUsage } from "../../platform/llm/gemini.ts";
import { logEvent } from "../../platform/events/events.ts";
import { runTurn, runTurnStreaming } from "./turn.ts";
import { APP, deps } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import type { ServerResponse } from "node:http";
import { q } from "../repo.ts";
import { now } from "../../platform/db/sql.ts";
import { boardRev } from "../boards/repo.ts";
import type { MsgRow } from "../../platform/db/rows.ts";
import { sourceForTurn, whereBlock, type Here } from "./context.ts";
import { sendJson, sseOpen } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
// the board-state builder registers itself on load: a write that names stateOf() needs it
import "../boards/state.ts";
import { sourceFence } from "../sources/fence.ts";
import { INBOX_ID } from "../boards/unfiled.ts";
import { forModel, turnImagesRefusal } from "../images/images.ts";

// A clear invalidates even a pending first turn, which has no message rows yet.
db.exec(`CREATE TABLE IF NOT EXISTS thread_revisions (
  board TEXT NOT NULL, resource TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(board,resource)
)`);
const revision = db.prepare("SELECT revision FROM thread_revisions WHERE board=? AND resource=?");
const bumpRevision = db.prepare(`INSERT INTO thread_revisions(board,resource,revision) VALUES(?,?,1)
  ON CONFLICT(board,resource) DO UPDATE SET revision=revision+1`);

const ASK_ID = /^ak-[0-9a-f]{8,32}$/;
interface AskIn { id?: unknown; start?: unknown; end?: unknown; quote?: unknown; page?: unknown; rects?: unknown; box?: unknown }
type AskAt = { id: string; start: number; end: number; quote: string; page: number | null; rects: number[][]; box: string | null };
// the words a question is asked at: on the source the turn is on, never moved once asked
function askOf(raw: AskIn | null | undefined): AskAt | string | null {
  if (raw == null) return null;
  const id = String(raw.id ?? ""), start = Number(raw.start), end = Number(raw.end), quote = String(raw.quote ?? "").trim().slice(0, 4000);
  if (!ASK_ID.test(id)) return "an ask's id is ak- and hex";
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || !quote) return "an ask names its words: start, end and quote";
  const rects = Array.isArray(raw.rects) ? (raw.rects as unknown[]).filter((r): r is number[] => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === "number")).slice(0, 64) : [];
  const page = raw.page == null ? null : Number(raw.page);
  return { id, start, end, quote, page: Number.isInteger(page) ? page : null, rects, box: raw.box == null ? null : String(raw.box).slice(0, 200) };
}

// Same field names as the distil events, so one query costs both.
const usageProps = (u?: GeminiUsage): Record<string, number> =>
  u ? { promptTokens: u.prompt, outputTokens: u.output, thoughtsTokens: u.thoughts, cachedTokens: u.cached } : {};

const CHANGED = "Conversation changed while the reply was being written. Please try again.";
const messageAt = db.prepare("SELECT role, text, resource_id, archived, ask_id FROM messages WHERE board_id = ? AND idx = ?");
const messageById = db.prepare("SELECT text FROM messages WHERE id = ?");

// One turn at a time per thread, so a re-asked question can never interleave as Q1 Q2 A1 A2.
const turnsOn = new Map<string, Promise<void>>();
async function oneTurnAtATime<T>(thread: string, fn: () => Promise<T>): Promise<T> {
  const before = turnsOn.get(thread);
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = before ? before.then(() => mine) : mine;
  turnsOn.set(thread, tail);
  try { if (before) await before; return await fn(); }
  finally { release(); if (turnsOn.get(thread) === tail) turnsOn.delete(thread); }
}

// Skip unanswered questions: a failed call can leave two user turns in a row.
function answered(rows: MsgRow[], own: number): MsgRow[] {
  const kept = rows.filter((m) => m.idx !== own);
  return kept.filter((m, i) => m.role !== "user" || kept[i + 1]?.role === "assistant");
}

// Replays read the reply by row id, not idx: filing a source to another board renumbers its turns.
function answerAgain(res: ServerResponse, boardId: string, sse: boolean, status: number, body: unknown): void {
  if (!sse) { sendJson(res, status, body); return; }
  const send = sseOpen(res);
  const b = (body ?? {}) as { userIdx?: number; replyIdx?: number; replyId?: number; error?: string };
  if (status !== 200) { send("error", { error: b.error ?? CHANGED }); res.end(); return; }
  send("start", { userIdx: b.userIdx, replyIdx: b.replyIdx });
  const byIdx = () => { const m = messageAt.get(boardId, b.replyIdx ?? -1) as { role: string; text: string } | undefined; return m?.role === "assistant" ? m.text : ""; };
  const text = typeof b.replyId === "number" ? (messageById.get(b.replyId) as { text: string } | undefined)?.text ?? "" : byIdx();
  send("delta", { t: text });
  send("done", body);
  res.end();
}

export const chatRoutes: Route[] = [
  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/messages$/, ({res,url,params}) => {
    const board = params[0], rid = url.searchParams.get("resource") || null;
    // The Unfiled board is made on first use: until then the library's thread is empty, not missing.
    if (board === INBOX_ID && !rid && !q.board.get(board)) { sendJson(res,200,{messages:[],before:null,rev:0}); return; }
    if (!q.board.get(board) || (rid && !q.resource.get(board,rid))) { sendJson(res,404,{error:"no such conversation"}); return; }
    const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
    const rows = q.threadPage.all(board,rid,rid,before,101);
    const more = rows.length>100; if (more) rows.pop();
    const messages = rows.reverse().map(m=>({role:m.role,text:m.text,idx:m.idx,resourceId:rid,ask:m.ask_id ?? null}));
    sendJson(res,200,{messages,before:more ? messages[0].idx : null,rev:boardRev(board)});
  }),
  // Two commits: the question is stored before the model call, the reply after; no transaction spans the stream.
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/chat$/, async ({ req, res, ssn, params, body, phase, open, close }) => {
    const boardId = params[0];
    if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ message?: string; focus?: string | null; here?: Here; ask?: AskIn | null }>();
    const userMsg = String(b.message ?? "").trim(); if (!userMsg) { sendJson(res, 400, { error: "empty message" }); return; }
    const badImages = turnImagesRefusal(userMsg); if (badImages) { sendJson(res, 400, { error: badImages }); return; }
    const sse = (req.headers.accept ?? "").includes("text/event-stream");
    if (phase.at === "done") { answerAgain(res, boardId, sse, phase.status, phase.body); return; }
    const t0 = Date.now();
    const asked: Here = b.here ?? {};
    const sec = asked.sectionId ? (q.section.get(asked.sectionId) as { resource_id: string; board_id: string } | undefined) : undefined;
    const rid = asked.thread !== undefined ? (asked.thread || null) : sec && sec.board_id === boardId ? sec.resource_id : (b.focus ?? null);
    const here: Here = sec && sec.board_id === boardId && sec.resource_id !== rid ? { ...asked, sectionId: null } : asked;
    if (rid && !q.resource.get(boardId,rid)) { sendJson(res,404,{error:"no such source"}); return; }
    const ask = askOf(b.ask);
    if (typeof ask === "string") { sendJson(res, 400, { error: ask }); return; }
    if (ask && !rid) { sendJson(res, 400, { error: "words are asked at on a source" }); return; }
    const heldAsk = ask ? q.ask.get(boardId, ask.id) : undefined;
    if (ask && heldAsk && heldAsk.resource_id !== rid) { sendJson(res, 409, { error: "that ask is on another source" }); return; }
    const sourceCurrent = rid ? sourceFence(db,rid,boardId,sec ? here.sectionId ?? undefined : undefined) : () => !!q.board.get(boardId);
    await oneTurnAtATime(`${boardId}/${rid ?? ""}`, async () => {
      // The board may have gone while an earlier turn held its thread.
      if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
      // Read once the thread is ours: a clear made while an earlier turn held it came first.
      const startedRevision = revision.get(boardId,rid ?? "")?.revision ?? 0;

      let userIdx: number;
      if (phase.at === "open") {
        userIdx = Number((phase.body as { userIdx?: unknown } | null)?.userIdx);
        const asked = messageAt.get(boardId, userIdx) as { role: string; text: string; resource_id: string | null; archived: number; ask_id: string | null } | undefined;
        // Cleared since the first try, or the idx now holds another message: the turn is over.
        if (!asked || asked.archived || asked.role !== "user" || asked.text !== userMsg || (asked.resource_id ?? null) !== rid || (asked.ask_id ?? null) !== (ask?.id ?? null)) {
          const out = close(() => ({ status: 409, body: { error: CHANGED } }));
          answerAgain(res, boardId, sse, out.status, out.body); return;
        }
      } else {
        userIdx = open(() => {
          const idx = (q.nextMsgIdx.get(boardId) as { n: number }).n;
          if (ask && !q.ask.get(boardId, ask.id)) q.insAsk.run(ask.id, boardId, rid, ask.page, ask.start, ask.end, ask.quote, ask.rects.length ? JSON.stringify(ask.rects) : null, ask.box, now(), now());
          q.insAskMsg.run(boardId, rid, "user", userMsg, null, JSON.stringify([]), idx, now(), ask?.id ?? null);
          return { status: 202, body: { userIdx: idx } };
        }).body.userIdx;
      }

      const history = answered(q.threadOf.all(boardId, rid, rid) as MsgRow[], userIdx)
        .map((m) => ({ role: (m.role === "user" ? "user" : "model") as "user" | "model", ...forModel(m.text) }));
      // The card's images come first: the WHERE block names the card before the question.
      const held = ask ? q.ask.get(boardId, ask.id) : undefined;
      const whereRaw = whereBlock(boardId, here, held?.quote ?? null);
      const onCard = forModel(whereRaw);
      const question = forModel(userMsg, onCard.files?.length ?? 0);
      const images = [...(onCard.files ?? []), ...(question.files ?? [])];
      const { files, sources } = sourceForTurn(boardId, here.sectionId ?? null, b.focus ?? null);
      const where = onCard.text;
      const finish = (reply: string, turn: Record<string, unknown>) => close(() => {
        if (!sourceCurrent() || (revision.get(boardId,rid ?? "")?.revision ?? 0) !== startedRevision) return { status: 409, body: { error: CHANGED } };
        const replyIdx = (q.nextMsgIdx.get(boardId) as { n: number }).n;
        const replyId = Number(q.insAskMsg.run(boardId, rid, "assistant", reply, null, JSON.stringify([]), replyIdx, now(), ask?.id ?? null).lastInsertRowid);
        logEvent(db, APP, "chat_turn", turn, ssn);
        return { status: 200, body: { state: stateOf(boardId, rid), replyIdx, userIdx, replyId } };
      });

      if (sse) {
        const send = sseOpen(res);
        send("start", { userIdx, replyIdx: userIdx + 1 });
        let firstAt = 0, result;
        try {
          result = await runTurnStreaming({ history, userMsg: question.text, images: images.length ? images : undefined, files, sources, where }, deps, (t) => { if (!firstAt) firstAt = Date.now(); send("delta", { t }); });
        }
        // The question stays stored and the receipt open, so the same key can resume.
        catch (e) {
          console.error(`[chat ${boardId}]`, e);
          send("error", { error: e instanceof Error ? e.message : "model error", ...(req.headers["idempotency-key"] ? { resumable: true } : {}) });
          res.end(); return;
        }
        const out = finish(result.reply, { board: boardId, ms: Date.now() - t0, ttfbMs: firstAt ? firstAt - t0 : null, stream: true, resources: files.length + (sources ? 1 : 0), images: images.length + history.reduce((n, t) => n + (t.files?.length ?? 0), 0), turns: history.length, srcChars: sources.length, grounded: !!where, ...usageProps(result.usage) });
        send(out.status === 200 ? "done" : "error", out.body);
        res.end(); return;
      }

      let result; try { result = await runTurn({ history, userMsg: question.text, images: images.length ? images : undefined, files, sources, where }, deps); }
      catch (e) { console.error(`[chat ${boardId}]`, e); sendJson(res, 502, { error: e instanceof Error ? e.message : "model error" }); return; }
      const out = finish(result.reply, { board: boardId, ms: Date.now() - t0, turns: history.length, srcChars: sources.length, grounded: !!where, ...usageProps(result.usage) });
      sendJson(res, out.status, out.body);
    });
  }, { receipt: "stream" }),

  // A clear archives rows rather than deleting them; only deleting the board removes the record.
  route("DELETE", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/messages$/, ({ res, ssn, params, url, commit }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const rid = url.searchParams.get("resource") || null;
    // A retried clear replays: bumping the revision again would fence a turn asked after the first clear.
    commit(() => {
      bumpRevision.run(boardId,rid ?? "");
      q.archiveThread.run(boardId, rid, rid);
      logEvent(db, APP, "chat_clear", { board: boardId, resource: rid }, ssn);
      // Turns at or below `floor` are archived; an in-flight reply must not bring one back.
      const floor = (q.nextMsgIdx.get(boardId) as { n: number }).n - 1;
      return { status: 200, body: { state: stateOf(boardId, rid), floor } };
    });
  }, { receipt: "atomic" }),
];
