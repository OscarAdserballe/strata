// Debounced save of a board's log; "saved" means the server acknowledged exactly the text in the box.

import { store as roomStore, type Entry, type Store } from "./store.ts";
import { notesKey, type NotesEntity } from "./entities/boards.ts";

export interface NotesSaveState {
  saved: boolean;
  error: unknown;
  conflict: boolean;
}

export interface NotesSaveOptions {
  store?: Store;
  /** Must reject on any non-2xx and resolve only once the server holds the text; `base` is the If-Match. */
  send(board: string, text: string, keepalive: boolean, base: number | null): Promise<unknown>;
  failed(error: unknown): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(timer: unknown): void;
}

/** The board is gone (404, 410); not a 401, since dropping the text over one would lose it. */
const refusedForGood = (e: unknown): boolean => {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 404 || status === 410;
};
const revIn = (n: unknown): number | null => (typeof n === "number" ? n : null);

interface Owed { text: string; base: number | null }

export class NotesSave {
  private board: string | null = null;
  private text = "";
  /** what the server is known to hold for `board`; null while a save's lost answer leaves it unknown */
  private savedText: string | null = "";
  private base: number | null = null; // the revision the box's text was written over (If-Match)
  private inflight: { board: string; text: string; keepalive: boolean } | null = null;
  private readonly left = new Map<string, Owed>();
  private leftHeld = false;          // a left board's save just failed: no retry until asked
  private timer: unknown = null;
  private keepaliveNext = false;     // the tab went hidden: what follows goes keepalive too
  private error: unknown = null;
  private said = false;              // this run of failures has been said
  private snapshot: NotesSaveState = { saved: true, error: null, conflict: false };
  private owing = false;             // owes(), as last told to the listeners
  private theirs: string | null = null;
  /** A sent save whose answer never came; a 409 whose "theirs" is exactly this text is our own save. */
  private readonly unanswered = new Map<string, Owed>();
  private theirsRev: number | null = null;
  private readonly conflicted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly o: Required<NotesSaveOptions>;
  /** seeded from a saved offline copy: not to be written over until reseeded from the wire */
  stale = false;

  constructor(o: NotesSaveOptions) {
    this.o = {
      store: roomStore,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...o,
    };
  }

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = (): NotesSaveState => this.snapshot;

  /** A board's log arrived; returns the text the box should hold (typing not yet landed wins). */
  seed(board: string, text: string, opts: { stale?: boolean; rev?: number; epoch?: string } = {}): string {
    let rev = revIn(opts.rev);
    const heard = this.heard(board);
    if (heard && rev !== null && rev < heard.base.notesRev && (opts.epoch ?? heard.epoch) === heard.epoch) ({ text, notesRev: rev } = heard.base);
    const known = this.lostSave(board) ? null : text;
    if (this.board === board && this.unsaved()) {
      // a live answer lifts a saved copy's seal; the draft keeps its base, so a change elsewhere is refused
      if (!opts.stale) { this.stale = false; this.savedText = known; if (this.theirs !== null) { this.theirs = text; this.theirsRev = rev; } }
      this.flush();
      return this.text;
    }
    if (this.board && this.board !== board && this.unsaved()) {
      this.left.set(this.board, { text: this.text, base: this.base });
      if (this.theirs !== null) this.conflicted.add(this.board);
    }
    this.clear();
    const owed = this.left.get(board);
    this.left.delete(board);
    this.theirs = owed && this.conflicted.has(board) ? text : null;
    this.theirsRev = rev;
    this.conflicted.delete(board);
    this.board = board; this.savedText = known;
    this.text = owed ? owed.text : text;
    this.base = owed ? owed.base : rev;
    this.error = null; this.said = false;
    this.stale = !!opts.stale;
    this.run(false);
    this.publish();
    return this.text;
  }

  /** Typed: saved 700 ms after the typing stops. Never over a saved copy. */
  edit(text: string): void {
    if (!this.board || this.stale) return;
    this.text = text;
    this.clear();
    this.timer = this.o.setTimer(() => { this.timer = null; this.flush(); }, 700);
    this.publish();
  }

  flush(): void {
    this.clear();
    this.run(false);
    this.publish();
  }

  keepMine(): void {
    if (this.theirs === null) return;
    this.theirs = null;
    this.base = this.theirsRev;
    this.error = null; this.said = false;
    this.flush();
  }

  useTheirs(): string {
    if (this.theirs === null) return this.text;
    this.clear();
    this.text = this.savedText = this.theirs;
    this.base = this.theirsRev;
    this.theirs = null;
    this.error = null; this.said = false;
    this.publish();
    return this.text;
  }

  /** Unloading, a non-keepalive request dies with the page, so everything owed goes now, side by side. */
  leave(unloading: boolean): void {
    this.clear();
    this.keepaliveNext = true;
    if (!unloading) { this.run(true); this.publish(); return; }
    const going = this.inflight;
    const carried = (board: string, text: string) => !!going && going.keepalive && going.board === board && going.text === text;
    const owed: [string, Owed][] = [];
    if (this.board && this.theirs === null && this.unsaved()) owed.push([this.board, { text: this.text, base: this.base }]);
    for (const [board, o] of this.left) if (!this.conflicted.has(board)) owed.push([board, o]);
    for (const [board, o] of owed) if (!carried(board, o.text)) this.go(board, o, true).finally(() => this.publish());
  }

