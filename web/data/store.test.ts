import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, sameData, type Fetched } from "./store.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function counter() {
  const c = { n: 0, fn: () => { c.n++; } };
  return c;
}

test("wire answers are ordered by rev: an older one arriving late is dropped, an equal one replaces", () => {
  const s = new Store();
  assert.equal(s.apply("board:b", 5, { title: "five" }, "wire"), true, "nothing held: taken");
  assert.equal(s.apply("board:b", 4, { title: "four, late" }, "wire"), false, "older: dropped");
  assert.deepEqual(s.get("board:b"), { title: "five" });
  assert.equal(s.apply("board:b", 5, { title: "five, soft fields refreshed" }, "wire"), true, "equal: replaces");
  assert.deepEqual(s.get("board:b"), { title: "five, soft fields refreshed" });
  assert.equal(s.apply("board:b", 9, { title: "nine" }, "wire"), true);
  assert.equal(s.entry("board:b")?.rev, 9);
});

test("the offline copy never replaces a wire answer, replaces another copy, and gives way to the wire", () => {
  const s = new Store();
  assert.equal(s.apply("register", 3, "shelf A", "shelf"), true, "nothing held: the copy is better than nothing");
  assert.equal(s.apply("register", 1, "shelf B", "shelf"), true, "a copy replaces a copy, whatever its rev");
  assert.equal(s.entry("register")?.origin, "shelf");
  assert.equal(s.apply("register", 0, "wire", "wire"), true, "the wire replaces a copy, even at a lower rev");
  assert.equal(s.apply("register", 99, "shelf C", "shelf"), false, "a copy never replaces the wire, even at a higher rev");
  assert.equal(s.apply("register", 99, "shelf D", "shelf", { epoch: "other" }), false, "…nor from another epoch");
  assert.equal(s.get("register"), "wire");
  assert.equal(s.entry("register")?.origin, "wire");
});

test("a new server epoch is accepted whatever its rev, and ordering restarts inside it", () => {
  const s = new Store();
  s.apply("board:b", 500, "before the restore", "wire", { epoch: "boot-1" });
  assert.equal(s.apply("board:b", 40, "after the restore", "wire", { epoch: "boot-2" }), true, "a restored backup moves revs backwards");
  assert.equal(s.entry("board:b")?.epoch, "boot-2");
  assert.equal(s.apply("board:b", 39, "older, same new epoch", "wire", { epoch: "boot-2" }), false);
  assert.equal(s.apply("board:b", 41, "newer", "wire", { epoch: "boot-2" }), true);
  assert.equal(s.get("board:b"), "newer");
});

test("optimistic layers fold over the base in op order; confirming one rebases the rest in one notification", () => {
  const s = new Store();
  s.apply<string[]>("marks:b", 1, ["a"], "wire");
  const seen = counter();
  s.subscribe("marks:b", seen.fn);
  // op 2 is applied first, op 1 second: the fold is still op 1 then op 2
  const drop2 = s.apply<string[]>("marks:b", null, (v) => [...v, "two"], "optimistic", { op: "op2", order: 2 });
  const drop1 = s.apply<string[]>("marks:b", null, (v) => [...v, "one"], "optimistic", { op: "op1", order: 1 });
  assert.deepEqual(s.get("marks:b"), ["a", "one", "two"]);
  assert.deepEqual(s.entry("marks:b")?.base, ["a"], "a layer never touches the base");
  assert.equal(seen.n, 2);
  // op 1 confirms: its answer is the new base, its layer goes — together
  s.batch(() => {
    s.apply<string[]>("marks:b", 2, ["a", "one (confirmed)", "z from another device"], "wire");
    drop1();
  });
  assert.equal(seen.n, 3, "one notification for the confirmed value and the layer's removal");
  assert.deepEqual(s.get("marks:b"), ["a", "one (confirmed)", "z from another device", "two"], "op 2 rebased onto the new base");
  drop2();
  drop2();   // a remover is safe to call twice
  assert.deepEqual(s.get("marks:b"), ["a", "one (confirmed)", "z from another device"], "rolled back: the base alone");
  s.apply("notes:b", null, { text: "draft" }, "optimistic", { op: "op3" });
  assert.deepEqual(s.get("notes:b"), { text: "draft" }, "a layer over nothing held");
});

