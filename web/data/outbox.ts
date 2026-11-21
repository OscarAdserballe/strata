import type { Outbox, SavedOp, Unsynced } from "./mutate.ts";

// Offline writes outlive the tab here: `ops` is what is still owed, `unsynced` what the server refused after.

const OPS = "ops", UNSYNCED = "unsynced";
const dbName = (): string => {
  const base = typeof window !== "undefined" && window.STRATA_BASE ? window.STRATA_BASE : "/";
  return `strata-outbox${base === "/" ? "" : ":" + base}`;
};

let opening: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(dbName(), 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(OPS, { keyPath: "key" });
        req.result.createObjectStore(UNSYNCED, { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }   // a private window may have no IndexedDB: offline writes then last the tab only
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  if (!d) return undefined;
  return new Promise((resolve) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = tx.onabort = () => resolve(undefined);
  });
}

let rows: Unsynced[] = [];
const listeners = new Set<() => void>();
function setRows(next: Unsynced[]): void {
  rows = next.sort((a, b) => a.at - b.at);
  for (const fn of [...listeners]) fn();
}

export const outbox: Outbox = {
  put: (op) => { void run(OPS, "readwrite", (s) => s.put(op)); },
  drop: (key) => { void run(OPS, "readwrite", (s) => s.delete(key)); },
  refused: (row) => {
    setRows([...rows.filter((r) => r.key !== row.key), row]);
    void run(UNSYNCED, "readwrite", (s) => s.put(row));
  },
};

/** What a closed tab left owed, oldest first. */
export async function owed(): Promise<SavedOp[]> {
  return ((await run<SavedOp[]>(OPS, "readonly", (s) => s.getAll())) ?? []).sort((a, b) => a.at - b.at);
}

export async function loadUnsynced(): Promise<void> {
  const saved = (await run<Unsynced[]>(UNSYNCED, "readonly", (s) => s.getAll())) ?? [];
  const keys = new Set(rows.map((r) => r.key));
  const fresh = saved.filter((r) => !keys.has(r.key));
  // a new array wakes the banner: an empty outbox at boot must not commit it
  if (fresh.length) setRows([...rows, ...fresh]);
}

export const unsynced = (): Unsynced[] => rows;
export function subscribeUnsynced(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function clearUnsynced(): void {
  setRows([]);
  void run(UNSYNCED, "readwrite", (s) => s.clear());
}

/** The list as plain text, for pasting to an agent or a note. */
export function unsyncedText(list: Unsynced[] = rows): string {
  const head = `${list.length} change${list.length === 1 ? "" : "s"} made offline that the server refused:`;
  return [head, ...list.map((r, i) => [
    `\n${i + 1}. ${r.label} · ${new Date(r.at).toISOString()}`,
    `   ${r.method} ${r.path}${r.status ? ` → ${r.status}` : ""}: ${r.said}`,
    r.body === undefined ? null : `   sent: ${r.body}`,
    r.server === undefined ? null : `   server has: ${JSON.stringify(r.server)}`,
  ].filter(Boolean).join("\n"))].join("\n");
}
