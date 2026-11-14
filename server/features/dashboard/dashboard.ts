// The dashboard: threads you move through backlog, to-do, thinking and review, fed by an inbox you triage.
// Every write here runs inside a caller's commit, so nothing awaits.
import { genId, now, parseJson } from "../../platform/db/sql.ts";
import { dashboardRepo as q, type InboxRow, type TaskRow, type UpdateRow } from "./repo.ts";

export class DashError extends Error { httpStatus = 400; }
const fail = (msg: string): never => { throw new DashError(msg); };

export const STAGES = ["backlog", "todo", "thinking", "decide", "implementing", "review", "done", "dropped"] as const;
// Dispatch moves a thread into these itself, when it is sent, pressed or posted to.
const DISPATCH_ONLY = ["decide", "implementing"];
export const OPEN_STAGES = ["backlog", "todo", "thinking", "review"];
const isEnded = (s: string): boolean => s === "done" || s === "dropped";
// state and pinned_at predate stages; they are written in step so the rows read the same from either side.
const stateOf = (stage: string): string => (isEnded(stage) ? stage : "you");
export const stageOf = (t: TaskRow): string => t.stage ?? (isEnded(t.state) ? t.state : "backlog");
export const LINK_KINDS = ["linear", "github", "slack", "notion", "strata", "claude", "web"] as const;
export const AREAS = ["work", "personal"] as const;
const WORK = /slack|linear|github|engineering|1:1|design review|standup|sync\b|meeting|#/i;
/** An item that names no area goes where its source suggests. */
export const guessArea = (source: string | undefined): string => (WORK.test(source ?? "") ? "work" : "personal");
const MAX = { title: 300, body: 20000, context: 400, source: 300, quote: 2000, ref: 200, url: 2000, links: 20 };

export interface Link { kind: string; ref: string; title?: string; url?: string }
export interface From { source: string; url?: string; quote?: string }
export interface Item { kind: "task"; title: string; body: string; context?: string; area: string; links: Link[]; from: From }

const str = (v: unknown, field: string, max: number, required = false): string | undefined => {
  if (v === undefined || v === null || v === "") return required ? fail(`${field} is required.`) : undefined;
  if (typeof v !== "string") return fail(`${field} is text.`);
  const s = v.trim();
  if (required && !s) fail(`${field} can't be empty.`);
  return s.slice(0, max);
};

export function checkLinks(raw: unknown, field = "links"): Link[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX.links) return fail(`${field} is a list of at most ${MAX.links} links.`);
  return raw.map((l, i) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const kind = String(o.kind ?? "");
    if (!(LINK_KINDS as readonly string[]).includes(kind)) fail(`${field}[${i}].kind is one of ${LINK_KINDS.join(", ")}.`);
    const url = str(o.url, `${field}[${i}].url`, MAX.url);
    if (url && !/^https?:\/\//.test(url)) fail(`${field}[${i}].url starts with http:// or https://.`);
    return { kind, ref: str(o.ref, `${field}[${i}].ref`, MAX.ref, true)!, ...(o.title ? { title: str(o.title, `${field}[${i}].title`, MAX.title) } : {}), ...(url ? { url } : {}) };
  });
}

function checkFrom(raw: unknown, field: string): From {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null) fail(`${field} is { source, url?, quote? }.`);
  const url = str(o.url, `${field}.url`, MAX.url);
  return { source: str(o.source, `${field}.source`, MAX.source, true)!, ...(url ? { url } : {}), ...(o.quote ? { quote: str(o.quote, `${field}.quote`, MAX.quote) } : {}) };
}

