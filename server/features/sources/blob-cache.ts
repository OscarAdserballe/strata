// A cache, never the record: only a PDF's bytes are served from it, and a PDF's bytes never change.

import { createReadStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFile } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";

const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const writing = new Set<string>();

export function blobCache(dir: string) {
  const fileOf = (rid: string): string | null => SAFE_ID.test(rid) ? join(dir, rid) : null;
  return {
    dir,
    open(rid: string, len: number, start: number, end: number): Readable | null {
      const file = fileOf(rid);
      if (!file) return null;
      try { if (statSync(file).size !== len) return null; } catch { return null; }
      return createReadStream(file, { start, end, highWaterMark: 256 * 1024 });
    },
    /** Written aside and renamed, so a half-written file never exists under the real name. */
    keep(rid: string, bytes: Uint8Array): void {
      const file = fileOf(rid);
      if (!file || writing.has(file)) return;
      writing.add(file);
      try { mkdirSync(dir, { recursive: true }); } catch { writing.delete(file); return; }
      const tmp = `${file}.${process.pid}.tmp`;
      writeFile(tmp, bytes, (error) => {
        try { if (!error) renameSync(tmp, file); else unlinkSync(tmp); } catch { /* next read tries again */ }
        writing.delete(file);
      });
    },
    forget(rid: string): void {
      const file = fileOf(rid);
      if (file) try { unlinkSync(file); } catch { /* was never cached */ }
    },
    sweep(exists: (rid: string) => boolean): number {
      let removed = 0;
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return 0; }
      for (const name of names) {
        const stale = name.endsWith(".tmp") ? !writing.has(join(dir, name.replace(/\.\d+\.tmp$/, ""))) : !exists(name);
        if (stale) { try { unlinkSync(join(dir, name)); removed++; } catch { /* in use; next sweep */ } }
      }
      return removed;
    },
  };
}

export const blobCacheBeside = (dbPath: string) => blobCache(join(dirname(dbPath), "blob-cache"));
