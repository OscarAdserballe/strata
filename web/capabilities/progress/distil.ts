import { useEffect, useRef } from "react";
import { StrataAPI } from "../../data/api.ts";
import { useJobPoll } from "../../data/job-poll.ts";
import { store, useEntity } from "../../data/store.ts";
import { toast } from "../../shell/layers.ts";
import { navigation } from "../../shell/routes.ts";
import { onImportsLanded } from "../sources/import-watch.ts";
import type { DistilBusy } from "./DistilProgress.tsx";

// a busy source whose newest row has not moved in 30 minutes is stuck, not busy

type Wire = any;

export interface DistilWork {
  busy: DistilBusy[];
  failed: Array<{ r: { id: string }; name: string; error: string }>;
}

export function distilWorkOf(board: Wire, now = Date.now()): DistilWork {
  const out: { busy: Wire[]; failed: Wire[] } = { busy: [], failed: [] };
  if (!board) return out;
  const tr = board.trees || {};
  const secs = board.sections || [];
  const pairs: Wire[] = board.pairs || [];
  for (const r of board.resources || []) {
    const work = secs.filter((s: Wire) => s.resourceId === r.id && s.kind !== "apparatus");
    if (!work.length) continue;
    let queued = 0, done = 0, at = null, phase = null, err = null, newest = 0;
    for (const s of work) {
      const t = tr[s.id]; if (!t) continue;
      newest = Math.max(newest, t.at || 0);
      if (t.status === "preparing") { at = s; phase = "preparing"; }
      else if (t.status === "running") { at = s; phase = "reading"; }
      else if (t.status === "carding") { at = s; phase = "carding"; }
      else if (t.status === "queued") queued++;
      else if (t.status === "ready") done++;
      else if (t.status === "error") {
        const p = pairs.find((x) => x.sectionId === s.id);
        if (!p || !p.deck) err = t.error || "distil failed";
      }
    }
    const name = (r.filename || "a source").replace(/\.[^.]+$/, "");
    if (phase || queued) {
      if (now - newest > 30 * 60000) out.failed.push({ r, name, error: "didn't finish — the server may have been interrupted" });
      else out.busy.push({ r, name, phase, at, done, total: work.length, updatedAt: newest });
    } else if (err) out.failed.push({ r, name, error: err });
  }
  return out;
}

/** A source that arrived without cards: every section is waiting to be asked. */
export function isUnstudied(board: Wire, rid: string): boolean {
  const secs = (board?.sections || []).filter((s: Wire) => s.resourceId === rid);
  return secs.length > 0 && secs.every((s: Wire) => board.trees?.[s.id]?.status === "unstudied");
}

export async function generateCards(boardId: string | null, r: Wire, redistil: (board: string, source: string) => Promise<unknown>): Promise<boolean> {
  if (!boardId || !r || !(await redistil(boardId, r.id))) return false;
  toast("making flashcards from " + r.filename.replace(/\.[^.]+$/, "")); kickDistil();
  return true;
}

const KICK = "distil:kick";
export const kickDistil = (): void => { store.apply(KICK, 0, Date.now(), "wire"); };

export async function retryDistil(boardId: string | null, r: Wire, redistil: (board: string, source: string) => Promise<unknown>): Promise<void> {
  if (!boardId || !r || !(await redistil(boardId, r.id))) return;
  toast("distilling " + r.filename); kickDistil();
}

export interface DistilRoom {
  pair(): Wire;
  setBoard(state: Wire): void;
  drill: { setDecks(decks: Wire[]): unknown; loadDeck(slug: string, at: null): unknown };
}

export function useDistilPoll(boardId: string | null, work: DistilWork, paused: boolean, room: DistilRoom): void {
  const kicked = useEntity<number>(KICK) ?? 0;
  const at = useRef({ boardId, room });
  at.current = { boardId, room };
  useEffect(() => onImportsLanded(() => {
    const { boardId: id, room: r } = at.current;
    if (id) StrataAPI.getBoard(id).then(r.setBoard).catch(() => {});
    kickDistil();
  }), []);
  useJobPoll(boardId, !paused && (!!work.busy.length || Date.now() - kicked < 30000), async () => {
    const version = navigation.version;
    const [st, cs] = await Promise.all([StrataAPI.getBoard(boardId as string), StrataAPI.decks()]);
    if (!navigation.current(version)) return;
    const cur = room.pair();
    room.setBoard(st); room.drill.setDecks(cs || []);
    const mine = cur && !cur.isHome ? (st.pairs || []).find((p: Wire) => p.id === cur.id) : null;
    if (mine?.deck && !cur.deck) room.drill.loadDeck(mine.deck, null);
  });
}
