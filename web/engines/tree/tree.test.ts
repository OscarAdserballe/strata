import { test } from "node:test";
import assert from "node:assert/strict";
import { liftSynthesis } from "./tree.ts";

type N = { id: string; kind?: string | null; children?: N[] };
const n = (id: string, kind: string | null, children: N[] = []): N => ({ id, kind, children });

test("a lone synthesis root is lifted, its pillars become the roots", () => {
  const tree = [n("n1", "synthesis", [n("n1.1", "concept"), n("n1.2", "mechanism")])];
  const { root, pillars } = liftSynthesis(tree);
  assert.equal(root && root.id, "n1");
  assert.deepEqual(pillars.map((p) => p.id), ["n1.1", "n1.2"]);
});

test("several roots stay as they are — the legacy shape", () => {
  const tree = [n("n1", "concept", [n("n1.1", "claim")]), n("n2", "concept")];
  const { root, pillars } = liftSynthesis(tree);
  assert.equal(root, null);
  assert.equal(pillars, tree);
});

test("one root that is not a synthesis, or has nothing under it, is not lifted", () => {
  assert.equal(liftSynthesis([n("n1", "concept", [n("n1.1", "claim")])]).root, null);
  assert.equal(liftSynthesis([n("n1", "synthesis")]).root, null);
  assert.equal(liftSynthesis([]).root, null);
});
