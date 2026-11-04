import type { ImportStatus } from '../../../shared/imports/import-status.ts';

// awaiting_groups waits on the reader and error on a retry, so neither is polled closely
const MOVING = new Set<ImportStatus['stage']>(['uploading','stored','extracting','sizing','queued','finalizing']);

export const importsMoving = (jobs: ImportStatus[], local: { retryAt: number }[]): boolean =>
  local.some(j=>j.retryAt!==Number.MAX_SAFE_INTEGER) || jobs.some(j=>MOVING.has(j.stage) || !!j.generation?.busy);

// idle still looks (another device may start an import), backing off up to five minutes
export const IDLE_POLL_MS = 60_000;
export const IDLE_POLL_MAX_MS = 5 * 60_000;
export const importPollDelay = (moving: boolean, idleLooks = 0): number =>
  moving ? 4000 : Math.min(IDLE_POLL_MAX_MS, IDLE_POLL_MS * 2 ** Math.max(0, idleLooks - 1));
