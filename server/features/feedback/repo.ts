import { stmt } from "../../platform/db/sql.ts";
import type { FeedbackRow } from "../../platform/db/rows.ts";

export const feedbackRepo = {
  insFeedback: stmt("INSERT INTO feedback (id,board_id,kind,card_id,deck,message_idx,context,comment,created_at) VALUES (?,?,?,?,?,?,?,?,?)"),
  feedbackOpen: stmt<FeedbackRow>("SELECT * FROM feedback WHERE resolved = 0 ORDER BY created_at DESC"),
  feedbackAll: stmt<FeedbackRow>("SELECT * FROM feedback ORDER BY created_at DESC"),
  setFeedbackResolved: stmt("UPDATE feedback SET resolved = ? WHERE id = ?"),
};
