import { StrataWhy } from "../../data/api.ts";
import { dash, type DashTask } from "../../data/entities/dashboard.ts";
import { toast } from "../../shell/layers.ts";

const NAME: Record<string, string> = { todo: "To-do", thinking: "Thinking", review: "Review", done: "Done", dropped: "Dropped" };
const failed = (e: unknown) => toast(StrataWhy(e, "not saved"), 4200);

/** A thread moved by hand. Done and dropped clear it off the board into the archive. */
export function move(t: DashTask, stage: string): void {
  if (stage === "done" || stage === "dropped") {
    toast(NAME[stage]);
    dash.patch(t.id, { stage, cleared: true }, () => null).catch(failed);
    return;
  }
  if (stage === "review") toast("In Review");
  else if (stage !== "thinking") toast(`Moved to ${NAME[stage].toLowerCase()}`);
  dash.patch(t.id, { stage }, (x) => ({ ...x, stage, updatedAt: Date.now() })).catch(failed);
}

export function saveText(id: string, field: "title" | "body", value: string): void {
  dash.text(id, field, field === "title" ? value.trim() || "Untitled" : value).catch(failed);
}
