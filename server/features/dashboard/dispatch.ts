// Dispatch: a thread Claude answers with one HTML page per version, every version kept; the last press says where the next lands.
import { genId, now } from "../../platform/db/sql.ts";
import { MAX_UPLOAD_BYTES } from "../../platform/config.ts";
import { insertBoard } from "../boards/create.ts";
import { agentRepo as a } from "../agent/repo.ts";
import { htmlSource, prepareSource, writeSource, type PreparedSource } from "../sources/ingest.ts";
import { bytesOf } from "../sources/blobs.ts";
import { DashError, stageOf } from "./dashboard.ts";
import { dashboardRepo as q, type PressRow, type TaskRow, type VersionRow } from "./repo.ts";
import type { Link } from "./dashboard.ts";

const fail = (msg: string): never => { throw new DashError(msg); };
export const HANDLE = "dispatch";
export const PRESS_LABEL: Record<string, string> = { send: "Send", go: "Go", back: "Send back" };
const SENDABLE = ["backlog", "todo"];
const ON_YOU = ["decide", "review"];

/** Where the next page lands, from the newest press: Send back stays, Go moves on, a sent thread starts in Decide. */
export function landsIn(p: Pick<PressRow, "kind" | "stage"> | undefined): "decide" | "review" | "done" {
  if (!p || p.kind === "send") return "decide";
  if (p.kind === "back") return p.stage === "review" ? "review" : "decide";
  return p.stage === "review" ? "done" : "review";
}

const ended = (stage: string): boolean => stage === "done" || stage === "dropped";
function moveTo(t: TaskRow, stage: string, at: number): void {
  q.setStage.run(stage, ended(stage) ? stage : "you", ended(stage) ? (t.cleared_at ?? at) : null, at, t.id);
}

const thread = (id: string): TaskRow => q.task.get(id) ?? fail(`No thread ${id}.`);

/** Backlog or to-do → Implementing: Claude prepares the first page. */
export function sendThread(id: string, sessionUrl: string | null): PressRow {
  const t = thread(id), stage = stageOf(t);
  if (!SENDABLE.includes(stage)) fail(`Only a thread in the backlog or to-do is sent; this one is in ${stage}.`);
  return press(t, "send", stage, null, sessionUrl);
}

/** Go or Send back on the page in Decide or Review: stored as the thread's newest note, and it goes to Claude. */
export function pressThread(id: string, kind: unknown, sessionUrl: string | null): PressRow {
  if (kind !== "go" && kind !== "back") fail("kind is go or back.");
  const t = thread(id), stage = stageOf(t);
  if (!ON_YOU.includes(stage)) fail(`Go and Send back are for a thread in Decide or Review; this one is in ${stage}.`);
  const v = q.lastN.get(id)!.n;
  if (!v) fail("This thread has no page yet.");
  return press(t, kind as string, stage, v, sessionUrl);
}

function press(t: TaskRow, kind: string, stage: string, version: number | null, sessionUrl: string | null): PressRow {
  const at = now();
  const row: PressRow = { id: genId("p_"), task_id: t.id, kind, stage, version, at, session_url: sessionUrl };
  q.insPress.run(row.id, row.task_id, row.kind, row.stage, row.version, row.at, row.session_url);
  moveTo(t, "implementing", at);
  return row;
}

/** Checked before anything awaits, so a press that can't happen never wakes the routine. */
export function checkSend(id: string): void { const s = stageOf(thread(id)); if (!SENDABLE.includes(s)) fail(`Only a thread in the backlog or to-do is sent; this one is in ${s}.`); }
export function checkPress(id: string, kind: unknown): void {
  if (kind !== "go" && kind !== "back") fail("kind is go or back.");
  const s = stageOf(thread(id));
  if (!ON_YOU.includes(s)) fail(`Go and Send back are for a thread in Decide or Review; this one is in ${s}.`);
}

// ---------- the agent's three calls ----------

export interface Note { id: string; on: string | null; text: string }
export interface Thread { id: string; title: string; text: string; stage: string; page: string | null; notes: Note[] }

export function board(): { id: string; title: string; stage: string }[] {
  const order = ["implementing", "decide", "review", "todo", "thinking", "backlog"];
  return q.tasks.all().map((t) => ({ id: t.id, title: t.title, stage: stageOf(t) }))
    .filter((t) => !ended(t.stage))
    .sort((x, y) => order.indexOf(x.stage) - order.indexOf(y.stage));
}

/** The note id an agent sees: the highlight id it already knows from reply_note. */
const noteId = (markId: string): string => `hl_${markId}`;

/** Notes on a version: the reader's notes on its words, then any press made on it, oldest first. */
function notesOf(v: VersionRow | undefined, presses: PressRow[]): Note[] {
  if (!v) return [];
  const words = q.notesOn.all(v.resource_id).map((m) => ({ at: m.created_at, note: { id: noteId(m.id), on: m.quote, text: m.note } }));
  const pressed = presses.filter((p) => p.version === v.n && p.kind !== "send").map((p) => ({ at: p.at, note: { id: p.id, on: null, text: PRESS_LABEL[p.kind] } }));
  return [...words, ...pressed].sort((x, y) => x.at - y.at).map((x) => x.note);
}

export function open(id: string): Thread {
  const t = q.task.get(id) ?? fail(`No thread ${id}. dashboard_board lists them.`);
  const vs = q.versionsOf.all(id), last = vs[vs.length - 1];
  return { id: t.id, title: t.title, text: t.body, stage: stageOf(t), page: last ? (bytesOf(last.resource_id)?.toString("utf-8") ?? null) : null, notes: notesOf(last, q.pressesOf.all(id)) };
}

