import { store as roomStore, type Store } from "../store.ts";
import { mutate, mutator, type Mutator, type Op, type SaveError } from "../mutate.ts";
import { notesKey, revOf, type NotesEntity } from "./boards.ts";

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

export const notes = {
  save: (board: string, text: string) => mutate(notesOps.save(board, text)),
};

/** NotesSave's transport; a save that runs out of retries releases its lane and NotesSave sends it again. */
export function notesSender(m: Mutator = mutator, s: Store = roomStore) {
  return (board: string, text: string, keepalive = false, base: number | null = null): Promise<NotesAnswer | null> =>
    m.mutate(notesOps.save(board, text, s, keepalive, base)).catch((e: SaveError) => {
      if (e?.retryable) m.discardFailed(notesLane(board));
      throw e;
    });
}
