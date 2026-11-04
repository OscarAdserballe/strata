import { test } from "node:test";
import assert from "node:assert/strict";
import type { ImportStatus } from "../../../shared/imports/import-status.ts";
import { createImportWatch } from "./import-watch.ts";
import { IDLE_POLL_MS } from "./import-poll.ts";
import type { LocalImport } from "./imports.ts";

const job = (id: string, stage: ImportStatus["stage"], resource_id: string | null = null): ImportStatus => ({
  id, board_id: "b", filename: "f.pdf", size: 1, received: 1, stage, error: null, page: 0, pages: 0, resource_id, updated_at: 0,
});

function rig(answers: ImportStatus[][] = [[]]) {
  let clock = 0;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const visibility = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => { visibility.add(fn); },
    removeEventListener: (_: string, fn: () => void) => { visibility.delete(fn); },
  };
  let requests = 0;
  const invalidated: string[][] = [];
  let answer = 0;
  let localJobs: LocalImport[] = [];
  const localSubs = new Set<() => void>();
  const w = createImportWatch({
    list: async () => { requests++; return { imports: answers[Math.min(answer++, answers.length - 1)] }; },
    local: () => localJobs,
    subscribeLocal: (fn) => { localSubs.add(fn); return () => { localSubs.delete(fn); }; },
    invalidate: (tags) => { invalidated.push(tags); },
    doc: doc as unknown as Document,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
    now: () => clock,
  });
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms: number) => {
    const end = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock = due[1].at;
      due[1].fn();
      await settle();
    }
    clock = end;
  };
  const setHidden = (h: boolean) => { doc.hidden = h; for (const fn of [...visibility]) fn(); };
  const changeLocal = (jobs: LocalImport[]) => { localJobs = jobs; for (const fn of [...localSubs]) fn(); };
  return { w, advance, settle, setHidden, changeLocal, requests: () => requests, invalidated, timers };
}

test("two screens showing imports share one poll", async () => {
  const r = rig();
  const a = r.w.watch(() => {});
  const b = r.w.watch(() => {});
  await r.advance(0);
  assert.equal(r.requests(), 1, "one look for both");
  await r.advance(IDLE_POLL_MS);
  assert.equal(r.requests(), 2, "and one per interval, not one per screen");
  a(); b();
});

test("with no screen showing imports, or the tab hidden, nothing is asked", async () => {
  const r = rig();
  await r.advance(10 * IDLE_POLL_MS);
  assert.equal(r.requests(), 0, "nothing subscribed: no poll");
  const off = r.w.watch(() => {});
  await r.advance(0);
  assert.equal(r.requests(), 1);
  r.setHidden(true);
  await r.advance(10 * IDLE_POLL_MS);
  assert.equal(r.requests(), 1, "hidden: no look");
  r.setHidden(false);
  await r.advance(0);
  assert.equal(r.requests(), 2, "shown again: one look at once");
  off();
  await r.advance(10 * IDLE_POLL_MS);
  assert.equal(r.requests(), 2, "unsubscribed: the poll stops");
  assert.equal(r.timers.size, 0);
});

test("an answer that says the same thing tells nobody", async () => {
  const same = [job("i1", "awaiting_groups")];
  const r = rig([same, same, same]);
  let told = 0;
  const off = r.w.watch(() => { told++; });
  await r.advance(0);
  assert.equal(told, 1, "the first answer is news");
  await r.advance(IDLE_POLL_MS);
  await r.advance(2 * IDLE_POLL_MS);
  assert.equal(r.requests(), 3);
  assert.equal(told, 1, "the same answer again re-renders no one");
  off();
});

test("a source landing makes the register and board list stale once, and says so to the room", async () => {
  const r = rig([[job("i1", "extracting")], [job("i1", "imported", "r1")], [job("i1", "imported", "r1")]]);
  let landed = 0;
  const offLanded = r.w.onLanded(() => { landed++; });
  const off = r.w.watch(() => {});
  await r.advance(0);
  assert.deepEqual(r.invalidated, [], "the first look is what was there already");
  await r.advance(4000);
  assert.deepEqual(r.invalidated, [["register", "boards"]]);
  assert.equal(landed, 1);
  await r.advance(IDLE_POLL_MS);
  assert.equal(r.requests(), 3);
  assert.equal(r.invalidated.length, 1, "seen again, not stale again");
  assert.equal(landed, 1);
  off(); offLanded();
});

test("a screen handing the watch to the next does not look again at once, nor reset the backoff", async () => {
  const r = rig();
  let off = r.w.watch(() => {});
  await r.advance(0);
  await r.advance(IDLE_POLL_MS);
  assert.equal(r.requests(), 2, "idle twice: the next wait is two minutes");
  await r.advance(30_000);
  off();
  off = r.w.watch(() => {});
  await r.settle();
  assert.equal(r.requests(), 2, "no look on the click's path");
  await r.advance(2 * IDLE_POLL_MS - 30_000 - 1);
  assert.equal(r.requests(), 2, "the two-minute wait is waited out, not restarted at one");
  await r.advance(1);
  assert.equal(r.requests(), 3);
  off();
});

const upload: LocalImport = { id: "u1", board: "b", filename: "notes.txt", size: 1, attempts: 0, retryAt: 0 };

test("a screen taking the watch over inside an upload's 250 ms looks within them", async () => {
  const r = rig();
  let off = r.w.watch(() => {});
  await r.advance(0);
  await r.advance(1000);
  const before = r.requests();
  r.changeLocal([upload]);
  await r.advance(100);
  off();
  off = r.w.watch(() => {});
  await r.advance(150);
  assert.equal(r.requests(), before + 1, "the look the upload asked for, on time");
  off();
});

test("a local change made while no screen watched is looked at when one does", async () => {
  const r = rig();
  let off = r.w.watch(() => {});
  await r.advance(0);
  off();
  r.changeLocal([upload]);
  const before = r.requests();
  off = r.w.watch(() => {});
  await r.advance(0);
  assert.equal(r.requests(), before + 1, "looked at once, not at the end of the idle wait");
  off();
});
