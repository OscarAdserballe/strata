// A zero ceiling needs a floor too: a count of unwanted work is also 0 when the path never ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { judge, isFloor } from "./judge.mjs";

const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));

test("a ceiling, a floor and an exact count judge as they say", () => {
  assert.deepEqual(judge(12, 12), { ok: true, bound: "≤ 12" });
  assert.equal(judge(12, 13).ok, false);
  assert.deepEqual(judge(["min", 1], 1), { ok: true, bound: "≥ 1" });
  assert.equal(judge(["min", 1], 0).ok, false);
  assert.deepEqual(judge(["eq", 1], 1), { ok: true, bound: "= 1" });
  assert.equal(judge(["eq", 1], 0).ok, false, "fewer than the claim: the path it vouches for never ran");
  assert.equal(judge(["eq", 1], 2).ok, false);
  assert.equal(judge(0, undefined).ok, false, "a count the scenario never reported is not a 0");
});

test("a budget in any other shape is refused, not read as a ceiling", () => {
  for (const bad of [["mni", 1], ["min"], ["eq", "1"], ["min", 1, 2], "3", null]) {
    assert.throws(() => judge(bad, 0), /a budget is a number/, JSON.stringify(bad));
  }
});

test("every line of budgets.json is a shape the gate reads", () => {
  for (const [key, limits] of Object.entries(budgets.scenarios)) {
    for (const [metric, limit] of Object.entries(limits)) assert.doesNotThrow(() => judge(limit, 0), `${key} ${metric}`);
  }
});

// scenarios that throw when the path their zero ceilings watch did not run; this list may only shrink
const RAN_OR_THROWS = {
  "continue/home": "scenarios.mjs toCardAndPage: waits for a new card in the room and the page in view inked",
  "deck-open/board-page": "scenarios.mjs toCardAndPage: waits for a new card in the room and the page in view inked",
  "review/home": "scenarios.mjs reviewOpen: waits for the review's first card",
  "idle/pdf-chat": "an idle window: nothing is meant to run, so there is no path to have run",
};

test("every journey with a ceiling of 0 has a floor saying its path ran", () => {
  const bare = [];
  for (const [key, limits] of Object.entries(budgets.scenarios)) {
    const zero = Object.entries(limits).filter(([, l]) => l === 0 || (Array.isArray(l) && l[0] === "max" && l[1] === 0)).map(([m]) => m);
    if (!zero.length || Object.values(limits).some(isFloor)) continue;
    if (!RAN_OR_THROWS[key]) bare.push(`${key} (${zero.join(", ")})`);
  }
  assert.deepEqual(bare, [], "a ceiling of 0 with nothing saying the journey did what it measures");
  for (const key of Object.keys(RAN_OR_THROWS)) {
    const limits = budgets.scenarios[key];
    assert.ok(limits, `${key} is not in budgets.json: delete its line here`);
    assert.ok(!Object.values(limits).some(isFloor), `${key} has a floor now: delete its line from RAN_OR_THROWS`);
  }
});
