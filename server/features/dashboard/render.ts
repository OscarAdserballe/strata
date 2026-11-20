// dashboard_read's answer: the board as Markdown, one block per thread, cut to the token budget.
import { paged, pagedText, when } from "../agent/render.ts";
import { archive, handledSince, OPEN_STAGES, snapshot, type Handled, type TaskView } from "./dashboard.ts";

const HEADS: [string, string][] = [["todo", "To-do"], ["thinking", "Thinking"], ["decide", "Decide"], ["implementing", "Implementing"], ["review", "Review"], ["finish", "Finish"], ["done", "Done"], ["dropped", "Dropped"]];
const linkLine = (ls: TaskView["links"]): string => ls.map((l) => `${l.kind} ${l.ref}${l.title ? ` (${l.title})` : ""}${l.url ? ` <${l.url}>` : ""}`).join(" · ");
const ended = (t: TaskView): boolean => t.stage === "done" || t.stage === "dropped";

function block(t: TaskView): string {
  const lines = [`### ${t.title} · ${t.id} · ${t.area}${t.clearedAt ? " · archived" : ""}`];
  if (t.splitFrom) lines.push(`Split from: ${t.splitFrom.title} · ${t.splitFrom.id}`);
  if (t.links.length) lines.push(`Links: ${linkLine(t.links)}`);
  if (t.createdFrom) lines.push(`From: ${t.createdFrom.source}${t.createdFrom.quote ? ` — "${t.createdFrom.quote}"` : ""}`);
  if (t.body.trim()) lines.push("", t.body.trim());
  for (const u of t.updates) lines.push("", `── ${when.minute(u.at)} · ${u.from?.source ?? "you"} ──`, u.text);
  return lines.join("\n");
}

function inboxLine(i: Record<string, unknown>): string {
  const from = (i.from as { source?: string } | undefined)?.source ?? "?";
  const split = (i.splitFrom as { id?: string } | null | undefined)?.id;
  return `- ${String(i.id)} · "${String(i.title ?? i.text ?? "")}" · from ${from}${split ? ` · split from ${split}` : ""}${i.context ? `\n  ${String(i.context).replace(/\n+/g, " ")}` : ""}`;
}

export const HANDLED_DAYS = 7;
const DAY = 86_400_000;
const sourceOf = (h: Handled): string => h.source.split(/[\s·:]/)[0] || "Other";

/** One block per source, so a repeat from the same Slack thread or Linear issue is easy to spot. */
function handledBlock(at: number): string[] {
  const rows = handledSince(at);
  if (!rows.length) return [];
  const groups = new Map<string, Handled[]>();
  for (const h of rows) groups.set(sourceOf(h), [...(groups.get(sourceOf(h)) ?? []), h]);
  const lines = [`## Handled in the last ${HANDLED_DAYS} days (don't add these again)`];
  for (const [src, list] of groups) {
    lines.push(src);
    for (const h of list) lines.push(`- ${h.outcome} ${when.day(h.at)} · "${h.title}"${h.link ? ` · ${h.link.ref}${h.link.url ? ` <${h.link.url}>` : ""}` : ""}`);
  }
  return [lines.join("\n")];
}

export function renderDashboard(args: { task?: unknown; stages?: unknown; done_since?: unknown; area?: unknown; cursor?: unknown }, budget: number): string {
  const { tasks: live, inbox } = snapshot();
  const since = typeof args.done_since === "string" ? Date.parse(args.done_since) : NaN;
  const tasks = args.task !== undefined || !Number.isNaN(since) ? [...live, ...archive().tasks] : live;
  if (args.task !== undefined) {
    const id = String(args.task);
    const t = tasks.find((x) => x.id === id || x.title.toLowerCase() === id.toLowerCase());
    if (!t) return `No task "${id}". Call dashboard_read() for the whole board.`;
    return pagedText("", block(t), args.cursor, budget, (c) => `dashboard_read({ task: "${t.id}", cursor: "${c}" })`);
  }
  const filtered = Array.isArray(args.stages) && args.stages.length > 0;
  const stages = filtered ? (args.stages as unknown[]).map((x) => (String(x) === "backlog" ? "todo" : String(x))) : [...OPEN_STAGES, "decide", "implementing", "finish"];
  if (!Number.isNaN(since)) for (const s of ["done", "dropped"]) if (!stages.includes(s)) stages.push(s);
  const area = args.area === "work" || args.area === "personal" ? args.area : null;
  const shown = tasks.filter((t) => (!area || t.area === area) && stages.includes(t.stage) && (!ended(t) || Number.isNaN(since) || t.updatedAt >= since));
  const count = (s: string) => live.filter((t) => t.stage === s && (!area || t.area === area)).length;
  const head = `# Dashboard${area ? ` · ${area}` : ""} · ${when.minute(Date.now())}\nWork ${live.filter((t) => t.area === "work" && !ended(t)).length} open · Personal ${live.filter((t) => t.area === "personal" && !ended(t)).length} open\nInbox ${inbox.length} · To-do ${count("todo")} · Thinking ${count("thinking")} · Decide ${count("decide")} · Implementing ${count("implementing")} · Review ${count("review")} · Finish ${count("finish")}`;
  const items: string[] = [];
  for (const [s, name] of HEADS) {
    const list = shown.filter((t) => t.stage === s);
    if (list.length) items.push(`## ${name}`, ...list.map((t) => `${block(t)}\n`));
  }
  if (!filtered && inbox.length) items.push("## Inbox", ...inbox.map(inboxLine));
  if (!filtered && !area) items.push(...handledBlock(Date.now() - HANDLED_DAYS * DAY));
  const again = (c: string) => `dashboard_read({ ${filtered ? `stages: ${JSON.stringify(stages)}, ` : ""}${area ? `area: "${area}", ` : ""}cursor: "${c}" })`;
  return paged(head, items, args.cursor, budget, again, "Nothing on the dashboard yet.");
}
