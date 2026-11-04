import { stmt } from "../../platform/db/sql.ts";
import type { MarkReplyRow, MarkRow } from "../../platform/db/rows.ts";

export const marksRepo = {
  marksOf: stmt<MarkRow>("SELECT id,resource_id,page,start_off,end_off,quote,note,rects,box,created_at FROM marks WHERE board_id = ? ORDER BY resource_id, page, start_off"),
  mark: stmt<MarkRow>("SELECT id,resource_id,page,start_off,end_off,quote,note,rects,box,created_at FROM marks WHERE board_id = ? AND id = ?"),
  insMark: stmt("INSERT INTO marks (id,board_id,resource_id,page,start_off,end_off,quote,note,rects,box,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"),
  setMarkNote: stmt("UPDATE marks SET note = ?, updated_at = ? WHERE board_id = ? AND id = ?"),
  delMark: stmt("DELETE FROM marks WHERE board_id = ? AND id = ?"),
  marksOfResource: stmt<{ id: string; start_off: number; end_off: number }>("SELECT id,start_off,end_off FROM marks WHERE resource_id = ?"),
  setMarkOffsets: stmt("UPDATE marks SET start_off = ?, end_off = ? WHERE id = ?"),
  delMarksOfResource: stmt("DELETE FROM marks WHERE resource_id = ?"),
  moveMarksOfResource: stmt("UPDATE marks SET board_id = ? WHERE board_id = ? AND resource_id = ?"),
  delBoardMarks: stmt("DELETE FROM marks WHERE board_id = ?"),
  repliesOf: stmt<MarkReplyRow>("SELECT id,mark_id,author,text,created_at FROM mark_replies WHERE board_id = ? ORDER BY mark_id, created_at, id"),
  repliesOfMark: stmt<MarkReplyRow>("SELECT id,mark_id,author,text,created_at FROM mark_replies WHERE board_id = ? AND mark_id = ? ORDER BY created_at, id"),
  markReply: stmt<MarkReplyRow>("SELECT id,mark_id,author,text,created_at FROM mark_replies WHERE board_id = ? AND id = ?"),
  insMarkReply: stmt("INSERT INTO mark_replies (id,board_id,mark_id,resource_id,author,text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"),
  delRepliesOfMark: stmt("DELETE FROM mark_replies WHERE board_id = ? AND mark_id = ?"),
  delRepliesOfResource: stmt("DELETE FROM mark_replies WHERE resource_id = ?"),
  delBoardReplies: stmt("DELETE FROM mark_replies WHERE board_id = ?"),
};