test("a row patch folds into the held list and raises its rev to the larger; nothing held is left alone", () => {
  const s = new Store();
  assert.equal(s.patch<string[]>("marks:b", 7, (l) => [...l, "row"]), false, "no list to fold into");
  assert.equal(s.get("marks:b"), undefined);
  s.apply<string[]>("marks:b", 10, ["a"], "wire");
  assert.equal(s.patch<string[]>("marks:b", 7, (l) => [...l, "b"]), true, "a row is newer than its list, whatever the rev");
  assert.deepEqual(s.get("marks:b"), ["a", "b"]);
  assert.equal(s.entry("marks:b")?.rev, 10, "max(held, rev)");
  s.patch<string[]>("marks:b", 12, (l) => [...l, "c"]);
  assert.equal(s.entry("marks:b")?.rev, 12);
  assert.equal(s.apply("marks:b", 11, ["stale snapshot"], "wire"), false, "a snapshot older than the patched row is dropped");
});

test("a refused write's document is folded in the key's order within its epoch: older than what is held, dropped", () => {
  const s = new Store();
  // the plan as a board read at rev 13 holds it (its own rev 12); a refusal decided at rev 11, heard late
  s.apply("plan:b", 13, { purpose: "newer", rev: 12 }, "wire", { epoch: "boot-1" });
  assert.equal(s.patch("plan:b", 11, () => ({ purpose: "refused over", rev: 11 }), { epoch: "boot-1", ordered: true }), false, "older than the read");
  assert.deepEqual(s.get("plan:b"), { purpose: "newer", rev: 12 }, "the newer plan stays on screen");
  assert.equal(s.entry("plan:b")?.rev, 13);
  assert.equal(s.patch("plan:b", 14, () => ({ purpose: "theirs", rev: 14 }), { epoch: "boot-1", ordered: true }), true, "a refusal after the read is taken");
  assert.deepEqual([s.get("plan:b"), s.entry("plan:b")?.rev], [{ purpose: "theirs", rev: 14 }, 14]);
  // a restore onto a backup: a new epoch, a lower rev, and what the server holds now
  assert.equal(s.patch("plan:b", 4, () => ({ purpose: "restored", rev: 4 }), { epoch: "boot-2", ordered: true }), true, "taken across a restore, whatever its rev");
  assert.deepEqual([s.get("plan:b"), s.entry("plan:b")?.rev, s.entry("plan:b")?.epoch], [{ purpose: "restored", rev: 4 }, 4, "boot-2"]);
  assert.equal(s.patch("plan:b", 2, () => ({ purpose: "older still", rev: 2 }), { epoch: "boot-2", ordered: true }), false);
  assert.equal(s.patch("plan:b", 2, (p: object) => ({ ...p, row: true }), { epoch: "boot-2" }), true, "a row patch is still never dropped");
});

test("a refused row of a list is ordered by that row's own rev, not the list's, which another row's refusal raised", () => {
  const s = new Store();
  type Row = { id: string; rev: number; v: string };
  const put = (row: Row) => (list: Row[]) => list.map((r) => (r.id === row.id ? row : r));
  const revIn = (id: string) => (list: Row[]) => list.find((r) => r.id === id)?.rev;
  s.apply<Row[]>("authored:b", 10, [{ id: "a", rev: 5, v: "a5" }, { id: "b", rev: 6, v: "b6" }], "wire", { epoch: "e" });
  assert.equal(s.patch("authored:b", 13, put({ id: "a", rev: 13, v: "a13" }), { epoch: "e", ordered: revIn("a") }), true);
  assert.equal(s.entry("authored:b")?.rev, 13, "the list's rev rises to the row's");
  assert.equal(s.patch("authored:b", 12, put({ id: "b", rev: 12, v: "b12" }), { epoch: "e", ordered: revIn("b") }), true, "b as held is rev 6: its refusal at 12 is newer");
  assert.equal(s.patch("authored:b", 11, put({ id: "a", rev: 11, v: "a11" }), { epoch: "e", ordered: revIn("a") }), false, "a as held is rev 13: its refusal at 11 is older");
  assert.deepEqual(s.get<Row[]>("authored:b")?.map((r) => r.v), ["a13", "b12"]);
  // a row the list does not hold is ordered by the list's rev
  assert.equal(s.patch("authored:b", 12, (list: Row[]) => [...list, { id: "c", rev: 12, v: "c12" }], { epoch: "e", ordered: revIn("c") }), false);
  assert.equal(s.patch("authored:b", 14, (list: Row[]) => [...list, { id: "c", rev: 14, v: "c14" }], { epoch: "e", ordered: revIn("c") }), true);
});