  /** Text the page going away would lose: a failed save, one held under a conflict, or a left board's. */
  owes(): boolean {
    return (this.error !== null && this.unsaved()) || this.theirs !== null || this.left.size > 0;
  }

  private unsaved(): boolean {
    if (!this.board) return false;
    const going = this.inflight && this.inflight.board === this.board ? this.inflight.text : null;
    return this.timer !== null || this.text !== this.savedText || (going !== null && going !== this.text);
  }
  private clear(): void { if (this.timer !== null) { this.o.clearTimer(this.timer); this.timer = null; } }
  private heard(board: string): (Entry<NotesEntity> & { base: NotesEntity }) | undefined {
    const e = this.o.store.entry<NotesEntity>(notesKey(board));
    return e?.base && e.origin === "wire" ? e as Entry<NotesEntity> & { base: NotesEntity } : undefined;
  }
  /** A save whose answer was lost and which may still be what the server holds. */
  private lostSave(board: string): Owed | undefined {
    const lost = this.unanswered.get(board), heard = this.heard(board)?.base.notesRev;
    return lost && (lost.base === null || heard === undefined || heard <= lost.base) ? lost : undefined;
  }
  private go(board: string, o: Owed, keepalive: boolean): Promise<unknown> {
    return new Promise((sent) => sent(this.o.send(board, o.text, keepalive, o.base)))
      .then((res) => this.landed(board, o.text, res), (e) => this.missed(board, o, e));
  }

  /* A left board goes first (typed earlier); a save's own answer never retries what just failed (no loop). */
  private run(keepalive: boolean, settling = false): void {
    if (this.inflight) return;
    keepalive ||= this.keepaliveNext;
    const next = [...this.left].find(([board]) => !this.conflicted.has(board));
    if (next && !(settling && this.leftHeld)) {
      this.start(next[0], next[1], keepalive);
      return;
    }
    if (!this.board || this.theirs !== null || this.text === this.savedText || (settling && (this.timer !== null || this.error))) {
      if (this.timer === null) this.keepaliveNext = false;
      return;
    }
    this.start(this.board, { text: this.text, base: this.base }, keepalive);
  }

  private start(board: string, o: Owed, keepalive: boolean): void {
    const save = { board, text: o.text, keepalive };
    this.inflight = save;
    this.publish();
    this.go(board, o, keepalive).finally(() => {
      if (this.inflight === save) this.inflight = null;
      this.run(false, true);
      this.publish();
    });
  }

  private landed(board: string, text: string, res: unknown): void {
    const rev = revIn((res as { notesRev?: unknown } | null)?.notesRev);
    // a replayed answer is as of when the save landed: a revision heard since is newer
    const heard = this.heard(board)?.base, held = heard && rev !== null && heard.notesRev > rev ? heard.text : text;
    this.said = false;
    this.unanswered.delete(board);
    if (board === this.board) { this.savedText = held; this.base = rev; this.error = null; return; }
    // a left board's newer text was typed over this one: it is written over this revision now
    const o = this.left.get(board);
    if (o?.text === held) this.left.delete(board); else if (o) this.left.set(board, { text: o.text, base: rev });
    this.leftHeld = false;
  }

  /* A failure on a left board stays owed to it, unless refused for good (there is nowhere to put it). */
  private missed(board: string, o: Owed, e: unknown): void {
    const conflict = (e as { conflict?: { rev?: unknown; value?: { text?: unknown } } } | null)?.conflict;
    const theirs = String(conflict?.value?.text ?? ""), rev = revIn(conflict?.rev);
    // a lost save may have landed, so its own text can come back as "theirs": nothing changed elsewhere
    if (conflict) {
      if (theirs === o.text || theirs === this.unanswered.get(board)?.text) { this.landed(board, theirs, { notesRev: rev }); return; }
    } else if (!refusedForGood(e)) {
      // the server holds the confirmed text or this one: nothing counts as saved until an answer says
      this.unanswered.set(board, o);
      if (board === this.board) this.savedText = this.lostSave(board) ? null : this.heard(board)!.base.text;
    }
    if (board === this.board) {
      this.error = e;
      // the store took the refusal in the log's order, so what it holds is the newest of the two
      if (conflict) {
        ({ text: this.theirs, notesRev: this.theirsRev } = this.heard(board)?.base ?? { text: theirs, notesRev: rev });
        this.savedText = this.theirs;
      }
    } else if (refusedForGood(e)) {
      if (this.left.get(board)?.text === o.text) this.left.delete(board);
      this.conflicted.delete(board);
      this.leftHeld = false;
      this.o.failed(e);
      return;
    } else {
      if (!this.left.has(board)) this.left.set(board, o);
      if (conflict) this.conflicted.add(board); else this.leftHeld = true;
    }
    if (!this.said) { this.said = true; this.o.failed(e); }
  }

  private publish(): void {
    const busy = !!this.inflight && this.inflight.board === this.board;
    const conflict = this.theirs !== null;
    const saved = !this.board || (this.text === this.savedText && this.timer === null && !busy && !conflict);
    const same = saved === this.snapshot.saved && this.error === this.snapshot.error && conflict === this.snapshot.conflict;
    const owes = this.owes();
    if (same && owes === this.owing) return;
    this.owing = owes;
    if (!same) this.snapshot = { saved, error: this.error, conflict };
    for (const fn of this.listeners) fn();
  }
}
