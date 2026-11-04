import type { BoardPlan } from "../../../shared/types/index.ts";
import { planRepo as q } from "./repo.ts";

// Rides every board state: four primary-key probes, no joins; a deleted item's place is swept at delete.
export function planOf(boardId: string): BoardPlan {
  const places: BoardPlan["places"] = {};
  for (const p of q.placesOf.all(boardId)) places[p.item] = { group: p.group_id, milestone: p.milestone_id, pinned: p.pinned !== 0, ord: p.ord };
  const purpose = q.boardPurpose.get(boardId);
  return {
    purpose: purpose?.purpose ?? "",
    rev: purpose?.plan_rev ?? 0,
    groups: q.groupsOf.all(boardId).map((g) => ({ id: g.id, name: g.name, ord: g.ord })),
    milestones: q.milestonesOf.all(boardId).map((m) => ({ id: m.id, name: m.name, due: m.due, note: m.note, doneAt: m.done_at ?? null, ord: m.ord })),
    places,
  };
}
