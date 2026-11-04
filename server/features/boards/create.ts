import { q } from "../repo.ts";
import { now, genId } from "../../platform/db/sql.ts";

/** A new board with its opening message; call inside a commit. */
export function insertBoard(title: string, question: string): string {
  const id = genId("b-"); const t = now();
  q.insBoard.run(id, title, "blank", t, t);
  q.insMsg.run(id, null, "assistant", question
    ? "Good question to read against. Drop the sources you're working through — I'll ground everything in them, and you can ask me whatever you don't understand."
    : "Fresh board. Drop a source you're reading — I'll ground everything in it, and you can ask me whatever you don't understand.", null, JSON.stringify([]), 0, now());
  return id;
}
