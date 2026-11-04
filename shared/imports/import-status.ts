export const importTransitions = {
  uploading: ['stored', 'cancelled'],
  stored: ['extracting', 'error', 'cancelled'],
  extracting: ['stored', 'sizing', 'error', 'cancelled'],
  sizing: ['awaiting_groups', 'queued', 'error', 'cancelled'],
  awaiting_groups: ['queued', 'cancelled'],
  queued: ['finalizing', 'error', 'cancelled'],
  finalizing: ['queued', 'imported', 'error', 'cancelled'],
  error: ['stored', 'sizing', 'queued', 'cancelled'],
  imported: [],
  cancelled: [],
} as const;
export type ImportStage = keyof typeof importTransitions;
export interface ImportStatus {
  id: string; board_id: string; filename: string; size: number; received: number;
  stage: ImportStage; error: string | null; page: number; pages: number;
  resource_id: string | null; updated_at: number;
  generation?: { ready: number; total: number; failed: number; busy: number; disabled: number; unstudied?: number; error: string | null };
}
