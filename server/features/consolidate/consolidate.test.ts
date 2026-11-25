import { test } from "node:test";
import assert from "node:assert/strict";
import type { DistilMark } from "../../../shared/types/index.ts";
import { checkedMap, fakeMap, ideaId } from "./consolidate.ts";

const mark = (ref: string, deck = "d1"): DistilMark => ({ ref, kind: "kept", text: `q ${ref}`, said: `a ${ref}`, from: "src", deck });
const marks = ["k:a", "k:b", "n:c", "q:d", "k:e"].map((r) => mark(r));
const draft = { front: "F", back: "B" };

test("checkedMap keeps each of the board's marks in one idea of at least two", () => {
  const out = { ideas: [
    { title: "one", why: "w", marks: ["k:a", "k:b", "k:zz"], draft, suggestions: [{ kind: "merge", text: "same", with: 1 }, { kind: "nonsense", text: "x" }] },
    { title: "two", why: "w", marks: ["k:b", "n:c", "q:d"], draft, suggestions: [{ kind: "split", text: "two things", cards: [draft, draft] }, { kind: "split", text: "one", cards: [draft] }] },
    { title: "lonely", marks: ["k:e"], draft },
    { title: "no draft", marks: ["k:e", "k:a"] },
  ] };
  const m = checkedMap(out, marks, "d1");
  assert.deepEqual(m.ideas.map((i) => i.marks), [["k:a", "k:b"], ["n:c", "q:d"]], "unknown and repeated refs drop; a one-mark idea goes");
  assert.deepEqual(m.loose, ["k:e"]);
  assert.equal(m.ideas[0].id, ideaId(["k:b", "k:a"]), "the id is the marks, in any order");
  assert.deepEqual(m.ideas[0].suggestions.map((s) => [s.kind, s.with]), [["merge", m.ideas[1].id]], "merge points at the other idea; an unknown kind drops");
  assert.deepEqual(m.ideas[1].suggestions.map((s) => s.kind), ["split"], "a split needs two cards");
});

test("checkedMap survives a reply that is not a map", () => {
  for (const out of [null, "text", { ideas: "no" }, { ideas: [null, 3] }]) {
    const m = checkedMap(out, marks, "d1");
    assert.equal(m.ideas.length, 0);
    assert.equal(m.loose.length, marks.length);
  }
});

test("fakeMap groups by deck and leaves a deck of one mark alone", () => {
  const m = fakeMap([...marks, mark("k:x", "d2")], "d1");
  assert.equal(m.ideas.length, 1);
  assert.equal(m.ideas[0].deck, "d1");
  assert.deepEqual(m.loose, ["k:x"]);
  assert.ok(m.ideas[0].suggestions.some((s) => s.kind === "split"), "five marks offer a split");
});
