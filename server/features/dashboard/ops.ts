// dashboard_apply's operations: everything the reader does on the dashboard, as ops an agent sends in one all-or-nothing list.
// Each op is checked before anything awaits, prepared (a page is built) outside the commit, then run inside it in order,
// through the same functions the dashboard's routes call, so an op and its route can't drift apart.
import { genId, now } from "../../platform/db/sql.ts";
import { addItems, checkItem, checkLinks, DashError, dropItem, editItem, keepItem, padOf, patchTask, stageOf, writePad } from "./dashboard.ts";
import { preparePost, sendThread } from "./dispatch.ts";
import { dashboardRepo as q } from "./repo.ts";

const fail = (msg: string): never => { throw new DashError(msg); };
type Op = Record<string, unknown> & { op: string };
const text = (max: number, about: string) => ({ type: "string", maxLength: max, description: about });
const ID = { type: "string", description: "A thread's t_ id or an inbox item's in_ id, from dashboard_read." };
const BECAUSE = text(300, "Why, in a few words; the reader sees it on the thread as \"by Claude: …\".");
const LINK = { type: "object", additionalProperties: false, required: ["kind", "ref"], properties: {
  kind: { type: "string", enum: ["linear", "github", "slack", "notion", "strata", "claude", "web"] }, ref: { type: "string", description: "e.g. GD-247, PR #42, #north-beds" }, title: { type: "string" }, url: { type: "string" } } };
const FROM = { type: "object", additionalProperties: false, required: ["source"], properties: {
  source: { type: "string", description: "e.g. Notion · 1:1 with Mara · 23 Oct" }, url: { type: "string" }, quote: { type: "string", description: "The words it came from." } } };
const AREA = { type: "string", enum: ["work", "personal"], description: "Which list it shows on." };

/** Stages an agent may move a thread to; decide, implementing and finish are reached only through send, a press or a post. */
export const AGENT_MOVES = ["todo", "thinking", "review", "done", "dropped"] as const;
/** At most this many sends in one apply, so a triage pass can't start a fleet of runs. */
export const MAX_SENDS = 3;
const isThread = (id: string): boolean => id.startsWith("t_");
const isItem = (id: string): boolean => id.startsWith("in_");
const idOf = (o: Op): string => { const id = typeof o.id === "string" ? o.id.trim() : ""; return isThread(id) || isItem(id) ? id : fail(`${o.op}: id is a t_ thread or an in_ inbox item.`); };
const because = (o: Op): string | null => (o.because === undefined ? null : typeof o.because === "string" && o.because.trim() ? o.because.trim().slice(0, 300) : fail(`${o.op}: because is a few words.`));

/** What an agent did to a thread shows on it as a dated line from Claude. */
function said(taskId: string, line: string): void {
  q.insUpdate.run(genId("u_"), taskId, now(), line, JSON.stringify({ source: "Claude" }), "[]");
}

interface DashOp {
  fields: Record<string, object>;
  does: string;
  check(o: Op): void;
  /** Awaits what the op needs outside the commit; the function it returns runs inside it. */
  prepare?(o: Op, run: string | null): Promise<() => string>;
  run?(o: Op): string;
}

