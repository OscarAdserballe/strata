import { ImportAPI, localImports, subscribeImports, type LocalImport } from './imports.ts';
import { importsMoving, importPollDelay } from './import-poll.ts';
import type { ImportStatus } from '../../../shared/imports/import-status.ts';
import { store } from '../../data/store.ts';
import { BOARDS, REGISTER } from '../../data/entities/sources.ts';

export interface ImportsSnapshot { jobs: ImportStatus[]; local: LocalImport[]; error: string }

export interface ImportWatchDeps {
  list: () => Promise<{ imports: ImportStatus[] }>;
  local: () => LocalImport[];
  subscribeLocal: (fn: () => void) => () => void;
  invalidate: (tags: string[]) => void;
  doc?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

export function createImportWatch(d: ImportWatchDeps) {
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const now = d.now ?? (() => Date.now());
  let snap: ImportsSnapshot = { jobs: [], local: [], error: '' };
  const listeners = new Set<() => void>();
  const landedListeners = new Set<() => void>();
  let users = 0;
  let running = false;
  let timer: unknown;
  // nothing seen yet, so a first look that finds nothing tells no one
  let seen = '[]', seenLocal = '[]', signature = '';
  let moving = false;
  let idleLooks = 0;
  // a screen taking the watch over waits out the rest of the last wait instead of looking at once
  let lastLookAt = -Infinity;
  let wait = 0;
  let offLocal: (() => void) | null = null;

  const hidden = () => !!d.doc?.hidden;
  function set(next: Partial<ImportsSnapshot>): void {
    snap = { ...snap, ...next };
    for (const fn of [...listeners]) fn();
  }
  function readLocal(): LocalImport[] {
    const next = d.local();
    const key = JSON.stringify(next);
    if (key !== seenLocal) { seenLocal = key; set({ local: next }); }
    return next;
  }
  function stop(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }
  function later(ms: number): void {
    stop();
    if (users && !hidden()) timer = setTimer(() => { timer = undefined; void look(); }, ms);
  }
  async function look(): Promise<void> {
    if (!users || running) return;
    running = true;
    try {
      const result = await d.list();
      const key = JSON.stringify(result.imports);
      // an upload's "interrupted" notice depends on the clock, so it is redrawn regardless
      if (key !== seen || result.imports.some((j) => j.stage === 'uploading')) { seen = key; set({ jobs: result.imports }); }
      if (snap.error) set({ error: '' });
      moving = importsMoving(result.imports, readLocal());
      idleLooks = moving ? 0 : idleLooks + 1;
      // the import id is in it: a revision lands on a source that already had one
      const next = JSON.stringify(result.imports.filter((j) => j.resource_id).map((j) => [j.id, j.resource_id, j.generation]));
      if (next !== signature) {
        const first = !signature;
        signature = next;
        if (!first) {
          d.invalidate([REGISTER, BOARDS]);
          for (const fn of [...landedListeners]) fn();
        }
      }
    } catch (e) {
      const error = `Cannot check imports: ${(e as Error).message}. Reconnecting…`;
      if (snap.error !== error) set({ error });
    } finally {
      running = false;
      lastLookAt = now();
      wait = importPollDelay(moving, idleLooks);
      later(wait);
    }
  }
  function shown(): void {
    if (hidden()) stop();
    else { idleLooks = 0; later(0); }
  }

  return {
    watch(listener: () => void): () => void {
      listeners.add(listener);
      if (users++ === 0) {
        // the short wait carries across a handover, or the new screen shows the upload a minute late
        offLocal = d.subscribeLocal(() => { if (users) { readLocal(); idleLooks = 0; wait = 250; lastLookAt = now(); later(250); } });
        d.doc?.addEventListener('visibilitychange', shown);
        // a local change made while no screen watched (nobody was subscribed to hear it)
        const missed = JSON.stringify(d.local()) !== seenLocal;
        if (missed) { readLocal(); idleLooks = 0; }
        if (!running) later(missed ? 0 : Math.max(0, wait - (now() - lastLookAt)));
      }
      return () => {
        listeners.delete(listener);
        if (--users === 0) {
          stop();
          offLocal?.(); offLocal = null;
          d.doc?.removeEventListener('visibilitychange', shown);
        }
      };
    },
    now: (): ImportsSnapshot => snap,
    lookAgain(): void { idleLooks = 0; void look(); },
    onLanded(fn: () => void): () => void {
      landedListeners.add(fn);
      return () => { landedListeners.delete(fn); };
    },
  };
}

const room = createImportWatch({
  list: () => ImportAPI.list(),
  local: localImports,
  subscribeLocal: subscribeImports,
  invalidate: (tags) => store.invalidate(tags),
  doc: typeof document !== 'undefined' ? document : null,
});

export const watchImports = room.watch;
export const importsNow = room.now;
export const lookAgain = room.lookAgain;
export const onImportsLanded = room.onLanded;
