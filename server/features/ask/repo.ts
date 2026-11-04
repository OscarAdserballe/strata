import { stmt } from "../../platform/db/sql.ts";
import type { AskRow, MessageRow } from "../../platform/db/rows.ts";

export const askRepo = {
  // idx restarts at 0 after a clear, so the full record (archived included) reads in id order.
  messagesOf: stmt<MessageRow>("SELECT * FROM messages WHERE board_id = ? AND archived = 0 ORDER BY idx ASC"),
  messageCount: stmt<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE board_id = ? AND archived = 0"),
  threadPage: stmt<MessageRow>(`SELECT role,text,idx,resource_id,ask_id FROM messages WHERE board_id=? AND archived=0
    AND ((resource_id IS NULL AND ? IS NULL) OR resource_id=?) AND idx<? ORDER BY idx DESC LIMIT ?`),
  threadOf: stmt<MessageRow>(`SELECT * FROM messages WHERE board_id = ? AND archived = 0
    AND ((resource_id IS NULL AND ? IS NULL) OR resource_id = ?) ORDER BY idx ASC`),
  // MAX+1 over all rows, archived included: per-source threads would otherwise share an idx.
  nextMsgIdx: stmt<{ n: number }>("SELECT COALESCE(MAX(idx)+1, 0) AS n FROM messages WHERE board_id = ?"),
  insMsg: stmt("INSERT INTO messages (board_id,resource_id,role,text,calls,node_ids,idx,created_at) VALUES (?,?,?,?,?,?,?,?)"),
  archiveThread: stmt(`UPDATE messages SET archived = 1 WHERE board_id = ?
    AND ((resource_id IS NULL AND ? IS NULL) OR resource_id = ?)`),
  delBoardMessages: stmt("DELETE FROM messages WHERE board_id = ?"),
  // a question asked at words, and the turns under it
  insAskMsg: stmt("INSERT INTO messages (board_id,resource_id,role,text,calls,node_ids,idx,created_at,ask_id) VALUES (?,?,?,?,?,?,?,?,?)"),
  asksOf: stmt<AskRow>("SELECT id,resource_id,page,start_off,end_off,quote,rects,box,created_at FROM asks WHERE board_id = ? ORDER BY resource_id, created_at"),
  ask: stmt<AskRow>("SELECT id,resource_id,page,start_off,end_off,quote,rects,box,created_at FROM asks WHERE board_id = ? AND id = ?"),
  insAsk: stmt("INSERT INTO asks (id,board_id,resource_id,page,start_off,end_off,quote,rects,box,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"),
  delAsksOfResource: stmt("DELETE FROM asks WHERE resource_id = ?"),
  delBoardAsks: stmt("DELETE FROM asks WHERE board_id = ?"),
};