export interface Post { page?: string; replies: [string, string][] }

/** Checks a post's shape and does the awaiting a page needs; the returned function writes, inside the commit. */
export async function preparePost(id: string, raw: { page?: unknown; replies?: unknown }): Promise<() => string> {
  const t = q.task.get(id) ?? fail(`No thread ${id}. dashboard_board lists them.`);
  if (raw.page === undefined && raw.replies === undefined) fail("Post a page, replies, or both.");
  const page = raw.page === undefined ? undefined : typeof raw.page === "string" && raw.page.trim() ? raw.page : fail("page is the HTML of the next version.");
  if (page !== undefined && Buffer.byteLength(page) > MAX_UPLOAD_BYTES) fail("page is too big.");
  if (page !== undefined && stageOf(t) !== "implementing") fail(`This thread is in ${stageOf(t)}, with the reader. Post a page only while it is implementing; replies can go any time.`);
  const replies = checkReplies(id, raw.replies);
  let prepared: PreparedSource | null = null;
  if (page !== undefined) {
    const filename = fileFor(t);
    const html = htmlSource(filename, page)!;
    // always live, even a page with no script or style: the thread is read in the page's own frame
    prepared = await prepareSource({ filename, ...html, kind: "html", tokens: Math.ceil(html.text!.length / 4), study: false });
  }
  return () => {
    const said: string[] = [];
    const at = now();
    for (const [mid, text] of replies) {
      const m = q.noteMark.get(mid)!;
      q.insAgentReply.run(genId("mr-"), m.board_id, mid, m.resource_id, text, at, at);
    }
    if (replies.length) said.push(`${replies.length} ${replies.length === 1 ? "reply" : "replies"} under the reader's notes`);
    if (prepared) {
      const cur = q.task.get(id)!;
      if (stageOf(cur) !== "implementing") fail(`This thread moved to ${stageOf(cur)} while the page was being prepared.`);
      const lands = landsIn(q.lastPress.get(id));
      const n = q.lastN.get(id)!.n + 1;
      const rid = writeSource(dispatchBoard(), prepared);
      q.insVersion.run(id, n, rid, lands, at);
      moveTo(cur, lands, at);
      said.push(`v${n} posted; the thread is in ${lands === "done" ? "Done" : lands === "decide" ? "Decide" : "Review"}`);
    }
    return said.join("; ") + ".";
  };
}

function checkReplies(id: string, raw: unknown): [string, string][] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("replies is { noteId: \"text\" }.");
  const mine = new Set(q.versionsOf.all(id).map((v) => v.resource_id));
  return Object.entries(raw as Record<string, unknown>).map(([k, v]) => {
    const mid = k.replace(/^hl_/, "");
    const m = q.noteMark.get(mid);
    if (!m || !mine.has(m.resource_id) || !m.note?.trim()) fail(`${k} is not one of the reader's notes on this thread.`);
    const text = typeof v === "string" ? v.trim().slice(0, 4000) : "";
    if (!text) fail(`The reply to ${k} is empty.`);
    return [mid, text] as [string, string];
  });
}

/** A thread's file keeps one name across versions: its first link's ref, else its title. */
function fileFor(t: TaskRow): string {
  const ref = (JSON.parse(t.links || "[]") as Link[])[0]?.ref ?? "";
  const slug = (ref || t.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "thread";
  return `${slug}.html`;
}

/** The board the pages live on: the one with the dispatch handle, made the first time a page is posted. */
export function dispatchBoard(): string {
  const had = a.boardByHandle.get(HANDLE);
  if (had) return had.id;
  const id = insertBoard("Dispatch", "");
  a.setHandle.run(HANDLE, id);
  return id;
}
export const dispatchBoardId = (): string | null => a.boardByHandle.get(HANDLE)?.id ?? null;

// ---------- the pane ----------

export interface VersionView { n: number; resourceId: string; at: number; landed: string; notes: number }
export interface PressView { kind: string; stage: string; version: number | null; at: number; sessionUrl: string | null }
export interface DispatchThread { id: string; title: string; stage: string; links: Link[]; updatedAt: number; versions: VersionView[]; press: PressView | null; lands: string | null }

/** What the left pane shows: threads in Decide, Implementing and Review (those Dispatch sent), and the inbox count. */
export function pane(inbox: number): { rev: number; board: string | null; inbox: number; threads: DispatchThread[] } {
  const counts = new Map(q.noteCounts.all().map((r) => [r.resource_id, r.n]));
  const vs = new Map<string, VersionView[]>();
  for (const v of q.versions.all()) {
    const list = vs.get(v.task_id) ?? [];
    list.push({ n: v.n, resourceId: v.resource_id, at: v.at, landed: v.landed, notes: counts.get(v.resource_id) ?? 0 });
    vs.set(v.task_id, list);
  }
  const last = new Map<string, PressRow>();
  for (const p of q.presses.all()) last.set(p.task_id, p);
  const threads = q.tasks.all().flatMap((t): DispatchThread[] => {
    const stage = stageOf(t), p = last.get(t.id);
    if (stage !== "decide" && stage !== "implementing" && !(stage === "review" && p)) return [];
    return [{ id: t.id, title: t.title, stage, links: JSON.parse(t.links || "[]") as Link[], updatedAt: t.updated_at, versions: vs.get(t.id) ?? [],
      press: p ? { kind: p.kind, stage: p.stage, version: p.version, at: p.at, sessionUrl: p.session_url } : null,
      lands: stage === "implementing" ? landsIn(p) : null }];
  });
  return { rev: q.dashRev.get()!.rev, board: dispatchBoardId(), inbox, threads };
}
