import { test } from "node:test";
import assert from "node:assert/strict";
import type { PendingOp, PendingState } from "../data/mutate.ts";
import { SLOW_MS, saveLine, saveWatch } from "./saving.ts";

const op = (state: PendingState, id: string = state): PendingOp => ({ id, label: "save", lanes: [], state, attempts: 0, error: null, key: id });

test("the line: quiet, saving, or how many failed", () => {
  assert.equal(saveLine([], false), "");
  assert.equal(saveLine([op("sending")], false), "", "a write on its way is not news until it is slow");
  assert.equal(saveLine([op("sending")], true), "saving");
  assert.equal(saveLine([op("retrying")], false), "saving", "a retry's gap is slow by definition");
  assert.equal(saveLine([op("failed", "a"), op("failed", "b"), op("queued")], true), "2", "a failure outranks saving");
});

test("the watch: speaks once a write is slow, stops when the registry empties", () => {
  let ops: PendingOp[] = [];
  const subs = new Set<() => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  const w = saveWatch({ pending: () => ops, subscribePending: (cb) => { subs.add(cb); return () => subs.delete(cb); } },
    { set: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clear: (t) => { timers.delete(t as number); } });
  const fire = () => { const [[id, t]] = [...timers]; timers.delete(id); t.fn(); };
  const seen: string[] = [];
  const off = w.watch(() => seen.push(w.read()));
  const change = (next: PendingOp[]) => { ops = next; for (const cb of subs) cb(); };

  change([op("sending")]);
  assert.equal(w.read(), "", "a fresh write is quiet");
  assert.deepEqual(seen, [], "and the chip is not even told: the word did not change");
  assert.deepEqual([...timers.values()].map((t) => t.ms), [SLOW_MS]);
  change([op("sending"), op("queued")]);
  assert.equal(timers.size, 1, "one clock for the whole registry");
  fire();
  assert.equal(w.read(), "saving", "past SLOW_MS it says so");
  change([op("sending"), op("queued"), op("queued", "q2")]);
  change([op("retrying")]);
  assert.deepEqual(seen, ["saving"], "more writes while it already says saving: not news");
  change([]);
  assert.equal(w.read(), "", "landed: quiet again");
  change([op("failed")]);
  assert.equal(w.read(), "1");
  assert.equal(timers.size, 0, "a failed write is not waited on");
  change([op("failed"), op("failed", "f2")]);
  off();
  assert.equal(subs.size, 0);
  assert.deepEqual(seen, ["saving", "", "1", "2"], "told exactly when the word changed");
  assert.ok(seen.every((s, i) => i === 0 || s !== seen[i - 1]), "never the same word twice running");
});
