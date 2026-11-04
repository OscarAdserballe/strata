import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsIn } from "./claims.ts";

test("a source's claims come out in reading order, section by section, each with its depth", () => {
  const trees = {
    a: { data: { status: "ready", tree: { nodes: [
      { id: "1", label: "thesis", kind: "claim", anchor: "p. 1", questions: ["q"], children: [
        { id: "1.1", label: "limb", anchor: "p. 2", children: [{ id: "1.1.1", label: "turn" }] },
      ] },
      { id: "2", label: "second", anchor: "p. 5" },
    ] } } },
    b: { data: { status: "running", tree: { nodes: [{ id: "x", label: "not yet" }] } } },
    c: { data: { status: "ready", tree: { nodes: [{ id: "3", label: "chapter two" }] } } },
    d: { data: { status: "ready", tree: null } },
  };
  const claims = claimsIn(trees, [{ id: "a" }, { id: "b" }, { id: "missing" }, { id: "d" }, { id: "c" }]);
  assert.deepEqual(claims.map((c) => [c.id, c.depth]), [["1", 0], ["1.1", 1], ["1.1.1", 2], ["2", 0], ["3", 0]]);
  assert.deepEqual(claims[0], { id: "1", label: "thesis", kind: "claim", anchor: "p. 1", questions: ["q"], depth: 0 });
  assert.deepEqual(claims[1].questions, [], "a claim with no questions still carries a list");
  assert.deepEqual(claimsIn({}, []), []);
});
