import { useSyncExternalStore } from "react";
export interface ComposerDraft {
  front: string;
  answer: string;
  mintId: string | null;
  pairId: string | null;
  source: string;
  anchor: string | null;
  boardId?: string;
  unfiled?: boolean;
  requestId?: string;
  /** written in the fold under these words, not in the column */
  fold?: FoldPlace;
  /** the fold's draft once Format is pressed: being tidied, or tidied and waiting to be kept */
  tidy?: FoldTidy;
}
export interface FoldTidy { phase: "writing" | "formatting" | "formatted"; front: string; back: string; error: string }
export interface FoldPlace { resourceId: string; start: number; end: number; quote: string; page: number | null; rects: number[][]; box: string | null; block?: number | null }

let draft: ComposerDraft | null = null;
const heard = new Set<() => void>();

export const composerNow = (): ComposerDraft | null => draft;
export function setComposer(next: ComposerDraft | null | ((was: ComposerDraft | null) => ComposerDraft | null)): void {
  const value = typeof next === "function" ? next(draft) : next;
  if (value === draft) return;
  draft = value;
  for (const cb of [...heard]) cb();
}
export function subscribeComposer(cb: () => void): () => void {
  heard.add(cb);
  return () => { heard.delete(cb); };
}
export const useComposer = (): ComposerDraft | null => useSyncExternalStore(subscribeComposer, composerNow, composerNow);
