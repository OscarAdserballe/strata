// A primer is one page a reader opens before page 1 of a source; the routine writes it, and Strata only stores and serves it.
import { now } from "../../platform/db/sql.ts";
import { idOf } from "../../../shared/agent/ids.ts";
import { agentRepo as a } from "../agent/repo.ts";
import { dispatchBoardId } from "../dashboard/dispatch.ts";
import { recordRun, wake, type Woken } from "../dashboard/routine.ts";
import { primersRepo as p, type PrimerStatus } from "./repo.ts";

// under the MCP message's 1 MB, with room for the JSON escaping around it
export const PRIMER_MAX = 512 * 1024;

export interface PrimerView { status: PrimerStatus | "none"; requestedAt: number | null; builtAt: number | null }

export function primerView(rid: string): PrimerView {
  const r = p.primer.get(rid);
  return { status: r?.status ?? "none", requestedAt: r?.requested_at ?? null, builtAt: r?.built_at ?? null };
}

export const isDispatchBoard = (boardId: string): boolean => boardId === dispatchBoardId();

const titleOf = (filename: string | null | undefined): string => String(filename ?? "untitled").replace(/\.(pdf|md|markdown|txt|html?)$/i, "");

export function wakeText(boardId: string, rid: string, filename?: string | null): string {
  const b = a.boardMeta.get(boardId);
  const name = filename ?? p.primerSource.get(boardId, rid)?.filename;
  return `Primer: ${titleOf(name)} (${idOf("source", rid)}) on ${b?.handle ?? boardId}`;
}

/** Inside a commit: true when this asked for one, false when one was already asked for. */
export const requestPrimer = (boardId: string, rid: string): boolean => p.requestPrimer.run(rid, boardId, now()).changes > 0;

// two presses at once share one wake: the routine's own cooldown is only recorded once the first has answered
const waking = new Map<string, Promise<Woken>>();

/** Awaited before the commit that records it, as Dispatch's presses are. */
export function wakeFor(boardId: string, rid: string, filename?: string | null): Promise<Woken> {
  const had = waking.get(rid);
  if (had) return had;
  const w = wake(wakeText(boardId, rid, filename)).finally(() => waking.delete(rid));
  waking.set(rid, w);
  return w;
}

/** A source that arrived asking for one, outside any request: wakes, then records how the run went. */
export async function wakeAfterArrival(boardId: string, rid: string): Promise<void> {
  const w = await wakeFor(boardId, rid);
  if (w.ran) recordRun(w.ran);
}
