// The dashboard: tasks with a body, dated updates and one level of subtasks, fed by an inbox you triage.
// Every write here runs inside a caller's commit, so nothing awaits.
import { genId, now, parseJson } from "../../platform/db/sql.ts";
import { dashboardRepo as q, type InboxRow, type TaskRow, type UpdateRow } from "./repo.ts";

export class DashError extends Error { httpStatus = 400; }
const fail = (msg: string): never => { throw new DashError(msg); };

export const STATES = ["you", "claude", "waiting", "later", "done", "dropped"] as const;
export const OPEN_STATES = ["you", "claude", "waiting", "later"];
export const KINDS = ["task", "subtask", "update", "fragment"] as const;
export const LINK_KINDS = ["linear", "github", "slack", "notion", "strata", "claude", "web"] as const;
export const COVERAGE = ["full", "partial"] as const;
export const AREAS = ["work", "personal"] as const;
const WORK = /slack|linear|github|engineering|1:1|design review|standup|sync\b|meeting|#/i;
/** An item that names no area goes where its source suggests. */
export const guessArea = (source: string | undefined): string => (WORK.test(source ?? "") ? "work" : "personal");
const MAX = { title: 300, body: 20000, text: 8000, why: 1000, source: 300, quote: 2000, ref: 200, url: 2000, links: 20, waiting: 120, prompt: 20000, directions: 8, note: 500, pad: 200000 };
/** A task body shorter than this reads as a title restated; the tool's answer says so. */
export const THIN = 200;

export interface Link { kind: string; ref: string; title?: string; url?: string }
export interface From { source: string; url?: string; quote?: string }
export interface Direction { title: string; body?: string }
export interface Item {
  kind: "task" | "subtask" | "update" | "fragment";
  title?: string; body?: string; parent?: string;
  task?: string; text?: string;
  directions?: Direction[]; fragment?: string; wantsMore?: boolean; area?: string;
  links: Link[]; from: From; why?: string;
}
export interface SourceNote { source: string; url?: string; coverage: string; note?: string }

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

function checkDirections(raw: unknown, field: string): Direction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX.directions) return fail(`${field} is a list of at most ${MAX.directions} directions.`);
  return raw.map((d, i) => {
    const o = (d ?? {}) as Record<string, unknown>;
    const body = str(o.body, `${field}[${i}].body`, MAX.text);
    return { title: str(o.title, `${field}[${i}].title`, MAX.title, true)!, ...(body ? { body } : {}) };
  });
}

export function checkSources(raw: unknown, field = "sources"): SourceNote[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50) return fail(`${field} is a list of at most 50 sources.`);
  return raw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const coverage = String(o.coverage ?? "");
    if (!(COVERAGE as readonly string[]).includes(coverage)) fail(`${field}[${i}].coverage is full or partial.`);
    const url = str(o.url, `${field}[${i}].url`, MAX.url);
    if (url && !/^https?:\/\//.test(url)) fail(`${field}[${i}].url starts with http:// or https://.`);
    const note = str(o.note, `${field}[${i}].note`, MAX.note);
    return { source: str(o.source, `${field}[${i}].source`, MAX.source, true)!, coverage, ...(url ? { url } : {}), ...(note ? { note } : {}) };
  });
}

/** A task by id, or by the exact title of an open task. */
export function taskRef(ref: unknown): TaskRow | undefined {
  const s = typeof ref === "string" ? ref.trim() : "";
  return s ? (q.task.get(s) ?? q.taskByTitle.get(s)) : undefined;
}

const openFragment = (ref: unknown): InboxRow | undefined => {
  const row = typeof ref === "string" ? q.inboxItem.get(ref.trim()) : undefined;
  return row && !row.handled_at && row.kind === "fragment" ? row : undefined;
};

