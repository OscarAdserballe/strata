import { useEffect } from "react";
import type { BoardListEntry, RegisterResponse } from "../../../shared/types/index.ts";
import { store as roomStore, useEntry, useQuery, type Fetcher, type Store } from "../store.ts";
import { fetched } from "../api.ts";
import { BOARDS, REGISTER } from "./sources.ts";

// The first read of each list is a boot read: the worker may answer it from its snapshot.
let registerBoot = true, boardsBoot = true;
const registerRead: Fetcher<RegisterResponse> = () => { const boot = registerBoot; registerBoot = false; return fetched<RegisterResponse>("/api/register", undefined, { boot }); };
const boardsRead: Fetcher<BoardListEntry[]> = () => {
  const boot = boardsBoot; boardsBoot = false;
  return fetched<{ boards: BoardListEntry[] }>("/api/boards", undefined, { boot }).then((f) => ({ ...f, value: f.value?.boards ?? [] }));
};

/** start a query's read with nothing watching it yet; resolves when it has landed (or failed) */
function prime<T>(key: string, read: Fetcher<T>, s: Store): Promise<void> {
  const held = !!s.entry(key)?.held;
  const off = s.watch(key, () => {}, read as Fetcher<unknown>, [key]);
  const landed = held ? Promise.resolve() : s.refetch(key);   // the read watch() just started
  off();
  return landed;
}

/** Boot's register read, not yet drawn: the first screen takes it instead of asking again. */
let bootRead = false;
export const primeRegister = (s: Store = roomStore) => { bootRead = true; return prime(REGISTER, registerRead, s); };
export const primeBoards = (s: Store = roomStore) => prime(BOARDS, boardsRead, s);

function refresh(key: string, ms: number, s: Store): void {
  const held = s.entry(key);
  if (held?.held && Date.now() - held.at >= ms) s.invalidate([key]);
}
export const refreshRegister = (ms = 0, s: Store = roomStore) => refresh(REGISTER, ms, s);
export const refreshBoards = (ms = 0, s: Store = roomStore) => refresh(BOARDS, ms, s);

// Screens reread the register on open (rows move without writes of ours), except the first after boot.
const BOOT_FRESH_MS = 10_000;
export function useRegister(again: readonly unknown[] | null = []): { register: RegisterResponse | null; error: unknown } {
  const register = useQuery<RegisterResponse>(REGISTER, registerRead, { tags: [REGISTER] }) ?? null;
  const entry = useEntry<RegisterResponse>(REGISTER);
  useEffect(() => {
    if (again === null) return;
    const held = roomStore.entry(REGISTER);
    const boots = bootRead && (!held?.held || Date.now() - held.at < BOOT_FRESH_MS);
    bootRead = false;
    if (!boots) refreshRegister();
  }, again ?? []);
  return { register, error: entry?.held ? null : entry?.error ?? null };
}

const NO_BOARDS: BoardListEntry[] = [];
export function useBoardList(): BoardListEntry[] {
  return useQuery<BoardListEntry[]>(BOARDS, boardsRead, { tags: [BOARDS] }) ?? NO_BOARDS;
}
