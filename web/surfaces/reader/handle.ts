import { useSyncExternalStore } from "react";
import { initialSplit } from "./split.ts";
import type { useDrill } from "./useDrill.ts";

type Drill = ReturnType<typeof useDrill>;
type Verb = { [K in keyof Drill]: Drill[K] extends (...a: never[]) => unknown ? K : never }[keyof Drill];
type Call = (...a: unknown[]) => unknown;

let bound: Drill | null = null;
let mounted = false;
const waiting: Array<() => void> = [];

export function bindDrill(d: Drill): void { bound = d; }
export function drillMounted(): void {
  mounted = true;
  for (const run of waiting.splice(0)) run();
}
export const drillNow = (): Drill | null => (mounted ? bound : null);

const verbs: Record<string, Call> = {};
const run = (k: string, a: unknown[]) => (bound as unknown as Record<string, Call>)[k](...a);
export const drill = new Proxy({} as Pick<Drill, Verb>, {
  get: (_, k: string) => verbs[k] ??= (...a: unknown[]) => mounted
    ? run(k, a)
    : new Promise((done) => { waiting.push(() => done(run(k, a))); }),
});

export interface Shown {
  solo: boolean;
  soloLine: string | null;
  splitW: number;
}
let shown: Shown | null = null;
const now = (): Shown => shown ??= { solo: false, soloLine: null, splitW: initialSplit() };
const heard = new Set<() => void>();
const subscribe = (cb: () => void) => { heard.add(cb); return () => { heard.delete(cb); }; };
export function publishShown(next: Shown): void {
  const was = now();
  if (was.solo === next.solo && was.soloLine === next.soloLine && was.splitW === next.splitW) return;
  shown = next;
  for (const cb of [...heard]) cb();
}
export function useShown<K extends keyof Shown>(k: K): Shown[K] {
  const read = () => now()[k];
  return useSyncExternalStore(subscribe, read, read);
}

export interface ReaderHand {
  card: any;
  done: boolean;
  revealed: boolean;
  editing: unknown;
  cardsOnly: boolean;
  solo: boolean;
  qDeck: unknown;
  treeOpen: boolean;
  openMark: unknown;
  find: unknown;
}
let hand = {} as ReaderHand;
export function holdReaderHand(next: ReaderHand): void { hand = next; }
export const readerNow = (): ReaderHand => hand;
