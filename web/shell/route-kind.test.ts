import { test } from "node:test";
import assert from "node:assert/strict";

const g = globalThis as Record<string, unknown>;
const written: string[] = [];
const listeners = new Map<string, () => void>();
g.location = { search: "?board=b", pathname: "/" };
g.history = {
  pushState: (_: unknown, __: string, url: string) => { written.push("push " + url); (g.location as { search: string }).search = url.slice(1); },
  replaceState: (_: unknown, __: string, url: string) => { written.push("replace " + url); (g.location as { search: string }).search = url.slice(1); },
};
g.addEventListener = (type: string, fn: () => void) => { listeners.set(type, fn); };
g.removeEventListener = (type: string) => { listeners.delete(type); };
const { go, routeKind, subscribeRoute } = await import("./routes.ts");

test("go writes the bar and publishes a change of screen, not a move inside one", () => {
  assert.equal(routeKind(), "board", "read from the address bar at load");
  let heard = 0;
  const off = subscribeRoute(() => heard++);
  assert.ok(listeners.has("popstate"), "Back and Forward are heard while someone listens");
  go({ kind: "board", board: "b", pair: "p2" });
  assert.equal(heard, 0, "a page flip is the same screen");
  assert.deepEqual(written, ["push /?board=b&pair=p2"]);
  go({ kind: "library" });
  assert.equal(routeKind(), "library");
  assert.equal(heard, 1);
  go({ kind: "review" }, "replace");
  assert.equal(written.at(-1), "replace /?view=review");
  go({ kind: "review" }, "none");
  assert.equal(heard, 2, "the same screen is not news");
  const writes = written.length;
  go({ kind: "library" }, "none");
  assert.equal(written.length, writes, "none restores without writing the bar");
  assert.equal(routeKind(), "library");
  assert.equal(heard, 3, "…and still publishes a change of screen");
  (g.location as { search: string }).search = "?board=b&view=cram";
  listeners.get("popstate")!();
  assert.equal(routeKind(), "cram", "Back publishes what the bar now says");
  assert.equal(heard, 4);
  off();
  assert.ok(!listeners.has("popstate"), "nobody listening: Back is not watched");
});
