import { test } from "node:test";
import assert from "node:assert/strict";
import { Navigation } from "./routes.ts";

const land = (nav: Navigation, held: string | null, incoming: string): string | null =>
  nav.accepts(incoming, held) ? incoming : held;

test("the open board's own update lands while the launcher is over it", () => {
  const nav = new Navigation();
  nav.begin({ kind: "board", board: "a", pair: "p1", resource: "r1" });
  let held = land(nav, null, "a");
  nav.begin({ kind: "library" });
  assert.equal(nav.owns("a"), false, "the route is the library's");
  assert.equal(nav.accepts("a", held), true);
  held = land(nav, held, "a");
  assert.equal(held, "a");
  assert.equal(nav.accepts("b", held), false);
  assert.equal(land(nav, held, "b"), "a");
});

test("the same holds behind the review", () => {
  const nav = new Navigation();
  nav.begin({ kind: "board", board: "a" });
  nav.begin({ kind: "library" });
  nav.begin({ kind: "review" });
  assert.equal(nav.accepts("a", "a"), true);
  assert.equal(nav.accepts("b", "a"), false);
});

test("a late answer for the board you left never switches you back (#51)", () => {
  const nav = new Navigation();
  nav.begin({ kind: "board", board: "a" });
  nav.begin({ kind: "board", board: "b" });
  assert.equal(nav.accepts("a", "a"), false, "a's late chat reply or mutation must not land");
  assert.equal(land(nav, "a", "b"), "b", "b's own state lands");
  assert.equal(nav.accepts("a", "b"), false);
  const via = new Navigation();
  via.begin({ kind: "board", board: "a" });
  via.begin({ kind: "library" });
  via.begin({ kind: "board", board: "b" });
  assert.equal(via.accepts("a", "a"), false);
  assert.equal(via.accepts("b", "a"), true);
});

test("a board that failed to open hands the overlay back to the board that is still held", () => {
  const nav = new Navigation();
  nav.begin({ kind: "board", board: "a" });
  nav.begin({ kind: "library" });
  const previous = nav.route;
  nav.begin({ kind: "board", board: "b" });
  nav.begin(previous);
  assert.equal(nav.accepts("a", "a"), true, "a is still the open board behind the library");
  assert.equal(nav.accepts("b", "a"), false, "b never opened");
});

test("with no board open, nothing lands but the board being opened", () => {
  const nav = new Navigation();
  assert.equal(nav.accepts("a", null), false);
  assert.equal(nav.accepts("a", undefined), false);
  nav.begin({ kind: "board", board: "a" });
  assert.equal(nav.accepts("a", null), true);
});
