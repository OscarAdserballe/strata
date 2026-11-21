import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "./revive.ts";
import { keepOps } from "./keeps.ts";
import { markOps } from "./marks.ts";
import type { Op } from "../mutate.ts";

const wire = (o: Op<unknown> | null) => o && { method: o.method, path: o.path, body: o.body, lanes: o.lanes, key: o.key, revive: o.revive };
// what a reload does to a kept op: its recipe through JSON, then built again
const again = (o: Op<unknown>) => build(JSON.parse(JSON.stringify(o.revive)));

test("every op kept offline builds again from its stored recipe into the same request", () => {
  const draft = { resourceId: "src_1", page: null, start: 1, end: 5, quote: "beta", rects: [], id: "mk-0011223344556677" };
  const ops: Op<unknown>[] = [
    keepOps.toggle("deck", "c1", true) as Op<unknown>,
    markOps.create("b1", draft, () => 7) as Op<unknown>,
    markOps.note("b1", "mk-0011223344556677", "mine", "theirs") as Op<unknown>,
    markOps.reply("b1", "mk-0011223344556677", "mr-1", "a reply", () => 9) as Op<unknown>,
    markOps.remove("b1", "mk-0011223344556677", true) as Op<unknown>,
  ];
  for (const o of ops) assert.deepEqual(wire(again(o)), wire(o), o.label);
});

test("a recipe that doesn't make sense builds nothing", () => {
  assert.equal(build({ kind: "nope", args: [] }), null);
  assert.equal(build({ kind: "mark.note", args: [1, 2] }), null);
  assert.equal(build(null as never), null);
});

test("a note's clash keeps mine over theirs, and handing it over files both texts once", () => {
  const o = markOps.note("b1", "mk-1", "mine", null);
  const spec = o.clash!({ rev: 3, value: { note: "theirs" } });
  assert.deepEqual([spec?.mine, spec?.theirs], ["mine", "theirs"]);
  assert.deepEqual(wire(build(spec!.keepMine))?.body, { note: "mine", was: "theirs" });
  const filed = build({ kind: "clash.agent", args: [{ ...spec, id: "clash-x", label: "save that note", at: 0 }] });
  assert.equal(filed?.path, "/api/dashboard/inbox");
  assert.equal(filed?.key, "clash-x");
  assert.match(String((filed?.body as { body: string }).body), /> mine[\s\S]*> theirs/);
});
