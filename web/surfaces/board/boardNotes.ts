import { useSyncExternalStore } from "react";
import { NotesSave } from "../../data/notes-save.ts";
import { notesSender } from "../../data/entities/notes.ts";
import { StrataAnswer, StrataFromShelf } from "../../data/api.ts";
import { mutator } from "../../data/mutate.ts";

export interface NotesView {
  text: string;
  editing: boolean;
}

let view: NotesView = { text: "", editing: false };
const subs = new Set<() => void>();
const publish = (next: NotesView) => {
  if (next.text === view.text && next.editing === view.editing) return;
  view = next;
  for (const s of subs) s();
};

let failed: (e: unknown) => void = () => {};
let save: NotesSave | null = null;
export function notesSave(): NotesSave {
  return save ??= new NotesSave({ send: notesSender(), failed: (e) => failed(e) });
}

export const boardNotes = {
  view: (): NotesView => view,
  subscribe(fn: () => void): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
  seed(board: string, st: { notes?: string; notesRev?: number }): void {
    publish({ ...view, text: notesSave().seed(board, st.notes || "", { stale: StrataFromShelf(st), rev: st.notesRev, epoch: StrataAnswer(st)?.epoch }) });
  },
  edit(text: string): void {
    if (notesSave().stale) return;
    publish({ ...view, text });
    notesSave().edit(text);
  },
  set(text: string): void { publish({ ...view, text }); },
  setEditing(editing: boolean): void { publish({ ...view, editing }); },
  onFailed(fn: (e: unknown) => void): void { failed = fn; },
};

export function useBoardNotes(): NotesView {
  return useSyncExternalStore(boardNotes.subscribe, boardNotes.view);
}

export function installNotesLeave(): () => void {
  const ns = notesSave();
  const hidden = () => { if (document.visibilityState === "hidden") ns.leave(false); };
  document.addEventListener("visibilitychange", hidden);
  const off = mutator.onLeave(() => ns.leave(true));
  // unsaved text outside the save path keeps the "Leave site?" prompt up
  const unhold = mutator.holds(() => ns.owes(), ns.subscribe);
  return () => { document.removeEventListener("visibilitychange", hidden); off(); unhold(); };
}
