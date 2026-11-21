import type { Clash, Op, Recipe } from "../mutate.ts";
import { dashOps } from "./dashboard.ts";
import { keepOps } from "./keeps.ts";
import { markOps, type MarkDraft } from "./marks.ts";

// An op kept on the device is stored as its recipe, since its layers and confirm are functions; boot builds it again here.
// Grades are not here: they keep their own shelf in grades.ts.

const text = (v: unknown): v is string => typeof v === "string";
const noteOf = (v: unknown): string | null => (text(v) ? v : null);

export function build(recipe: Recipe): Op<unknown> | null {
  const a = Array.isArray(recipe?.args) ? recipe.args : [];
  switch (recipe?.kind) {
    case "keep": return text(a[0]) && text(a[1]) ? keepOps.toggle(a[0], a[1], a[2] === true) as Op<unknown> : null;
    case "mark.create": return text(a[0]) && a[1] && typeof a[1] === "object" ? markOps.create(a[0], a[1] as MarkDraft, () => Number(a[2]) || Date.now()) as Op<unknown> : null;
    case "mark.note": return text(a[0]) && text(a[1]) ? markOps.note(a[0], a[1], noteOf(a[2]), a.length > 3 ? noteOf(a[3]) : undefined) as Op<unknown> : null;
    case "mark.reply": return text(a[0]) && text(a[1]) && text(a[2]) && text(a[3]) ? markOps.reply(a[0], a[1], a[2], a[3], () => Number(a[4]) || Date.now()) as Op<unknown> : null;
    case "mark.remove": return text(a[0]) && text(a[1]) ? markOps.remove(a[0], a[1], a[2] === true) as Op<unknown> : null;
    case "clash.agent": return a[0] && typeof a[0] === "object" ? handOver(a[0] as Clash) : null;
    default: return null;
  }
}

/** A clash handed to an agent lands in the Dispatch inbox with both texts, so whoever picks it up needs nothing else. */
function handOver(c: Clash): Op<unknown> {
  const quote = (t: string) => (t ? t.split("\n").map((l) => `> ${l}`).join("\n") : "> (empty)");
  return dashOps.inbox({
    title: `Settle a clash: ${c.where}`.slice(0, 300),
    context: "Written on one device while offline and changed on another meanwhile; Strata kept theirs and listed mine.",
    body: `**Mine (this device)**\n${quote(c.mine)}\n\n**Theirs (on the server now)**\n${quote(c.theirs)}`.slice(0, 20000),
    from: { source: "Strata · clash list", quote: c.mine.slice(0, 2000) },
    links: c.ref ? [{ kind: "strata", ref: c.ref.slice(0, 200), title: c.where.slice(0, 300) }] : [],
    area: "personal",
  }, c.id) as Op<unknown>;
}
