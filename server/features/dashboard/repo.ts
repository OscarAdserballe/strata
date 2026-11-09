import { stmt } from "../../platform/db/sql.ts";

export interface TaskRow {
  id: string; title: string; body: string; state: string; waiting_on: string | null; parent_id: string | null;
  links: string; prompt: string | null; created_from: string | null; created_at: number; updated_at: number;
  pinned_at: number | null; cleared_at: number | null; area: string | null;
  stage: string | null; morning_at: number | null;
}
export interface UpdateRow { id: string; task_id: string; at: number; text: string; from_json: string | null; links: string }
export interface InboxRow { id: string; kind: string; item: string; at: number; handled_at: number | null; outcome: string | null; result_id: string | null }
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
  routine: stmt<RoutineRow>("SELECT url, token, ran_at, session_url, error, updated_at FROM dashboard_routine WHERE id = 1"),
  putRoutine: stmt(`INSERT INTO dashboard_routine (id,url,token,updated_at) VALUES (1,?,?,?)
    ON CONFLICT(id) DO UPDATE SET url=excluded.url, token=excluded.token, ran_at=NULL, session_url=NULL, error=NULL, updated_at=excluded.updated_at`),
  dropRoutine: stmt("DELETE FROM dashboard_routine WHERE id = 1"),
  routineRan: stmt("UPDATE dashboard_routine SET ran_at = ?, session_url = ?, error = ? WHERE id = 1"),
};
