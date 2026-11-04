import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { blobCache } from "./blob-cache.ts";

const read = async (stream: Readable | null) => {
  assert.ok(stream);
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString();
};
const settle = async (dir: string, name: string) => {
  for (const end = Date.now() + 30_000; !readdirSync(dir).includes(name) && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
};

test("bytes kept once are served from the file, whole or as any range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-blobs-"));
  try {
    const cache = blobCache(join(dir, "blob-cache"));
    assert.equal(cache.open("res-1", 10, 0, 9), null, "nothing cached yet");
    cache.keep("res-1", new TextEncoder().encode("0123456789"));
    await settle(cache.dir, "res-1");
    assert.equal(await read(cache.open("res-1", 10, 0, 9)), "0123456789");
    assert.equal(await read(cache.open("res-1", 10, 3, 5)), "345");
    assert.deepEqual(readdirSync(cache.dir), ["res-1"], "no temp file is left behind");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a file of the wrong size is never trusted, and unsafe ids are never paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-blobs-"));
  try {
    const cache = blobCache(dir);
    writeFileSync(join(dir, "res-2"), "0123");            // a truncated write
    assert.equal(cache.open("res-2", 10, 0, 9), null);
    assert.equal(cache.open("../etc/passwd", 4, 0, 3), null);
    cache.keep("../escape", new Uint8Array([1]));
    assert.deepEqual(readdirSync(dir).sort(), ["res-2"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sweeping removes files whose source is gone; forgetting removes one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-blobs-"));
  try {
    const cache = blobCache(dir);
    for (const id of ["keep", "gone", "drop"]) writeFileSync(join(dir, id), "x");
    writeFileSync(join(dir, "old.123.tmp"), "x");          // an interrupted write
    assert.equal(cache.sweep((rid) => rid !== "gone"), 2);
    cache.forget("drop");
    assert.deepEqual(readdirSync(dir), ["keep"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
