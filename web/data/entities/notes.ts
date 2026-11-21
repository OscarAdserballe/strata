import { store as roomStore, type Store } from "../store.ts";
import { mutate, mutator, type Mutator, type Op, type SaveError } from "../mutate.ts";
import { boardKey, notesKey, revOf, type BoardEntity, type NotesEntity } from "./boards.ts";
import { outbox as roomOutbox, Outbox, type Clash } from "../outbox.ts";

// A whole-document write over the draft's base: a 409 fails it and the saves behind it, with no silent merge.

export interface NotesAnswer { rev?: number; notesRev?: number }

export const notesLane = (board: string) => `notes:${board}`;

export const notesOps = {
  save(board: string, text: string, s: Store = roomStore, keepalive = false, base: number | null = null): Op<NotesAnswer | null> {
    const key = notesKey(board);
    return {
      label: "save the notes",
      lanes: [notesLane(board)],
      method: "PUT",
      path: `/api/boards/${board}/notes`,
      body: { text },
      base: () => base ?? s.entry<NotesEntity>(key)?.base?.notesRev ?? null,
      optimistic: [{ key, apply: (held: NotesEntity | undefined) => ({ notesRev: 0, ...held, text }) }],
      takeConflict: { key, fold: (_held, c) => ({ text: String((c.value as { text?: unknown })?.text ?? ""), notesRev: c.rev }) },
      coalesce: notesLane(board),
      flush: true,
      ...(keepalive ? { keepalive: true } : {}),
      // the server may answer 200 {rev, notesRev} or 204 (null): the text is confirmed either way
      confirm: (res, meta) => {
        // a receipt replayed after a lost answer says the revision the save landed at
        const rev = revOf(res?.notesRev ?? s.entry<NotesEntity>(key)?.base?.notesRev);
        s.apply<NotesEntity>(key, rev, { text, notesRev: rev }, "wire", { epoch: meta.epoch, stamp: meta.rev });
      },
    };
  },
};

/** A save as shelved: its base frozen at the click, so a replay hours later can't be sent over a text it never saw. */
export interface NotesAct { board: string; text: string; base: number | null }

export function notesKind(s: Store) {
  return {
    build: (a: NotesAct) => notesOps.save(a.board, a.text, s, false, a.base),
    collapse: (a: NotesAct) => a.board,
    clash: (e: SaveError, a: NotesAct) => {
      const theirs = String((e.conflict?.value as { text?: unknown } | null)?.text ?? "");
      // a lost save that landed comes back as "theirs": nothing changed elsewhere
      if (theirs === a.text) return null;
      const title = s.get<BoardEntity>(boardKey(a.board))?.board?.title;
      return { where: { board: a.board, ...(title ? { title } : {}), source: null, passage: null }, mine: a.text, theirs, rev: revOf(e.conflict?.rev), args: a };
    },
    over: (c: Clash): NotesAct => ({ board: (c.args as NotesAct).board, text: c.mine, base: c.rev }),
  };
}
roomOutbox.kind<NotesAct>("notes", notesKind(roomStore));

export const notes = {
  save: (board: string, text: string) => mutate(notesOps.save(board, text)),
};

/** NotesSave's transport; a save that runs out of retries releases its lane and NotesSave sends it again. Offline it waits on the device. */
export function notesSender(m: Mutator = mutator, s: Store = roomStore, o: Outbox = m === mutator && s === roomStore ? roomOutbox : scratch(m, s)) {
  return (board: string, text: string, keepalive = false, base: number | null = null): Promise<NotesAnswer | null> => {
    const act: NotesAct = { board, text, base: base ?? s.entry<NotesEntity>(notesKey(board))?.base?.notesRev ?? null };
    return o.send<NotesAnswer | null>("notes", act, notesOps.save(board, text, s, keepalive, base)).catch((e: SaveError) => {
      if (e?.retryable) m.discardFailed(notesLane(board));
      throw e;
    });
  };
}
function scratch(m: Mutator, s: Store): Outbox {
  const o = new Outbox(m);
  o.kind<NotesAct>("notes", notesKind(s));
  return o;
}