test("across a restore, a list's rows read in the old epoch order nothing: every row refusal is taken until the list is read again", () => {
  const s = new Store();
  type Row = { id: string; rev: number; v: string };
  const put = (row: Row) => (list: Row[]) => list.map((r) => (r.id === row.id ? row : r));
  const revIn = (id: string) => (list: Row[]) => list.find((r) => r.id === id)?.rev;
  s.apply<Row[]>("authored:b", 100, [{ id: "a", rev: 95, v: "a95" }, { id: "b", rev: 98, v: "b98" }, { id: "c", rev: 50, v: "c50" }], "wire", { epoch: "boot-1" });
  assert.equal(s.entry("authored:b")?.mixed, false);
  assert.equal(s.patch("authored:b", 40, put({ id: "a", rev: 40, v: "a40" }), { epoch: "boot-2", ordered: revIn("a") }), true, "a new epoch: taken whatever its rev");
  assert.deepEqual([s.entry("authored:b")?.rev, s.entry("authored:b")?.epoch, s.entry("authored:b")?.mixed], [40, "boot-2", true], "the list is in the new epoch, b and c still as read in the old one");
  assert.equal(s.patch("authored:b", 30, put({ id: "b", rev: 30, v: "b30" }), { epoch: "boot-2", ordered: revIn("b") }), true, "below b's old 98 and the list's 40: taken");
  assert.equal(s.patch("authored:b", 45, put({ id: "c", rev: 45, v: "c45" }), { epoch: "boot-2", ordered: revIn("c") }), true, "below c's old 50: taken");
  assert.equal(s.patch("authored:b", 29, put({ id: "b", rev: 29, v: "b29" }), { epoch: "boot-2", ordered: revIn("b") }), true, "until the list is read again, a row refused in the new epoch is not ordered either");
  assert.deepEqual([s.get<Row[]>("authored:b")?.map((r) => r.v), s.entry("authored:b")?.mixed], [["a40", "b29", "c45"], true]);
  // a row folded in without order (a confirmed row) keeps the list mixed
  assert.equal(s.patch("authored:b", 0, (list: Row[]) => list, { epoch: "boot-2" }), true);
  assert.equal(s.entry("authored:b")?.mixed, true);
  // the board read in the new epoch: every row as of it, ordered again
  assert.equal(s.apply<Row[]>("authored:b", 60, [{ id: "a", rev: 40, v: "a40" }, { id: "b", rev: 31, v: "b31" }, { id: "c", rev: 45, v: "c45" }], "wire", { epoch: "boot-2" }), true);
  assert.equal(s.entry("authored:b")?.mixed, false);
  assert.equal(s.patch("authored:b", 30, put({ id: "b", rev: 30, v: "b30" }), { epoch: "boot-2", ordered: revIn("b") }), false, "b read at 31 in this epoch: an older refusal is dropped");
  assert.equal(s.patch("authored:b", 46, put({ id: "c", rev: 46, v: "c46" }), { epoch: "boot-2", ordered: revIn("c") }), true);
  assert.deepEqual(s.get<Row[]>("authored:b")?.map((r) => r.v), ["a40", "b31", "c46"]);
  // a single document (plan, notes) moved across a restore is ordered in the new epoch at once
  s.apply("plan:b", 100, { purpose: "old", rev: 99 }, "wire", { epoch: "boot-1" });
  assert.equal(s.patch("plan:b", 40, () => ({ purpose: "restored", rev: 40 }), { epoch: "boot-2", ordered: true }), true);
  assert.equal(s.entry("plan:b")?.mixed, false);
  assert.equal(s.patch("plan:b", 39, () => ({ purpose: "older", rev: 39 }), { epoch: "boot-2", ordered: true }), false);
});

test("the view is a new object only when the base or the layers change", () => {
  const s = new Store();
  const base = { n: 1 };
  s.apply("q", 1, base, "wire");
  assert.equal(s.get("q"), base, "no layers: the view is the base itself");
  const first = s.get("q");
  s.apply("q", 0, { n: 0 }, "wire");                     // dropped
  s.invalidate(["q"], "op1");                              // only the stale mark moves
  assert.equal(s.get("q"), first, "a dropped answer or a stale mark leaves the view alone");
  const remove = s.apply<{ n: number }>("q", null, (v) => ({ n: v.n + 1 }), "optimistic", { op: "op2" });
  const layered = s.get("q");
  assert.notEqual(layered, first);
  assert.deepEqual(layered, { n: 2 });
  s.invalidate(["q"], "op3");
  assert.equal(s.get("q"), layered, "refolded only when base or layers moved");
  remove();
  assert.equal(s.get("q"), base);
});

