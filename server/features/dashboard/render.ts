// dashboard_read's answer: the board as Markdown, one block per task, cut to the token budget.
import { paged, pagedText, when } from "../agent/render.ts";
import { archive, padText, snapshot, sourcesView, type Direction, type TaskView } from "./dashboard.ts";

const HEADS: [string, string][] = [["you", "Your move"], ["claude", "Claude is on it"], ["waiting", "Waiting on others"], ["later", "Later"], ["done", "Done"], ["dropped", "Dropped"]];
const linkLine = (ls: TaskView["links"]): string => ls.map((l) => `${l.kind} ${l.ref}${l.title ? ` (${l.title})` : ""}${l.url ? ` <${l.url}>` : ""}`).join(" · ");
const ended = (t: TaskView): boolean => t.state === "done" || t.state === "dropped";

function block(t: TaskView, all: TaskView[]): string {
  const parent = t.parent ? all.find((x) => x.id === t.parent) : null;
  const kids = all.filter((x) => x.parent === t.id);
  const head = `### ${t.title} · ${t.id} · ${t.area}${t.pinnedAt && !ended(t) && t.state !== "you" ? ` · ${t.state}` : ""}${parent ? ` · under ${parent.title} (${parent.id})` : ""}${t.state === "waiting" && t.waitingOn ? ` · on ${t.waitingOn}` : ""}${t.clearedAt ? " · archived" : ""}`;
  const lines = [head];
  if (t.links.length) lines.push(`Links: ${linkLine(t.links)}`);
  if (t.createdFrom) lines.push(`From: ${t.createdFrom.source}${t.createdFrom.quote ? ` — "${t.createdFrom.quote}"` : ""}`);
  if (t.body.trim()) lines.push("", t.body.trim());
  for (const u of t.updates) lines.push("", `── ${when.minute(u.at)} · ${u.from?.source ?? "you"} ──`, u.text);
  if (kids.length) lines.push("", `Subtasks: ${kids.map((k) => `${k.title} (${k.id}, ${k.state})`).join("; ")}`);
  if (t.prompt) lines.push("", "Your prompt for it:", t.prompt);
  return lines.join("\n");
}

function inboxLine(i: Record<string, unknown>): string {
  const from = (i.from as { source?: string } | undefined)?.source ?? "?";
  if (i.kind === "fragment") {
    const dirs = (i.directions as Direction[] | undefined) ?? [];
    const lines = [`- ${String(i.id)} · fragment · "${String(i.title)}" · from ${from}${i.wantsMore ? " · wants more directions: add them with dashboard_add_items({ items: [{ kind: \"fragment\", fragment: \"" + String(i.id) + "\", directions, from }] })" : ""}`];
    if (i.body) lines.push(`  ${String(i.body).replace(/\n+/g, " ")}`);
    for (const d of dirs) lines.push(`  · ${d.title}${d.body ? ` — ${d.body}` : ""}`);
    return lines.join("\n");
  }
  if (i.kind === "update" && i.body && !i.text) return `- ${String(i.id)} · rewrite · new description → ${String(i.task)} · from ${from}`;
  return `- ${String(i.id)} · ${String(i.kind)} · "${String(i.kind === "update" ? i.text : i.title)}"${i.kind === "update" ? ` → ${String(i.task)}${i.body ? " (with a new description)" : ""}` : ""} · from ${from}`;
}

export function renderDashboard(args: { task?: unknown; states?: unknown; done_since?: unknown; area?: unknown; cursor?: unknown }, budget: number): string {
  const { tasks: live, inbox, pad } = snapshot();
  const since = typeof args.done_since === "string" ? Date.parse(args.done_since) : NaN;
  const tasks = args.task !== undefined || !Number.isNaN(since) ? [...live, ...archive().tasks] : live;
  if (args.task !== undefined) {
    const id = String(args.task);
    const t = tasks.find((x) => x.id === id || x.title.toLowerCase() === id.toLowerCase());
    if (!t) return `No task "${id}". Call dashboard_read() for the whole board.`;
    return pagedText("", block(t, tasks), args.cursor, budget, (c) => `dashboard_read({ task: "${t.id}", cursor: "${c}" })`);
  }
  const filtered = Array.isArray(args.states) && args.states.length;
  const states = filtered ? (args.states as unknown[]).map(String) : ["you", "claude", "waiting", "later"];
  if (!Number.isNaN(since)) for (const s of ["done", "dropped"]) if (!states.includes(s)) states.push(s);
  const area = args.area === "work" || args.area === "personal" ? args.area : null;
  const shown = tasks.filter((t) => (!area || t.area === area) && states.includes(t.state) && (!ended(t) || Number.isNaN(since) || t.updatedAt >= since));
  const today = shown.filter((t) => t.pinnedAt && !ended(t)).sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
  const count = (s: string) => live.filter((t) => t.state === s && (!area || t.area === area)).length;
  const fragments = inbox.filter((i) => i.kind === "fragment").length;
  const head = `# Dashboard${area ? ` · ${area}` : ""} · ${when.minute(Date.now())}\nWork ${live.filter((t) => t.area === "work" && !ended(t)).length} open · Personal ${live.filter((t) => t.area === "personal" && !ended(t)).length} open\nToday ${today.length} · Inbox ${inbox.length}${fragments ? ` (${fragments} fragment${fragments > 1 ? "s" : ""})` : ""} · Your move ${count("you")} · Claude ${count("claude")} · Waiting ${count("waiting")} · Later ${count("later")}`;
  const items: string[] = [];
  if (today.length) items.push("## Today", ...today.map((t) => `${block(t, tasks)}\n`));
  for (const [s, name] of HEADS) {
    const list = shown.filter((t) => t.state === s && !(t.pinnedAt && !ended(t)));
    if (list.length) items.push(`## ${name}`, ...list.map((t) => `${block(t, tasks)}\n`));
  }
  if (!filtered) {
    if (inbox.length) items.push("## Inbox", ...inbox.map(inboxLine));
    const jotted = padText(pad.text);
    if (jotted) items.push("## Scratch pad (the reader's own notes; ideas here may become fragments)", jotted);
    const sources = sourcesView();
    if (sources.length) items.push("## Sources", ...sources.map((s) => `- ${s.source}${s.url ? ` <${s.url}>` : ""} · ${s.coverage === "full" ? "read in full" : s.coverage === "partial" ? `partly read${s.note ? `: ${s.note}` : ""}` : "coverage not stated"} · ${s.tasks} task${s.tasks === 1 ? "" : "s"}, ${s.done} done${s.inbox ? `, ${s.inbox} in the inbox` : ""}`));
  }
  const again = (c: string) => `dashboard_read({ ${filtered ? `states: ${JSON.stringify(args.states)}, ` : ""}${area ? `area: "${area}", ` : ""}cursor: "${c}" })`;
  return paged(head, items, args.cursor, budget, again, "Nothing on the dashboard yet.");
}