/** Checks one inbox item's shape; returns it normalized. */
export function checkItem(raw: unknown, at: string): Item {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${at} is an object.`);
  if (o.kind !== undefined && o.kind !== "task") fail(`${at}.kind is task; subtasks, updates and fragments are no longer taken.`);
  if (o.area !== undefined && o.area !== null && !(AREAS as readonly string[]).includes(String(o.area))) fail(`${at}.area is work or personal.`);
  const from = checkFrom(o.from, `${at}.from`);
  const context = str(o.context, `${at}.context`, MAX.context);
  const title = str(o.title, `${at}.title`, MAX.title, true)!;
  const body = str(o.body, `${at}.body`, MAX.body) ?? context ?? "";
  return { kind: "task", title, body, ...(context ? { context } : {}), area: o.area ? String(o.area) : guessArea(from.source), links: checkLinks(o.links, `${at}.links`), from };
}

/** An item an older routine left in the inbox as an update or fragment reads as a plain task, so it can still be kept. */
function stored(row: InboxRow): Record<string, unknown> {
  const it = parseJson<Record<string, unknown>>(row.item, {});
  if (row.kind === "task" && it.kind === "task") return it;
  const text = typeof it.text === "string" ? it.text : "";
  const { kind: _kind, task: _task, parent: _parent, directions: _directions, fragment: _fragment, wantsMore: _wantsMore, why: _why, ...rest } = it;
  return { ...rest, kind: "task", title: it.title ?? text.split("\n")[0], body: it.body ?? text };
}

export function addItems(items: Item[]): string[] {
  const t = now();
  return items.map((it) => { const id = genId("in_"); q.insInbox.run(id, it.kind, JSON.stringify(it), t); return id; });
}

function insertTask(f: { id?: string; title: string; body: string; links: Link[]; from?: From | null; area?: string; stage?: string }): string {
  const id = f.id ?? genId("t_");
  const t = now();
  const stage = f.stage ?? "backlog";
  q.insTask.run(id, f.title, f.body, stateOf(stage), null, null, JSON.stringify(f.links), null, f.from ? JSON.stringify(f.from) : null, t, t, f.area ?? guessArea(f.from?.source), stage);
  return id;
}
const checkOpenStage = (v: unknown, fallback: string): string => {
  const stage = v === undefined || v === null ? fallback : String(v);
  if (!OPEN_STAGES.includes(stage)) fail(`stage is one of ${OPEN_STAGES.join(", ")}.`);
  return stage;
};

const EDITABLE = ["title", "context", "body", "area"] as const;

/** Changes an open inbox item's fields before it is kept; each field is optional, so edits never undo each other. */
export function editItem(id: string, b: Record<string, unknown>): Record<string, unknown> {
  const row = q.inboxItem.get(id) ?? fail(`No inbox item ${id}.`);
  if (row.handled_at) fail("That item is already triaged.");
  const next = stored(row);
  for (const k of EDITABLE) if (b[k] !== undefined) next[k] = b[k];
  const out = checkItem(next, "item");
  q.setInbox.run("task", JSON.stringify(out), id);
  return { ...out, id, at: row.at };
}

/** Keeps an inbox item as a thread in the backlog, or the open stage asked for. Edits from triage apply first. */
export function keepItem(id: string, edits: Record<string, unknown> = {}): { outcome: string; result: string } {
  const row = q.inboxItem.get(id) ?? fail(`No inbox item ${id}.`);
  if (row.handled_at) return { outcome: row.outcome ?? "kept", result: row.result_id ?? "" };
  const { stage: to, ...fields } = edits;
  const stage = checkOpenStage(to, "backlog");
  const it = checkItem({ ...stored(row), ...fields }, "item");
  const result = insertTask({ title: it.title, body: it.body, links: it.links, from: it.from, area: it.area, stage });
  q.handleInbox.run(now(), "kept", result, id);
  return { outcome: "kept", result };
}

export function dropItem(id: string): void {
  const row = q.inboxItem.get(id) ?? fail(`No inbox item ${id}.`);
  if (!row.handled_at) q.handleInbox.run(now(), "dropped", null, id);
}

/** A thread you write yourself, from the page. The page mints the id, so a resent create is a no-op. */
export function createTask(b: Record<string, unknown>): string {
  const id = str(b.id, "id", 60, true)!;
  if (!/^t_[A-Za-z0-9]{4,40}$/.test(id)) fail("id is t_ and 4–40 letters or digits.");
  if (q.task.get(id)) return id;
  if (b.area !== undefined && !(AREAS as readonly string[]).includes(String(b.area))) fail("area is work or personal.");
  return insertTask({ id, title: str(b.title, "title", MAX.title, true)!, body: str(b.body, "body", MAX.body) ?? "", links: checkLinks(b.links), from: { source: "You" }, area: b.area === undefined ? "personal" : String(b.area), stage: checkOpenStage(b.stage, "backlog") });
}

const flag = (v: unknown, field: string): boolean => (typeof v === "boolean" ? v : fail(`${field} is true or false.`));

/** Changes a thread's fields; each one is optional, so two edits to different fields never undo each other. */
export function patchTask(id: string, b: Record<string, unknown>): TaskRow {
  const cur = q.task.get(id) ?? fail(`No task ${id}.`);
  let stage = stageOf(cur);
  if (b.stage !== undefined) {
    stage = String(b.stage);
    if (!(STAGES as readonly string[]).includes(stage)) fail(`stage is one of ${STAGES.join(", ")}.`);
    if (DISPATCH_ONLY.includes(stage) && stage !== stageOf(cur)) fail(`A thread goes to ${stage} through Dispatch, not by hand.`);
  }
  const t = now();
  // morning: picked for tomorrow, which lifts a backlog thread into to-do.
  const pick = b.morning === undefined ? undefined : flag(b.morning, "morning");
  let morning = pick === undefined ? cur.morning_at : pick ? (cur.morning_at ?? t) : null;
  if (pick && stage === "backlog") stage = "todo";
  if (isEnded(stage)) morning = null;
  const cleared = b.cleared === undefined ? cur.cleared_at : flag(b.cleared, "cleared") ? (cur.cleared_at ?? t) : null;
  const links = b.links === undefined ? cur.links : JSON.stringify(checkLinks(b.links));
  q.setTask.run(str(b.title, "title", MAX.title) ?? cur.title, b.body === undefined ? cur.body : (str(b.body, "body", MAX.body) ?? ""),
    stateOf(stage), cur.waiting_on, cur.parent_id, links, cur.prompt, morning, cleared, t, stage, morning, id);
  if (b.area !== undefined) {
    if (!(AREAS as readonly string[]).includes(String(b.area))) fail("area is work or personal.");
    q.setArea.run(String(b.area), t, id);
  }
  return q.task.get(id)!;
}

// ---------- reading ----------

export interface TaskView {
  id: string; title: string; body: string; stage: string; morningAt: number | null;
  links: Link[]; createdFrom: From | null; createdAt: number; updatedAt: number; clearedAt: number | null; area: string;
  dispatched: boolean;
  updates: { id: string; at: number; text: string; from: From | null; links: Link[] }[];
}
const updateView = (u: UpdateRow) => ({ id: u.id, at: u.at, text: u.text, from: parseJson<From | null>(u.from_json, null), links: parseJson<Link[]>(u.links, []) });
export function taskView(t: TaskRow, ups: UpdateRow[], dispatched = false): TaskView {
  return { id: t.id, title: t.title, body: t.body, stage: stageOf(t), morningAt: t.morning_at,
    links: parseJson<Link[]>(t.links, []), createdFrom: parseJson<From | null>(t.created_from, null),
    createdAt: t.created_at, updatedAt: t.updated_at, clearedAt: t.cleared_at, area: t.area ?? "personal", dispatched, updates: ups.map(updateView) };
}
export function inboxView(r: InboxRow): Record<string, unknown> & { id: string; at: number; kind: string } {
  const it = parseJson<Record<string, unknown>>(r.item, {});
  return { ...it, area: it.area ?? guessArea((it.from as From | undefined)?.source), id: r.id, at: r.at, kind: r.kind };
}

// Notes agents sent before are still read; nothing writes them now.
function withUpdates(rows: TaskRow[]): TaskView[] {
  const byTask = new Map<string, UpdateRow[]>();
  for (const u of q.updates.all()) { const list = byTask.get(u.task_id) ?? []; list.push(u); byTask.set(u.task_id, list); }
  const sent = new Set(q.dispatched.all().map((r) => r.task_id));
  return rows.map((t) => taskView(t, byTask.get(t.id) ?? [], sent.has(t.id)));
}

// STRATA_DASHBOARD_LINKS="Tracker=https://…,Chat=https://…" names the tools you work in, for the page to link.
export const DASHBOARD_LINKS: { label: string; url: string }[] = (process.env.STRATA_DASHBOARD_LINKS ?? "").split(",")
  .map((s) => s.trim()).filter(Boolean)
  .map((s) => { const i = s.indexOf("="); return { label: s.slice(0, i).trim(), url: s.slice(i + 1).trim() }; })
  .filter((l) => l.label && /^https?:\/\//.test(l.url));

/** The board: every thread not cleared, the open inbox, and how many are in the archive. */
export function snapshot(): { tasks: TaskView[]; inbox: ReturnType<typeof inboxView>[]; archived: number; links: { label: string; url: string }[] } {
  const all = q.allTasks.all();
  const live = all.filter((t) => t.cleared_at === null);
  return { tasks: withUpdates(live), inbox: q.inboxOpen.all().map(inboxView), archived: all.length - live.length, links: DASHBOARD_LINKS };
}

/** The archive: threads you cleared off the board, newest first. */
export function archive(): { tasks: TaskView[] } {
  return { tasks: withUpdates(q.cleared.all()) };
}
