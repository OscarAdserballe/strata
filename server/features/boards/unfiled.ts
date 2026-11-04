import { boardsRepo as q } from "./repo.ts";
import { now } from "../../platform/db/sql.ts";

export const INBOX_ID = "inbox";
export const INBOX_TYPE = "inbox";

/** Created lazily, so a room that never had an unfiled source shows no empty drawer. */
export function ensureInbox(): string {
  const have = q.board.get(INBOX_ID);
  if (!have) {
    const t = now();
    q.insBoard.run(INBOX_ID, "unfiled", INBOX_TYPE, t, t);
  }
  return INBOX_ID;
}
