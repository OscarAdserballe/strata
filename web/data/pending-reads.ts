/** Share concurrent reads only. Completed values are never reused as a stale cache. */
export class PendingReads {
  private reads = new Map<string,Promise<unknown>>();
  run<T>(key: string, read: () => Promise<T>): Promise<T> {
    const existing = this.reads.get(key);
    if (existing) return existing as Promise<T>;
    const clear = () => { if (this.reads.get(key) === pending) this.reads.delete(key); };
    const pending = read().then(value=>{clear();return value;},error=>{clear();throw error;});
    this.reads.set(key,pending);
    return pending;
  }
  invalidate(): void { this.reads.clear(); }
}

/** Prefetched answers, each handed to the next read once while young; clear() on any write drops them all. */
export class WarmReads {
  private kept = new Map<string,{at:number;value:Promise<unknown>}>();
  private maxAgeMs: number;
  private now: () => number;
  constructor(maxAgeMs: number, now: () => number = Date.now) { this.maxAgeMs = maxAgeMs; this.now = now; }
  start<T>(key: string, read: () => Promise<T>): Promise<T> {
    const had = this.kept.get(key);
    if (had && this.now() - had.at < this.maxAgeMs) return had.value as Promise<T>;
    const value = read();
    value.catch(() => { if (this.kept.get(key)?.value === value) this.kept.delete(key); });
    this.kept.set(key,{at:this.now(),value});
    return value;
  }
  take<T>(key: string): Promise<T> | undefined {
    const had = this.kept.get(key);
    if (!had) return undefined;
    this.kept.delete(key);
    return this.now() - had.at < this.maxAgeMs ? had.value as Promise<T> : undefined;
  }
  clear(): void { this.kept.clear(); }
}