/** Checks one item's shape and that what it names exists; returns it normalized. */
export function checkItem(raw: unknown, at: string): Item {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${at} is an object.`);
  const kind = String(o.kind ?? "");
  if (!(KINDS as readonly string[]).includes(kind)) fail(`${at}.kind is task, subtask, update or fragment.`);
  if (o.area !== undefined && o.area !== null && !(AREAS as readonly string[]).includes(String(o.area))) fail(`${at}.area is work or personal.`);
  const from = checkFrom(o.from, `${at}.from`);
  const base = { links: checkLinks(o.links, `${at}.links`), from, why: str(o.why, `${at}.why`, MAX.why), area: o.area ? String(o.area) : guessArea(from.source) };
  if (kind === "update") {
    const t = taskRef(o.task) ?? fail(`${at}.task "${String(o.task ?? "")}" matches no task. Use its id or its exact title (dashboard_read lists them).`);
    const body = str(o.body, `${at}.body`, MAX.body);
    return { kind, task: t.id, text: str(o.text, `${at}.text`, MAX.text, !body), ...(body ? { body } : {}), ...base };
  }
  if (kind === "fragment") {
    const directions = checkDirections(o.directions, `${at}.directions`);
    if (o.fragment !== undefined) {
      const f = openFragment(o.fragment) ?? fail(`${at}.fragment "${String(o.fragment)}" is no open fragment in the inbox.`);
      if (!directions.length) fail(`${at}.directions is required when adding to fragment ${f.id}.`);
      return { kind, fragment: f.id, directions, ...base };
    }
    return { kind, title: str(o.title, `${at}.title`, MAX.title, true), body: str(o.body, `${at}.body`, MAX.body) ?? "", directions, ...base };
  }
  let parent: string | undefined;
  if (kind === "subtask") {
    const p = taskRef(o.parent) ?? fail(`${at}.parent "${String(o.parent ?? "")}" matches no task. Use its id or its exact title.`);
    if (p.parent_id) fail(`${at}.parent "${p.title}" is itself a subtask; subtasks go one level deep.`);
    parent = p.id;
    if (o.area === undefined || o.area === null) base.area = p.area ?? base.area;
  }
  return { kind: kind as Item["kind"], title: str(o.title, `${at}.title`, MAX.title, true), body: str(o.body, `${at}.body`, MAX.body) ?? "", ...(parent ? { parent } : {}), ...base };
}

/** Adds items to the inbox; a fragment item naming an open fragment adds its directions there instead. */
export function addItems(items: Item[]): string[] {
  const t = now();
  return items.map((it) => {
    if (it.fragment) {
      const row = q.inboxItem.get(it.fragment)!;
      const cur = parseJson<Item>(row.item, {} as Item);
      q.setInbox.run(row.kind, JSON.stringify({ ...cur, directions: [...(cur.directions ?? []), ...(it.directions ?? [])].slice(-MAX.directions * 2), wantsMore: false }), row.id);
      return row.id;
    }
    const id = genId("in_");
    q.insInbox.run(id, it.kind, JSON.stringify(it), t);
    return id;
  });
}

export function noteSources(list: SourceNote[]): void {
  const t = now();
  for (const s of list) q.putSource.run(s.source, s.url ?? null, s.coverage, s.note ?? null, t);
}

function insertTask(f: { id?: string; title: string; body: string; parent?: string | null; links: Link[]; from?: From | null; area?: string }): string {
  const id = f.id ?? genId("t_");
  const t = now();
  q.insTask.run(id, f.title, f.body, "you", null, f.parent ?? null, JSON.stringify(f.links), null, f.from ? JSON.stringify(f.from) : null, t, t, f.area ?? guessArea(f.from?.source));
  return id;
}

const EDITABLE = ["title", "body", "why", "text", "kind", "task", "parent", "wantsMore", "area"] as const;

/** Changes an open inbox item's fields before it is kept; each field is optional, so edits never undo each other. */
export function editItem(id: string, b: Record<string, unknown>): Record<string, unknown> {
  const row = q.inboxItem.get(id) ?? fail(`No inbox item ${id}.`);
  if (row.handled_at) fail("That item is already triaged.");
  const cur = parseJson<Record<string, unknown>>(row.item, {});
  const next: Record<string, unknown> = { ...cur };
  for (const k of EDITABLE) if (b[k] !== undefined) next[k] = b[k];
  if (next.kind !== cur.kind) {
    if (next.kind === "fragment") { next.title ??= cur.text; next.body = next.body ?? cur.text ?? ""; next.directions ??= []; }
    if (next.kind === "update") { next.text ??= [cur.title, cur.body].filter(Boolean).join("\n\n"); }
    if (next.kind === "task" && cur.kind === "update") { next.title ??= String(cur.text ?? "").split("\n")[0].slice(0, MAX.title); next.body ??= cur.text; }
  }
  // An update to a task not yet picked is fine to hold; keep checks it.
  const checked = next.kind === "update" && !next.task ? { ...next, task: undefined } : checkItem({ ...next, task: next.task, parent: next.parent }, "item");
  const out = { ...checked, wantsMore: next.wantsMore === true };
  q.setInbox.run(String(next.kind), JSON.stringify(out), id);
  return { ...out, id, at: row.at, kind: next.kind };
}

/** Keeps an inbox item: a task lands in Your move, an update joins its task (a body in it replaces the task's), a fragment becomes the tasks you picked. Edits from triage apply first. */
export function keepItem(id: string, edits: Record<string, unknown> = {}): { outcome: string; result: string } {
  const row = q.inboxItem.get(id) ?? fail(`No inbox item ${id}.`);
  if (row.handled_at) return { outcome: row.outcome ?? "kept", result: row.result_id ?? "" };
  const { picked, own, ...fields } = edits;
  const it = checkItem({ ...parseJson<Record<string, unknown>>(row.item, {}), ...fields }, "item");
  let result: string;
  if (it.kind === "update") {
    const task = q.task.get(it.task!) ?? fail("That task is gone.");
    result = task.id;
    if (it.text) {
      result = genId("u_");
      q.insUpdate.run(result, task.id, now(), it.text, JSON.stringify(it.from), JSON.stringify(it.links));
    }
    const links = mergeLinks(parseJson<Link[]>(task.links, []), it.links);
    q.setTask.run(task.title, it.body ?? task.body, task.state, task.waiting_on, task.parent_id, JSON.stringify(links), task.prompt, task.pinned_at, task.cleared_at, now(), task.id);
  } else if (it.kind === "fragment") {
    const dirs = it.directions ?? [];
    const idx = Array.isArray(picked) ? picked.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < dirs.length) : [];
    const mine = Array.isArray(own) ? own.map((t, i) => str(t, `own[${i}]`, MAX.title)).filter((t): t is string => !!t) : [];
    const chosen: Direction[] = [...new Set(idx)].map((n) => dirs[n]).concat(mine.map((title) => ({ title })));
    if (!chosen.length) fail("Pick a direction or write your own to keep a fragment.");
    const origin = `From the fragment “${it.title}”${it.body ? `: ${it.body}` : ""}`;
    const sources = it.from.source === "You" ? "" : `\n\n## Sources\n- ${it.from.source}${it.from.url ? ` <${it.from.url}>` : ""}`;
    result = chosen.map((d) => insertTask({ title: d.title, body: `## Context\n${[d.body, origin].filter(Boolean).join("\n\n")}${sources}`, links: it.links, from: it.from, area: it.area })).join(",");
  } else {
    result = insertTask({ title: it.title!, body: it.body ?? "", parent: it.parent, links: it.links, from: it.from, area: it.area });
  }
  q.handleInbox.run(now(), "kept", result, id);
  return { outcome: "kept", result };
}

