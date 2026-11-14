import { stmt } from "../../platform/db/sql.ts";

export interface TaskRow {
  id: string; title: string; body: string; state: string; waiting_on: string | null; parent_id: string | null;
  links: string; prompt: string | null; created_from: string | null; created_at: number; updated_at: number;
  pinned_at: number | null; cleared_at: number | null; area: string | null;
  stage: string | null; morning_at: number | null;
}
export interface UpdateRow { id: string; task_id: string; at: number; text: string; from_json: string | null; links: string }
export interface InboxRow { id: string; kind: string; item: string; at: number; handled_at: number | null; outcome: string | null; result_id: string | null }
export interface VersionRow { task_id: string; n: number; resource_id: string; landed: string; at: number }
export interface PressRow { id: string; task_id: string; kind: string; stage: string; version: number | null; at: number; session_url: string | null }
export interface NoteRow { id: string; resource_id: string; quote: string; note: string; box: string | null; created_at: number }
export interface ReplyRow { id: string; mark_id: string; author: string; text: string; created_at: number }
export interface RoutineRow { url: string; token: string; ran_at: number | null; session_url: string | null; error: string | null; updated_at: number }

export const dashboardRepo = {
  tasks: stmt<TaskRow>("SELECT * FROM dashboard_tasks WHERE cleared_at IS NULL ORDER BY created_at, rowid"),
  allTasks: stmt<TaskRow>("SELECT * FROM dashboard_tasks ORDER BY created_at, rowid"),
  cleared: stmt<TaskRow>("SELECT * FROM dashboard_tasks WHERE cleared_at IS NOT NULL ORDER BY updated_at DESC, rowid"),
  task: stmt<TaskRow>("SELECT * FROM dashboard_tasks WHERE id = ?"),
  insTask: stmt("INSERT INTO dashboard_tasks (id,title,body,state,waiting_on,parent_id,links,prompt,created_from,created_at,updated_at,area,stage) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"),
  setArea: stmt("UPDATE dashboard_tasks SET area = ?, updated_at = ? WHERE id = ?"),
  setTask: stmt("UPDATE dashboard_tasks SET title=?, body=?, state=?, waiting_on=?, parent_id=?, links=?, prompt=?, pinned_at=?, cleared_at=?, updated_at=?, stage=?, morning_at=? WHERE id = ?"),
  updates: stmt<UpdateRow>("SELECT * FROM dashboard_updates ORDER BY at, rowid"),
  updatesOf: stmt<UpdateRow>("SELECT * FROM dashboard_updates WHERE task_id = ? ORDER BY at, rowid"),
  inboxOpen: stmt<InboxRow>("SELECT * FROM dashboard_inbox WHERE handled_at IS NULL ORDER BY at, rowid"),
  inboxAll: stmt<InboxRow>("SELECT * FROM dashboard_inbox ORDER BY at, rowid"),
  inboxItem: stmt<InboxRow>("SELECT * FROM dashboard_inbox WHERE id = ?"),
  insInbox: stmt("INSERT INTO dashboard_inbox (id,kind,item,at) VALUES (?,?,?,?)"),
  setInbox: stmt("UPDATE dashboard_inbox SET kind=?, item=? WHERE id = ? AND handled_at IS NULL"),
  handleInbox: stmt("UPDATE dashboard_inbox SET handled_at=?, outcome=?, result_id=? WHERE id = ? AND handled_at IS NULL"),
  setStage: stmt("UPDATE dashboard_tasks SET stage = ?, state = ?, morning_at = NULL, pinned_at = NULL, cleared_at = ?, updated_at = ? WHERE id = ?"),
  // Dispatch: versions and presses; a version whose source was removed from its board is skipped.
  versions: stmt<VersionRow>("SELECT v.* FROM dashboard_versions v JOIN resources r ON r.id = v.resource_id ORDER BY v.task_id, v.n"),
  versionsOf: stmt<VersionRow>("SELECT v.* FROM dashboard_versions v JOIN resources r ON r.id = v.resource_id WHERE v.task_id = ? ORDER BY v.n"),
  lastN: stmt<{ n: number }>("SELECT COALESCE(MAX(n), 0) AS n FROM dashboard_versions WHERE task_id = ?"),
  insVersion: stmt("INSERT INTO dashboard_versions (task_id, n, resource_id, landed, at) VALUES (?,?,?,?,?)"),
  presses: stmt<PressRow>("SELECT * FROM dashboard_presses ORDER BY task_id, at, rowid"),
  pressesOf: stmt<PressRow>("SELECT * FROM dashboard_presses WHERE task_id = ? ORDER BY at, rowid"),
  lastPress: stmt<PressRow>("SELECT * FROM dashboard_presses WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1"),
  insPress: stmt("INSERT INTO dashboard_presses (id, task_id, kind, stage, version, at, session_url) VALUES (?,?,?,?,?,?,?)"),
  // The dashboard's revision: every write stamps a thread's updated_at or an inbox item's at or handled_at.
  dashRev: stmt<{ rev: number }>(`SELECT COALESCE(MAX(r), 0) AS rev FROM (SELECT MAX(updated_at) AS r FROM dashboard_tasks
    UNION ALL SELECT MAX(COALESCE(handled_at, at)) FROM dashboard_inbox)`),
  dispatched: stmt<{ task_id: string }>("SELECT DISTINCT task_id FROM dashboard_presses"),
  // The reader's notes are marks with words in them, on the version's source.
  noteCounts: stmt<{ resource_id: string; n: number }>(`SELECT m.resource_id, COUNT(*) AS n FROM dashboard_versions v
    JOIN marks m ON m.resource_id = v.resource_id WHERE m.note IS NOT NULL AND trim(m.note) <> '' GROUP BY m.resource_id`),
  notesOn: stmt<NoteRow>("SELECT id, resource_id, quote, note, box, created_at FROM marks WHERE resource_id = ? AND note IS NOT NULL AND trim(note) <> '' ORDER BY created_at, id"),
  repliesOn: stmt<ReplyRow>("SELECT id, mark_id, author, text, created_at FROM mark_replies WHERE resource_id = ? ORDER BY created_at, id"),
  noteMark: stmt<{ id: string; board_id: string; resource_id: string; note: string | null }>("SELECT id, board_id, resource_id, note FROM marks WHERE id = ?"),
  insAgentReply: stmt("INSERT INTO mark_replies (id,board_id,mark_id,resource_id,author,text,created_at,updated_at) VALUES (?,?,?,?,'agent',?,?,?)"),
  routine: stmt<RoutineRow>("SELECT url, token, ran_at, session_url, error, updated_at FROM dashboard_routine WHERE id = 1"),
  putRoutine: stmt(`INSERT INTO dashboard_routine (id,url,token,updated_at) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, token=excluded.token, ran_at=NULL, session_url=NULL, error=NULL, updated_at=excluded.updated_at`),
  dropRoutine: stmt("DELETE FROM dashboard_routine WHERE id = 1"),
  routineRan: stmt("UPDATE dashboard_routine SET ran_at = ?, session_url = ?, error = ? WHERE id = 1"),
};