export const DASH_OPS: Record<string, DashOp> = {
  add: {
    does: "Adds a task: to the inbox for the reader to keep or drop, or with to straight into to-do or thinking as a thread.",
    fields: { title: text(300, "One line, the way the person would say it."), "context?": text(400, "A line or two on what this is and why it came up. The reader writes the rest, so don't draft a plan."),
      from: FROM, "links?": { type: "array", maxItems: 20, items: LINK, description: "What it is about and already exists." }, "area?": AREA,
      "to?": { type: "string", enum: ["inbox", "todo", "thinking"], description: "Where it lands. Default inbox." } },
    check: (o) => { checkItem({ ...o, op: undefined, to: undefined }, o.op); if (o.to !== undefined && !["inbox", "todo", "thinking"].includes(String(o.to))) fail("add: to is inbox, todo or thinking."); },
    run: (o) => {
      const { op: _op, to, ...raw } = o;
      const it = checkItem(raw, "add");
      if (to === undefined || to === "inbox") return `inbox ${addItems([it])[0]}: "${it.title}"`;
      const [id] = addItems([it]);
      const kept = keepItem(id, { stage: to });
      said(kept.result, `Added to ${String(to)} by Claude`);
      return `thread ${kept.result} in ${String(to)}: "${it.title}"`;
    },
  },
  edit: {
    does: "Changes a thread's or an open inbox item's title, notes (body), context, links or area. Each field is optional.",
    fields: { id: ID, "title?": text(300, "A new title."), "body?": text(20000, "New notes; for a thread, the prompt the reader trims."), "context?": text(400, "An inbox item's new context."),
      "links?": { type: "array", maxItems: 20, items: LINK, description: "The whole new list of links." }, "area?": AREA, "because?": BECAUSE },
    check: (o) => {
      idOf(o); because(o);
      if (o.links !== undefined) checkLinks(o.links, "edit.links");
      if (!["title", "body", "context", "links", "area"].some((k) => o[k] !== undefined)) fail("edit: name at least one of title, body, context, links, area.");
    },
    run: (o) => {
      const id = idOf(o);
      if (isItem(id)) {
        if (o.links !== undefined) fail("edit: an inbox item's links are kept as they came; move it to a thread first.");
        const { op: _op, id: _id, because: _because, ...fields } = o;
        editItem(id, fields);
        return `edited inbox ${id}`;
      }
      if (o.context !== undefined) fail("edit: a thread has no context; write it into body.");
      const { op: _op, id: _id, because: _because, ...fields } = o;
      patchTask(id, fields);
      said(id, `Edited by Claude${because(o) ? `: ${because(o)}` : ""}`);
      return `edited ${id}`;
    },
  },
  move: {
    does: `Moves a thread to ${AGENT_MOVES.join(", ")}; dropped is delete, and the reader can bring it back from the archive. An inbox item moved to todo, thinking or review is kept there as a thread; moved to dropped, it is dropped. decide, implementing and finish are reached only through send or post.`,
    fields: { id: ID, to: { type: "string", enum: [...AGENT_MOVES] }, "because?": BECAUSE },
    check: (o) => {
      idOf(o); because(o);
      if (!(AGENT_MOVES as readonly unknown[]).includes(o.to)) fail(`move: to is one of ${AGENT_MOVES.join(", ")}; a thread goes to decide, implementing or finish through send or post.`);
      if (isItem(idOf(o)) && o.to === "done") fail("move: an inbox item is kept (todo, thinking, review) or dropped, not done.");
    },
    run: (o) => {
      const id = idOf(o), to = String(o.to), why = because(o);
      if (isItem(id)) {
        if (to === "dropped") { dropItem(id); return `dropped inbox ${id}`; }
        const kept = keepItem(id, { stage: to });
        said(kept.result, `Kept in ${to} by Claude${why ? `: ${why}` : ""}`);
        return `kept inbox ${id} as ${kept.result} in ${to}`;
      }
      const from = stageOf(q.task.get(id) ?? fail(`No thread ${id}.`));
      if (from === "implementing") fail(`move: ${id} is in implementing, with a run; post a page with lands instead.`);
      patchTask(id, { stage: to, ...(to === "done" || to === "dropped" ? { cleared: true } : {}) });
      said(id, `Moved ${from} → ${to} by Claude${why ? `: ${why}` : ""}`);
      return `moved ${id} ${from} → ${to}`;
    },
  },
  send: {
    does: `Sends a thread in to-do or thinking to Dispatch, as the reader's Send to Dispatch does: it moves to implementing, for a run to open with dashboard_read({ task, as: "json" }). brief is a line added to its notes, e.g. what to research. At most ${MAX_SENDS} per apply. It wakes no run: open it now, or the next run takes it.`,
    fields: { id: { type: "string", description: "The thread's t_ id." }, "brief?": text(2000, "What the run should do, added to the thread's notes.") },
    check: (o) => { if (!isThread(idOf(o))) fail("send: id is a t_ thread; keep an inbox item with move first."); },
    run: (o) => {
      const id = idOf(o);
      if (typeof o.brief === "string" && o.brief.trim()) {
        const t = q.task.get(id) ?? fail(`No thread ${id}.`);
        patchTask(id, { body: `${t.body.trimEnd()}${t.body.trim() ? "\n\n" : ""}Brief from Claude: ${o.brief.trim()}` });
      }
      sendThread(id, null);
      said(id, "Sent to Dispatch by Claude");
      return `sent ${id}; it is in implementing`;
    },
  },
  post: {
    does: "Posts the next version of a thread in implementing, and replies under the reader's notes, as dashboard_post did: page, lands (decide, review, finish), replies, ask and heard.",
    fields: { id: { type: "string", description: "The thread's t_ id." }, "page?": { type: "string", description: "The next version's HTML, a whole self-contained page." },
      "lands?": { type: "string", enum: ["decide", "review", "finish"], description: "Where the page goes. Default: where the reader pressed Send." },
      "replies?": { type: "object", additionalProperties: { type: "string" }, description: "{ noteId: \"text\" }, ids from the thread's notes." },
      "ask?": text(600, "The reader's ask as it stands now, in your words."), "heard?": text(600, "How you read it: what this version does about it.") },
    check: (o) => { if (!isThread(idOf(o))) fail("post: id is a t_ thread."); },
    prepare: (o, run) => preparePost(idOf(o), { page: o.page, replies: o.replies, lands: o.lands, ask: o.ask, heard: o.heard }, run),
  },
  pad: {
    does: "Adds a line to the end of the reader's notepad. Never rewrites it.",
    fields: { text: text(4000, "One line; newlines become spaces.") },
    check: (o) => { if (typeof o.text !== "string" || !o.text.trim()) fail("pad: text is a line."); },
    run: (o) => {
      const cur = padOf().text, line = String(o.text).replace(/\s+/g, " ").trim().slice(0, 4000);
      writePad(`${cur.trimEnd()}${cur.trim() ? "\n" : ""}${line}`);
      return "added a line to the notepad";
    },
  },
};

