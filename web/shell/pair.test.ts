import { test } from "node:test";
import assert from "node:assert/strict";
import { holdPair, pairIdNow, pairIndex, pairNow } from "./pair.ts";

const HOME = { id: "home" };
const A = { id: "pr-a" }, B = { id: "pr-b" }, C = { id: "pr-c" };

test("a pair still at its place is found there", () => {
  assert.equal(pairIndex([HOME, A, B, C], { i: 2, id: "pr-b" }), 2);
});

test("a pair that moved (one before it went) is still the pair in hand", () => {
  // stood on B at 2; A was deleted, so B is drawn at 1 and C now sits at 2
  assert.equal(pairIndex([HOME, B, C], { i: 2, id: "pr-b" }), 1);
});

test("a pair that went is home, not the neighbour that slid into its place", () => {
  // stood on A at 1; A was deleted, and B is drawn at 1
  assert.equal(pairIndex([HOME, B, C], { i: 1, id: "pr-a" }), 0);
});

test("the last pair, gone, is home", () => {
  assert.equal(pairIndex([HOME, A], { i: 2, id: "pr-b" }), 0);
  assert.equal(pairIndex([HOME], { i: 1, id: "pr-a" }), 0);
});

test("home is home, whatever is drawn", () => {
  assert.equal(pairIndex([HOME, A, B], { i: 0, id: null }), 0);
  assert.equal(pairIndex([], { i: 0, id: null }), 0);
});

test("the home row's own id never stands in for a pair", () => {
  assert.equal(pairIndex([HOME, A], { i: 1, id: "home" }), 0);
});

test("holding a pair keeps its id; holding home keeps none", () => {
  holdPair(2, "pr-b");
  assert.equal(pairNow(), 2);
  assert.equal(pairIdNow(), "pr-b");
  holdPair(0, null);
  assert.equal(pairNow(), 0);
  assert.equal(pairIdNow(), null);
  holdPair(3, null);
  assert.equal(pairNow(), 0);
  assert.equal(pairIdNow(), null);
});
