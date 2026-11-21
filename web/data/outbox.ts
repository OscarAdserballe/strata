import type { Outbox, OutboxRecord } from "./mutate.ts";

// Writes made offline are kept in IndexedDB until they land, so a reload in the air doesn't lose them; one store per room.

const DB = "strata-outbox", STORE = "records";
let opened: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("browser storage is blocked"));
  });
}

function run(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<unknown> {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onabort = () => reject(tx.error ?? new Error("browser storage is full"));
    tx.onerror = () => reject(tx.error ?? new Error("browser storage is unavailable"));
  }));
}

export function deviceOutbox(room: string): Outbox {
  const key = (id: string) => `${room}\n${id}`;
  const quiet = (p: Promise<unknown>) => { p.catch((e) => console.error("[strata] outbox", e)); };
  return {
    put: (rec) => quiet(run("readwrite", (s) => s.put(rec, key(rec.id)))),
    drop: (id) => quiet(run("readwrite", (s) => s.delete(key(id)))),
    list: async () => {
      if (typeof indexedDB === "undefined") return [];
      const range = IDBKeyRange.bound(`${room}\n`, `${room}\n￿`);
      return (await run("readonly", (s) => s.getAll(range))) as OutboxRecord[];
    },
  };
}
