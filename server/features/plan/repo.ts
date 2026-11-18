import { stmt } from "../../platform/db/sql.ts";
import type { PlanGroupRow, PlanMilestoneRow, PlanPlaceRow } from "../../platform/db/rows.ts";

export const planRepo = {
  // The purpose is read separately rather than widening q.board, which is sent to the client as `board`.
  boardPurpose: stmt<{ purpose: string | null; ends_at: string | null; archived_at: number | null; starred_at: number | null; plan_rev: number }>(
    "SELECT purpose,ends_at,archived_at,starred_at,plan_rev FROM boards WHERE id = ?"),
  setBoardPurpose: stmt("UPDATE boards SET purpose = ? WHERE id = ?"),
  setBoardProject: stmt("UPDATE boards SET purpose = ?, ends_at = ?, archived_at = ? WHERE id = ?"),
  setBoardStar: stmt("UPDATE boards SET starred_at = ? WHERE id = ?"),
  groupsOf: stmt<PlanGroupRow>("SELECT id,name,ord,by_date FROM board_groups WHERE board_id = ? ORDER BY ord ASC, created_at ASC"),
  group: stmt<PlanGroupRow>("SELECT id,name,ord,by_date FROM board_groups WHERE board_id = ? AND id = ?"),
  nextGroupOrd: stmt<{ n: number }>("SELECT COALESCE(MAX(ord), -1) + 1 n FROM board_groups WHERE board_id = ?"),
  insGroup: stmt("INSERT INTO board_groups (id,board_id,name,ord,created_at) VALUES (?,?,?,?,?)"),
  renGroup: stmt("UPDATE board_groups SET name = ?, by_date = ? WHERE board_id = ? AND id = ?"),
  setGroupOrd: stmt("UPDATE board_groups SET ord = ? WHERE board_id = ? AND id = ?"),
  delGroup: stmt("DELETE FROM board_groups WHERE board_id = ? AND id = ?"),
  delBoardGroups: stmt("DELETE FROM board_groups WHERE board_id = ?"),
  milestonesOf: stmt<PlanMilestoneRow>("SELECT id,name,due,note,done_at,ord FROM board_milestones WHERE board_id = ? ORDER BY ord ASC, created_at ASC"),
  milestone: stmt<PlanMilestoneRow>("SELECT id,name,due,note,done_at,ord FROM board_milestones WHERE board_id = ? AND id = ?"),
  nextMilestoneOrd: stmt<{ n: number }>("SELECT COALESCE(MAX(ord), -1) + 1 n FROM board_milestones WHERE board_id = ?"),
  insMilestone: stmt("INSERT INTO board_milestones (id,board_id,name,ord,created_at) VALUES (?,?,?,?,?)"),
  updMilestone: stmt("UPDATE board_milestones SET name = ?, due = ?, note = ?, done_at = ? WHERE board_id = ? AND id = ?"),
  setMilestoneOrd: stmt("UPDATE board_milestones SET ord = ? WHERE board_id = ? AND id = ?"),
  delMilestone: stmt("DELETE FROM board_milestones WHERE board_id = ? AND id = ?"),
  delBoardMilestones: stmt("DELETE FROM board_milestones WHERE board_id = ?"),
  placesOf: stmt<PlanPlaceRow>("SELECT item,group_id,milestone_id,pinned,ord FROM board_places WHERE board_id = ?"),
  place: stmt<PlanPlaceRow>("SELECT item,group_id,milestone_id,pinned,ord FROM board_places WHERE board_id = ? AND item = ?"),
  // Two upserts, one per half of a place, so ordering never clobbers the pin and vice versa.
  putPlaceOrder: stmt(`INSERT INTO board_places (board_id,item,group_id,ord) VALUES (?,?,?,?)
    ON CONFLICT(board_id,item) DO UPDATE SET group_id = excluded.group_id, ord = excluded.ord`),
  putPlaceMark: stmt(`INSERT INTO board_places (board_id,item,milestone_id,pinned) VALUES (?,?,?,?)
    ON CONFLICT(board_id,item) DO UPDATE SET milestone_id = excluded.milestone_id, pinned = excluded.pinned`),
  ungroupPlaces: stmt("UPDATE board_places SET group_id = NULL, ord = NULL WHERE board_id = ? AND group_id = ?"),
  clearPlacesMilestone: stmt("UPDATE board_places SET milestone_id = NULL WHERE board_id = ? AND milestone_id = ?"),
  delPlace: stmt("DELETE FROM board_places WHERE board_id = ? AND item = ?"),
  delPlacesOfResourcePairs: stmt("DELETE FROM board_places WHERE board_id = ? AND item IN (SELECT id FROM pairs WHERE board_id = ? AND resource_id = ?)"),
  delBoardPlaces: stmt("DELETE FROM board_places WHERE board_id = ?"),
  // What a draft of units is made from: names and outlines, never a source's text.
  draftSources: stmt<{ id: string; filename: string | null; created_at: number }>(
    "SELECT id,filename,created_at FROM resources INDEXED BY resources_metadata WHERE board_id = ? ORDER BY created_at ASC, id ASC"),
  draftSections: stmt<{ resource_id: string; label: string | null; title: string | null }>(
    `SELECT s.resource_id, s.label, t.title FROM sections s LEFT JOIN trees t ON t.section_id = s.id
     WHERE s.board_id = ? ORDER BY s.resource_id, s.ord`),
};