const fieldName = (k: string): string => k.replace(/\?$/, "");
export const DASH_OP_SCHEMAS = Object.entries(DASH_OPS).map(([name, o]) => ({
  type: "object", description: o.does, additionalProperties: false,
  properties: { op: { type: "string", enum: [name] }, ...Object.fromEntries(Object.entries(o.fields).map(([k, v]) => [fieldName(k), v])) },
  required: ["op", ...Object.keys(o.fields).filter((k) => !k.endsWith("?"))],
}));

/** Checks every op's shape before anything is prepared or written; the errors name the op by its place in the list. */
export function checkDashOps(raw: unknown): Op[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) fail("ops is a list of 1 to 50 ops.");
  const ops = (raw as unknown[]).map((o, i) => {
    const op = (o ?? {}) as Op;
    const def = DASH_OPS[String(op.op)] ?? fail(`ops[${i}]: op is one of ${Object.keys(DASH_OPS).join(", ")}.`);
    const known = new Set(["op", ...Object.keys(def.fields).map(fieldName)]);
    const extra = Object.keys(op).filter((k) => !known.has(k));
    if (extra.length) fail(`ops[${i}] (${op.op}): no field ${extra.join(", ")}.`);
    for (const k of Object.keys(def.fields)) if (!k.endsWith("?") && op[k] === undefined) fail(`ops[${i}] (${op.op}): ${k} is required.`);
    try { def.check(op); } catch (e) { if (e instanceof DashError) fail(`ops[${i}]: ${e.message}`); throw e; }
    return op;
  });
  if (ops.filter((o) => o.op === "send").length > MAX_SENDS) fail(`At most ${MAX_SENDS} sends in one apply.`);
  return ops;
}

/** Prepares the ops that await (a page), then hands back the one function that writes them all, in order, inside the commit. */
export async function prepareDashOps(ops: Op[], run: string | null): Promise<() => string> {
  const steps: (() => string)[] = [];
  for (const o of ops) {
    const def = DASH_OPS[o.op];
    steps.push(def.prepare ? await def.prepare(o, run) : () => def.run!(o));
  }
  return () => steps.map((step, i) => {
    try { return `- ${step()}`; } catch (e) { if (e instanceof DashError) fail(`ops[${i}] (${ops[i].op}): ${e.message} Nothing was applied.`); throw e; }
  }).join("\n");
}