export function dropItem(id: string): void {
  const row = q.inboxItem.get(id) ?? fail(`No inbox item ${id}.`);
  if (!row.handled_at) q.handleInbox.run(now(), "dropped", null, id);
}

const mergeLinks = (have: Link[], add: Link[]): Link[] => [...have, ...add.filter((l) => !have.some((h) => h.kind === l.kind && h.ref === l.ref))];

/** A task you write yourself, from the page. The page mints the id, so a resent create is a no-op. */
export function createTask(b: Record<string, unknown>): string {
  const id = str(b.id, "id", 60, true)!;
  if (!/^t_[A-Za-z0-9]{4,40}$/.test(id)) fail("id is t_ and 4–40 letters or digits.");
  if (q.task.get(id)) return id;
  if (b.state !== undefined && !OPEN_STATES.includes(String(b.state))) fail(`state is one of ${OPEN_STATES.join(", ")}.`);
  if (b.area !== undefined && !(AREAS as readonly string[]).includes(String(b.area))) fail("area is work or personal.");
  const made = insertTask({ id, title: str(b.title, "title", MAX.title, true)!, body: str(b.body, "body", MAX.body) ?? "", links: checkLinks(b.links), from: { source: "You" }, area: b.area === undefined ? "personal" : String(b.area) });
  if (b.state !== undefined && b.state !== "you") patchTask(made, { state: b.state });
  return made;
}

