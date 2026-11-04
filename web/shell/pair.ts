import { useLayoutEffect, useState } from "react";
import { boardNow } from "../surfaces/board/handle.ts";
import { navigate, navigation } from "./routes.ts";

// Held by id, not index: a store snapshot may drop or reorder pairs before the verb's answer arrives.

export interface HeldPairAt { i: number; id: string | null }

const HOME_HELD: HeldPairAt = { i: 0, id: null };
let held: HeldPairAt = HOME_HELD;
let heard: ((h: HeldPairAt) => void) | null = null;

export const pairNow = (): number => held.i;
/** What a snapshot that redrew the pairs is checked against; its index may already be another pair's. */
export const pairIdNow = (): string | null => held.id;

export function holdPair(i: number, id: string | null): void {
  held = i > 0 && id ? { i, id } : HOME_HELD;
  heard?.(held);
}

export function choosePair(i: number): void {
  const { activeId, pairs } = boardNow(), p = pairs?.[i];
  if (!activeId || !navigation.accepts(activeId, activeId)) return;
  if (navigation.owns(activeId)) navigate({ kind: "board", board: activeId, ...(p && !p.isHome ? { resource: p.resourceId || undefined, pair: p.id } : {}) });
  holdPair(i, p && !p.isHome ? p.id : null);
}

export function pairIndex(pairs: ReadonlyArray<{ id?: string | null } | null | undefined>, h: HeldPairAt): number {
  if (!h.id || h.i <= 0) return 0;
  if (pairs[h.i]?.id === h.id) return h.i;
  const at = pairs.findIndex((p, k) => k > 0 && p?.id === h.id);
  return at > 0 ? at : 0;
}

export function usePairInHand(): HeldPairAt {
  const [h, hear] = useState(held);
  useLayoutEffect(() => { heard = hear; hear(held); return () => { heard = null; }; }, []);
  return h;
}