test("with `equal`, an answer holding the same data keeps the held base and view; the rev still moves", () => {
  const s = new Store();
  s.apply("marks:b", 3, [{ id: "mk-1", rects: [{ x: 1 }] }], "wire", { equal: sameData });
  const view = s.get("marks:b");
  s.apply("marks:b", 4, [{ id: "mk-1", rects: [{ x: 1 }] }], "wire", { equal: sameData });
  assert.equal(s.get("marks:b"), view, "freshly parsed, the same data: the same view");
  assert.equal(s.entry("marks:b")?.rev, 4);
  s.apply("marks:b", 5, [{ id: "mk-1", rects: [{ x: 2 }] }], "wire", { equal: sameData });
  assert.notEqual(s.get("marks:b"), view, "a changed field is a new view");
  assert.equal(sameData({ a: [1, { b: null }] }, { a: [1, { b: null }] }), true);
  assert.equal(sameData({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(sameData([1], { 0: 1 }), false);
});

test("listeners are per key: a write to one key calls only that key's listeners", () => {
  const s = new Store();
  const marks = counter(), notes = counter();
  const off = s.subscribe("marks:b", marks.fn);
  s.subscribe("notes:b", notes.fn);
  s.apply("marks:b", 1, [], "wire");
  s.apply("marks:c", 1, [], "wire");
  assert.equal(marks.n, 1);
  assert.equal(notes.n, 0);
  off();
  s.apply("marks:b", 2, [], "wire");
  assert.equal(marks.n, 1, "unsubscribed");
});

/** a query whose every read waits for the test to answer it */
function query(s: Store, key: string, tags: string[] = []) {
  const reads: ReturnType<typeof deferred<Fetched<string>>>[] = [];
  const fetch = () => { const d = deferred<Fetched<string>>(); reads.push(d); return d.promise; };
  const seen = counter();
  const off = s.watch(key, seen.fn, fetch, tags);
  return { reads, seen, off, watchAgain: () => s.watch(key, seen.fn, fetch, tags) };
}
/** a query's answer: its rev is its X-Strata-Rev, unless a scope rev is given apart */
const wire = (value: string, rev: number, epoch = "", stamp = rev): Fetched<string> => ({ value, rev, stamp, epoch, origin: "wire" });

test("a watched query is asked when first watched, and once more when the write that made it stale settles", async () => {
  const s = new Store();
  const q = query(s, "register", ["register"]);
  assert.equal(q.reads.length, 1, "nothing held: asked at once");
  q.reads[0].resolve(wire("v10", 10));
  await tick();
  assert.equal(s.get("register"), "v10");
  s.invalidate(["register"], "op1");                      // the write starts
  assert.equal(s.entry("register")?.stale, true);
  assert.equal(q.reads.length, 1, "not asked while the write is out: it would read the old value");
  s.settle("op1", 20);                                    // …and lands at stamp 20
  assert.equal(q.reads.length, 2, "asked again once it settled");
  q.reads[1].resolve(wire("v20", 20));
  await tick();
  assert.equal(s.get("register"), "v20");
  assert.equal(s.entry("register")?.stale, false, "the read past the stamp clears the mark");
});

test("an answer stamped below the settled write is discarded; a read that left before it is asked again once", async () => {
  const s = new Store();
  const q = query(s, "boards", ["boards"]);
  q.reads[0].resolve(wire("v10", 10));
  await tick();
  s.invalidate(["boards"], "op1");
  s.refetch("boards");                                    // a read leaves before the write lands
  assert.equal(q.reads.length, 2);
  s.settle("op1", 20);
  assert.equal(q.reads.length, 2, "one read per key: the settle waits on the one already out");
  q.reads[1].resolve(wire("v15, computed before the write", 15));
  await tick();
  assert.equal(s.get("boards"), "v10", "below the stamp: discarded");
  assert.equal(q.reads.length, 3, "…and asked once more, since it left before the write settled");
  q.reads[2].resolve(wire("v14, still below", 14));
  await tick();
  assert.equal(q.reads.length, 3, "a read that left after the write and is still below it is not chased (no loop)");
  assert.equal(s.apply("boards", 19, "late answer", "wire", { stamp: 19 }), false, "any later answer below 20 is discarded too");
  assert.equal(s.apply("boards", 21, "v21", "wire", { stamp: 21 }), true);
  assert.equal(s.apply("boards", 5, "new epoch", "wire", { epoch: "boot-2", stamp: 5 }), true, "the floor belongs to its epoch");
});

test("a stale query nobody watches is asked on its next watch; a failed write asks nothing and the next read clears it", async () => {
  const s = new Store();
  const q = query(s, "decks", ["decks"]);
  q.reads[0].resolve(wire("v1", 1));
  await tick();
  q.off();
  s.invalidate(["decks"], "op1");
  s.settle("op1", 5);
  assert.equal(q.reads.length, 1, "unwatched: not asked");
  q.watchAgain();
  assert.equal(q.reads.length, 2, "asked on the next watch");
  q.reads[1].resolve(wire("v5", 5));
  await tick();
  assert.equal(s.entry("decks")?.stale, false);

  s.invalidate(["decks"], "op2");
  s.settle("op2", null);                                  // refused: nothing changed on the server
  assert.equal(q.reads.length, 2, "a failed write asks nothing");
  assert.equal(s.entry("decks")?.stale, true, "…the mark stays until a read clears it");
  s.refetch("decks");
  q.reads[2].resolve(wire("v5 again", 5));
  await tick();
  assert.equal(s.entry("decks")?.stale, false);
});

test("a key already at or past the stamp is not asked again; a server with no stamps (0) is always asked", async () => {
  const s = new Store();
  const q = query(s, "review", ["review"]);
  q.reads[0].resolve(wire("v1", 1));
  await tick();
  s.invalidate(["review"], "op1");
  s.apply("review", 30, "v30 from the op's own answer", "wire", { stamp: 30 });
  s.settle("op1", 30);
  assert.equal(q.reads.length, 1, "fresh already: not asked");
  assert.equal(s.entry("review")?.stale, false);

  s.invalidate(["review"], "op2");
  s.settle("op2", 0);
  assert.equal(q.reads.length, 2, "stamp 0 proves nothing: asked again");
});

test("a scope-revisioned key is judged by its answer's stamp, never its rev: a fresh deck read below the write's stamp is kept", async () => {
  const s = new Store();
  const q = query(s, "deck:fin", []);
  q.reads[0].resolve(wire("courses.rev 40", 40, "", 45));
  await tick();
  s.invalidate(["deck:fin"], "op1");
  s.settle("op1", 60);                                    // the write landed at stamp 60; the deck's rows at 55
  assert.equal(q.reads.length, 2, "held below the stamp: asked again");
  q.reads[1].resolve(wire("courses.rev 55, read at 61", 55, "", 61));
  await tick();
  assert.equal(s.get("deck:fin"), "courses.rev 55, read at 61", "computed after the write: kept, though its rev is below 60");
  assert.equal(s.entry("deck:fin")?.stale, false);
  assert.equal(q.reads.length, 2);
  assert.equal(s.apply("deck:fin", 55, "read before the write", "wire", { stamp: 59 }), false, "the stamp still discards what is older");
});

test("invalidating without an op asks watched queries at once; tags reach queries, names reach keys", async () => {
  const s = new Store();
  const collection = query(s, "collection:b1", ["collection"]);
  collection.reads[0].resolve(wire("c1", 1));
  await tick();
  s.apply("deck:src-s1", 3, { ids: [] }, "wire");
  s.invalidate(["collection", "deck:src-s1"]);           // a job finished: the change already happened
  assert.equal(collection.reads.length, 2, "a watched query carrying the tag is asked now");
  assert.equal(s.entry("deck:src-s1")?.stale, true, "a key named directly is marked");
  s.invalidate(["unrelated"]);
  assert.equal(collection.reads.length, 2);
});

test("a change already on the server, while a read is out, is followed by a read that left after it", async () => {
  const s = new Store();
  const q = query(s, "deck:src-s1", []);
  q.reads[0].resolve(wire("v1", 1));
  await tick();
  void s.refetch("deck:src-s1");                          // a read leaves…
  s.invalidate(["deck:src-s1"]);                          // …then the tree turns ready
  assert.equal(q.reads.length, 2, "one read per key: the one already out answers first");
  q.reads[1].resolve(wire("v1, read before the change", 1));
  await tick();
  assert.equal(s.entry("deck:src-s1")?.stale, true, "it cannot have seen the change: still stale");
  assert.equal(q.reads.length, 3, "asked once more");
  q.reads[2].resolve(wire("v2", 2));
  await tick();
  assert.equal(s.get("deck:src-s1"), "v2");
  assert.equal(s.entry("deck:src-s1")?.stale, false);
  assert.equal(q.reads.length, 3, "no loop");
});

test("a failed read is kept as the key's error, and the next watch asks again", async () => {
  const s = new Store();
  const q = query(s, "tree:b/r/", []);
  q.reads[0].reject(new Error("HTTP 500"));
  await tick();
  assert.equal((s.entry("tree:b/r/")?.error as Error).message, "HTTP 500");
  assert.equal(q.seen.n, 1, "the watcher heard about it");
  q.watchAgain();
  assert.equal(q.reads.length, 2, "nothing held: asked again");
  q.reads[1].resolve(wire("tree", 4));
  await tick();
  assert.equal(s.entry("tree:b/r/")?.error, undefined, "a good read clears the error");
});