const flag = (v: unknown, field: string): boolean => (typeof v === "boolean" ? v : fail(`${field} is true or false.`));

/** Changes a task's fields; each one is optional, so two edits to different fields never undo each other. */
export function patchTask(id: string, b: Record<string, unknown>): TaskRow {
  const cur = q.task.get(id) ?? fail(`No task ${id}.`);
  const state = b.state === undefined ? cur.state : String(b.state);
  if (!(STATES as readonly string[]).includes(state)) fail(`state is one of ${STATES.join(", ")}.`);
  let parent = cur.parent_id;
  if (b.parent !== undefined) {
    parent = b.parent === null ? null : String(b.parent);
    if (parent === id) fail("A task can't be its own parent.");
    if (parent) {
      const p = q.task.get(parent) ?? fail(`No task ${parent}.`);
      if (p.parent_id) fail(`"${p.title}" is a subtask; subtasks go one level deep.`);
      if (q.childCount.get(id)!.n) fail(`"${cur.title}" has subtasks of its own.`);
    }
  }
  const t = now();
  const ended = state === "done" || state === "dropped";
  let pinned = b.pinned === undefined ? cur.pinned_at : flag(b.pinned, "pinned") ? (cur.pinned_at ?? t) : null;
  if (ended) pinned = null;
  const cleared = b.cleared === undefined ? cur.cleared_at : flag(b.cleared, "cleared") ? (cur.cleared_at ?? t) : null;
  const waiting = b.waitingOn === undefined ? cur.waiting_on : (str(b.waitingOn, "waitingOn", MAX.waiting) ?? null);
  const prompt = b.prompt === undefined ? cur.prompt : b.prompt === null ? null : (str(b.prompt, "prompt", MAX.prompt) ?? null);
  const links = b.links === undefined ? cur.links : JSON.stringify(checkLinks(b.links));
  q.setTask.run(str(b.title, "title", MAX.title) ?? cur.title, b.body === undefined ? cur.body : (str(b.body, "body", MAX.body) ?? ""),
    state, state === "waiting" ? waiting : null, parent, links, prompt, pinned, cleared, t, id);
  if (b.area !== undefined) {
    if (!(AREAS as readonly string[]).includes(String(b.area))) fail("area is work or personal.");
    q.setArea.run(String(b.area), t, id);
  }
  return q.task.get(id)!;
}

