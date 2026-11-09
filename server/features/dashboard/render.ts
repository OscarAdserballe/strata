// dashboard_read's answer: the board as Markdown, one block per thread, cut to the token budget.
import { paged, pagedText, when } from "../agent/render.ts";
import { archive, OPEN_STAGES, snapshot, type TaskView } from "./dashboard.ts";

const HEADS: [string, string][] = [["backlog", "Backlog"], ["todo", "To-do"], ["thinking", "Thinking"], ["review", "Review"], ["done", "Done"], ["dropped", "Dropped"]];
const linkLine = (ls: TaskView["links"]): string => ls.map((l) => `${l.kind} ${l.ref}${l.title ? ` (${l.title})` : ""}${l.url ? ` <${l.url}>` : ""}`).join(" · ");
const ended = (t: TaskView): boolean => t.stage === "done" || t.stage === "dropped";

function block(t: TaskView): string {
  const lines = [`### ${t.title} · ${t.id} · ${t.area}${t.morningAt && t.stage === "todo" ? " · tomorrow morning" : ""}${t.clearedAt ? " · archived" : ""}`];
  if (t.links.length) lines.push(`Links: ${linkLine(t.links)}`);
  if (t.createdFrom) lines.push(`From: ${t.createdFrom.source}${t.createdFrom.quote ? ` — "${t.createdFrom.quote}"` : ""}`);
  if (t.body.trim()) lines.push("", t.body.trim());
  for (const u of t.updates) lines.push("", `── ${when.minute(u.at)} · ${u.from?.source ?? "you"} ──`, u.text);
  return lines.join("\n");
}

function inboxLine(i: Record<string, unknown>): string {
  const from = (i.from as { source?: string } | undefined)?.source ?? "?";
  return `- ${String(i.id)} · "${String(i.title ?? i.text ?? "")}" · from ${from}${i.context ? `\n  ${String(i.context).replace(/\n+/g, " ")}` : ""}`;
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
  const stages = filtered ? (args.stages as unknown[]).map(String) : [...OPEN_STAGES];
  if (!Number.isNaN(since)) for (const s of ["done", "dropped"]) if (!stages.includes(s)) stages.push(s);
  const area = args.area === "work" || args.area === "personal" ? args.area : null;
  const shown = tasks.filter((t) => (!area || t.area === area) && stages.includes(t.stage) && (!ended(t) || Number.isNaN(since) || t.updatedAt >= since));
  const count = (s: string) => live.filter((t) => t.stage === s && (!area || t.area === area)).length;
  const morning = live.filter((t) => t.stage === "todo" && t.morningAt && (!area || t.area === area)).length;
  const head = `# Dashboard${area ? ` · ${area}` : ""} · ${when.minute(Date.now())}\nWork ${live.filter((t) => t.area === "work" && !ended(t)).length} open · Personal ${live.filter((t) => t.area === "personal" && !ended(t)).length} open\nInbox ${inbox.length} · Backlog ${count("backlog")} · To-do ${count("todo")}${morning ? ` (${morning} for tomorrow morning)` : ""} · Thinking ${count("thinking")} · Review ${count("review")}`;
  const items: string[] = [];
  for (const [s, name] of HEADS) {
    // Tomorrow morning's picks lead the to-do list.
    const list = shown.filter((t) => t.stage === s).sort((a, b) => Number(!!b.morningAt) - Number(!!a.morningAt));
    if (list.length) items.push(`## ${name}`, ...list.map((t) => `${block(t)}\n`));
  }
  if (!filtered && inbox.length) items.push("## Inbox", ...inbox.map(inboxLine));
  const again = (c: string) => `dashboard_read({ ${filtered ? `stages: ${JSON.stringify(stages)}, ` : ""}${area ? `area: "${area}", ` : ""}cursor: "${c}" })`;
  return paged(head, items, args.cursor, budget, again, "Nothing on the dashboard yet.");
}
