import { StrataWhy } from "../../data/api.ts";
import { dash, type DashTask } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";

const NAME: Record<string, string> = { backlog: "Backlog", todo: "To-do", thinking: "Thinking", review: "Review", done: "Done", dropped: "Dropped" };
const failed = (e: unknown) => toast(StrataWhy(e, "not saved"), 4200);

/** A thread moved by hand. Done and dropped clear it off the board into the archive; leaving to-do lets go of a morning pick. */
export function move(t: DashTask, stage: string): void {
  if (stage === "done" || stage === "dropped") {
    toast(NAME[stage]);
    dash.patch(t.id, { stage, cleared: true }, () => null).catch(failed);
    return;
  }
  const morning = stage !== "todo" && stage !== "thinking" && t.morningAt ? { morning: false } : {};
  if (stage !== "thinking") toast(`Moved to ${NAME[stage].toLowerCase()}`);
  dash.patch(t.id, { stage, ...morning }, (x) => ({ ...x, stage, morningAt: "morning" in morning ? null : x.morningAt, updatedAt: Date.now() })).catch(failed);
}

/** Picked for tomorrow morning, which lifts a backlog thread into to-do. */
export function pick(id: string, on: boolean): Promise<unknown> {
  toast(on ? "Tomorrow morning" : "Not tomorrow");
  return dash.patch(id, { morning: on }, (x) => ({ ...x, morningAt: on ? (x.morningAt ?? Date.now()) : null, stage: on && x.stage === "backlog" ? "todo" : x.stage }))
    .catch(failed);
}

export function saveText(id: string, field: "title" | "body", value: string): void {
  dash.text(id, field, field === "title" ? value.trim() || "Untitled" : value).catch(failed);
}