/** The pad as plain text: its formatting is the page's business, an agent reads lines. */
export function padText(html: string): string {
  if (!/<[a-z]/i.test(html)) return html;
  return html.replace(/<li[^>]*>/gi, "\n- ").replace(/<(br|\/div|\/p|\/h[1-3]|\/blockquote|\/ul|\/ol)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}
export function padOf(): { text: string; rev: number } {
  const p = q.pad.get();
  return { text: p?.text ?? "", rev: p?.rev ?? 0 };
}
export function writePad(text: unknown): { text: string; rev: number } {
  if (typeof text !== "string") fail("text is text.");
  q.putPad.run((text as string).slice(0, MAX.pad), now());
  return padOf();
}

// ---------- reading ----------

export interface TaskView {
  id: string; title: string; body: string; state: string; waitingOn: string | null; parent: string | null;
  links: Link[]; prompt: string | null; createdFrom: From | null; createdAt: number; updatedAt: number;
  pinnedAt: number | null; clearedAt: number | null; area: string;
  updates: { id: string; at: number; text: string; from: From | null; links: Link[] }[];
}
const updateView = (u: UpdateRow) => ({ id: u.id, at: u.at, text: u.text, from: parseJson<From | null>(u.from_json, null), links: parseJson<Link[]>(u.links, []) });
export function taskView(t: TaskRow, ups: UpdateRow[]): TaskView {
  return { id: t.id, title: t.title, body: t.body, state: t.state, waitingOn: t.waiting_on, parent: t.parent_id,
    links: parseJson<Link[]>(t.links, []), prompt: t.prompt, createdFrom: parseJson<From | null>(t.created_from, null),
    createdAt: t.created_at, updatedAt: t.updated_at, pinnedAt: t.pinned_at, clearedAt: t.cleared_at, area: t.area ?? "personal", updates: ups.map(updateView) };
}
export function inboxView(r: InboxRow): Record<string, unknown> & { id: string; at: number; kind: string } {
  const it = parseJson<Record<string, unknown>>(r.item, {});
  return { ...it, area: it.area ?? guessArea((it.from as From | undefined)?.source), id: r.id, at: r.at, kind: r.kind };
}

function withUpdates(rows: TaskRow[]): TaskView[] {
  const byTask = new Map<string, UpdateRow[]>();
  for (const u of q.updates.all()) { const list = byTask.get(u.task_id) ?? []; list.push(u); byTask.set(u.task_id, list); }
  return rows.map((t) => taskView(t, byTask.get(t.id) ?? []));
}

/** The board: every task not cleared, the open inbox, and the pad. */
// STRATA_DASHBOARD_LINKS="Tracker=https://…,Chat=https://…" puts the tools you work in at the top of the dashboard.
export const DASHBOARD_LINKS: { label: string; url: string }[] = (process.env.STRATA_DASHBOARD_LINKS ?? "").split(",")
  .map((s) => s.trim()).filter(Boolean)
  .map((s) => { const i = s.indexOf("="); return { label: s.slice(0, i).trim(), url: s.slice(i + 1).trim() }; })
  .filter((l) => l.label && /^https?:\/\//.test(l.url));

export function snapshot(): { tasks: TaskView[]; inbox: ReturnType<typeof inboxView>[]; pad: { text: string; rev: number }; archived: number; links: { label: string; url: string }[] } {
  const all = q.allTasks.all();
  return { tasks: withUpdates(all.filter((t) => t.cleared_at === null)), inbox: q.inboxOpen.all().map(inboxView), pad: padOf(), archived: all.length - all.filter((t) => t.cleared_at === null).length, links: DASHBOARD_LINKS };
}

export interface SourceView { source: string; url: string | null; coverage: string | null; note: string | null; tasks: number; done: number; open: number; inbox: number; lastAt: number }

/** Every place an item came from, with what came of it and what agents said about how much they read. */
export function sourcesView(): SourceView[] {
  const by = new Map<string, SourceView>();
  const at = (source: string | undefined, url: string | undefined, when: number): SourceView | null => {
    if (!source || source === "You" || source === "Added by you") return null;
    const s = by.get(source) ?? { source, url: null, coverage: null, note: null, tasks: 0, done: 0, open: 0, inbox: 0, lastAt: 0 };
    if (url && !s.url) s.url = url;
    s.lastAt = Math.max(s.lastAt, when);
    by.set(source, s);
    return s;
  };
  for (const t of q.allTasks.all()) {
    const f = parseJson<From | null>(t.created_from, null);
    const s = at(f?.source, f?.url, t.created_at);
    if (!s) continue;
    s.tasks++;
    if (t.state === "done") s.done++;
    else if (t.state !== "dropped") s.open++;
  }
  for (const u of q.updates.all()) at(parseJson<From | null>(u.from_json, null)?.source, parseJson<From | null>(u.from_json, null)?.url, u.at);
  for (const r of q.inboxOpen.all()) { const f = parseJson<Item>(r.item, {} as Item).from; const s = at(f?.source, f?.url, r.at); if (s) s.inbox++; }
  for (const n of q.sources.all()) {
    const s = by.get(n.source) ?? at(n.source, n.url ?? undefined, n.updated_at)!;
    if (!s) continue;
    s.coverage = n.coverage; s.note = n.note;
    if (n.url) s.url = n.url;
  }
  return [...by.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** The archive: tasks you cleared off the board, newest first, and the sources. */
export function archive(): { tasks: TaskView[]; sources: SourceView[] } {
  return { tasks: withUpdates(q.cleared.all()), sources: sourcesView() };
}
