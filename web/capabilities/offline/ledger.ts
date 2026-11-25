import { useSyncExternalStore } from "react";
import { StrataWireDown } from "../../data/api.ts";

// What a Download of each board left on this device: when, which sources, and every URL it could not save.
// The download button, the source list and the banner read it, so a gap shows where it is.

export interface Missed { url: string; why: string }
export interface Ledger { at: number; title: string; resources: string[]; missed: Missed[]; bytes: number | null; kept: boolean | null }

const KEY = "strata.offline.ledger.";
const OLD = "strata.offline.";
const heard = new Set<() => void>();
const cache = new Map<string, Ledger | null>();

function load(board: string): Ledger | null {
  try {
    const raw = localStorage.getItem(KEY + board);
    if (raw) return JSON.parse(raw) as Ledger;
    // a download from before the ledger: its date only, so what it holds is unknown
    const at = Number(localStorage.getItem(OLD + board)) || 0;
    return at ? { at, title: "", resources: [], missed: [], bytes: null, kept: null } : null;
  } catch { return null; }
}

export function ledgerOf(board: string | null): Ledger | null {
  if (!board) return null;
  if (!cache.has(board)) cache.set(board, load(board));
  return cache.get(board) ?? null;
}

export function writeLedger(board: string, ledger: Ledger): void {
  cache.set(board, ledger);
  try {
    localStorage.setItem(KEY + board, JSON.stringify(ledger));
    localStorage.setItem(OLD + board, String(ledger.at));
  } catch { /* private window or full: this tab still knows */ }
  for (const fn of [...heard]) fn();
}

const subscribe = (fn: () => void) => { heard.add(fn); return () => { heard.delete(fn); }; };
export const useLedger = (board: string | null): Ledger | null => useSyncExternalStore(subscribe, () => ledgerOf(board), () => ledgerOf(board));

/** Whether this device holds a source of this board: true, false, or null when no download says. */
export function offlineHas(board: string | null, rid: string): boolean | null {
  const l = ledgerOf(board);
  if (!l || !l.resources.length) return null;
  return l.resources.includes(rid) && !l.missed.some((m) => m.url.includes(`/resources/${rid}/raw`) || m.url.includes(`/resources/${rid}/live`));
}

/** The board's sources a download has not saved yet. */
export const notSaved = (l: Ledger | null, resources: { id: string }[]): number =>
  l && l.resources.length ? resources.filter((r) => !l.resources.includes(r.id)).length : 0;

// every API answer announces the connection; the boolean only changes when the wire does, so this re-renders rarely
const onConnection = (fn: () => void) => { window.addEventListener("strata:connection", fn); return () => window.removeEventListener("strata:connection", fn); };
/** Whether the room calls the wire down now. */
export const useWireDown = (): boolean => useSyncExternalStore(onConnection, StrataWireDown, () => false);
