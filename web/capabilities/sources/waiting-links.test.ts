import { test } from "node:test";
import assert from "node:assert/strict";
import { WaitingLinks, type LinkDeps } from "./waiting-links.ts";
import type { Shelf } from "../../data/outbox.ts";

const mapShelf = (map = new Map<string, string>()): Shelf & { map: Map<string, string> } =>
  ({ map, put: (id, v) => { map.set(id, v); }, drop: (id) => { map.delete(id); }, all: () => [...map.values()] });

function links(shelf = mapShelf()) {
  const wire = { down: true };
  const sent: { board: string; url: string; key: string }[] = [];
  const said: string[] = [];
  let answer: () => Promise<unknown> = async () => ({ resourceId: "r1" });
  const deps: LinkDeps = {
    shelf, down: () => wire.down,
    capture: (board, url, key) => { sent.push({ board, url, key }); return answer(); },
    landed: (l) => said.push(`landed ${l.url}`), refused: (l) => said.push(`refused ${l.url}`),
  };
  return { w: new WaitingLinks(deps), wire, sent, said, shelf, answer: (fn: () => Promise<unknown>) => { answer = fn; } };
}

test("online a link is not taken: it is captured the usual way", () => {
  const t = links();
  t.wire.down = false;
  assert.equal(t.w.wait("b1", "https://example.com/a"), null);
  assert.equal(t.shelf.map.size, 0);
});

test("offline a link waits on the device, once per board and link, and is captured under its receipt on reconnect", async () => {
  const t = links();
  const one = t.w.wait("b1", "https://example.com/a", 1);
  assert.equal(t.w.wait("b1", "https://example.com/a", 2), one, "pasted twice, it waits once");
  t.w.wait("b1", "https://example.com/b", 3);
  await t.w.drain();
  assert.equal(t.sent.length, 0, "nothing is sent while the wire is down");
  const reopened = links(t.shelf);
  assert.equal(reopened.w.now().length, 2, "a tab closed on the plane still owes them");
  reopened.wire.down = false;
  await reopened.w.drain();
  assert.deepEqual(reopened.sent.map((s) => s.url), ["https://example.com/a", "https://example.com/b"], "in the order pasted");
  assert.equal(reopened.sent[0].key, one!.key, "the receipt it was kept under, so a lost answer is not a second source");
  assert.equal(reopened.w.now().length, 0);
  assert.equal(reopened.shelf.map.size, 0);
});

test("a lost answer leaves the link waiting for the next try; a refusal lets it go and says so", async () => {
  const t = links();
  t.w.wait("b1", "https://example.com/a");
  t.wire.down = false;
  t.answer(() => Promise.reject(Object.assign(new Error("gone"), { status: 0 })));
  await t.w.drain();
  assert.equal(t.w.now().length, 1);
  t.answer(() => Promise.reject(Object.assign(new Error("bad link"), { status: 400 })));
  await t.w.drain();
  assert.equal(t.w.now().length, 0);
  assert.deepEqual(t.said, ["refused https://example.com/a"]);
});
