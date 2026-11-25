// Card writes and page saves made offline wait on the device and go out on reconnect under one receipt each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "./mutate.ts";
import { Outbox, type Shelf } from "./outbox.ts";
import { authoredKind, type AuthoredAct } from "./entities/authored.ts";
import { pageStateOps, type PageStateAct } from "./entities/pagestate.ts";
import { cardEditKind, type CardEditAct } from "../capabilities/card/saveCard.ts";
import type { Card } from "../../shared/types/index.ts";

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
const answer = (status: number, body: unknown = {}, rev = 0): SendAnswer => ({ status, body, rev, epoch: "e" });
const mapShelf = (map = new Map<string, string>()): Shelf & { map: Map<string, string> } =>
  ({ map, put: (id, v) => { map.set(id, v); }, drop: (id) => { map.delete(id); }, all: () => [...map.values()] });

function tab(shelf = mapShelf(), clashShelf = mapShelf()) {
  const listeners = new Set<() => void>();
  const wire = { isDown: true, down: () => wire.isDown, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const store = new Store();
  const m = new Mutator({ store, wire, setTimer: () => 0, clearTimer: () => {}, now: () => 0,
    transport: (req) => new Promise<SendAnswer>((resolve) => { sent.push({ req, reply: resolve }); }) });
  let clock = 100;
  const o = new Outbox(m, shelf, clashShelf, () => clock++);
  o.kind<AuthoredAct>("authored", authoredKind(store));
  o.kind<CardEditAct>("card.edit", cardEditKind(store));
  o.kind<PageStateAct>("pagestate", { build: (a) => pageStateOps.save(a.board, a.rid, a.value, store), collapse: (a) => a.rid });
  const up = async () => { wire.isDown = false; for (const fn of [...listeners]) fn(); await tick(); };
  return { o, sent, shelf, clashShelf, up };
}

test("a card made and one edited offline wait on the device, then go out once each on reconnect", async () => {
  const t = tab();
  void t.o.send("authored", { do: "create", board: "b1", draft: { front: "What is 2SLS?", variant: "bare", back: "IV in two stages" } } satisfies AuthoredAct).catch(() => {});
  void t.o.send("authored", { do: "update", board: "b1", mid: "m1", patch: { back: "new back" }, base: 7 } satisfies AuthoredAct).catch(() => {});
  await tick();
  assert.equal(t.sent.length, 0, "nothing leaves while the wire is down");
  assert.equal(t.shelf.map.size, 2, "both are on the device");
  await t.up();
  const byPath = Object.fromEntries(t.sent.map((s) => [`${s.req.method} ${s.req.path}`, s.req]));
  assert.ok(byPath["POST /api/boards/b1/minted"]?.headers["Idempotency-Key"], "the create goes under its receipt");
  assert.equal(byPath["PATCH /api/boards/b1/minted/m1"]?.headers["If-Match"], '"7"', "the edit carries the base frozen at the click");
  for (const s of t.sent) s.reply(answer(200, { state: {} }));
  await tick();
  assert.equal(t.shelf.map.size, 0);
});

test("a card edited offline that meets another text on reconnect is listed as a clash, not written over", async () => {
  const t = tab();
  const card = { id: "c1", deck: "econometrics", front: "Q", back: "old", rev: 3 } as unknown as Card;
  void t.o.send("card.edit", { card, patch: { back: "mine" }, board: "b1" } satisfies CardEditAct).catch(() => {});
  await t.up();
  assert.equal(t.sent[0].req.path, "/api/decks/econometrics/cards/c1");
  assert.equal(t.sent[0].req.headers["If-Match"], '"3"');
  t.sent[0].reply(answer(409, { error: "changed elsewhere", conflict: { rev: 5, value: { id: "c1", front: "Q", back: "theirs", rev: 5 } } }));
  await tick();
  const [clash] = t.o.clashes();
  assert.ok(clash, "the clash is kept for the banner");
  assert.match(clash.mine, /mine/);
  assert.match(clash.theirs, /theirs/);
});

test("an interactive page's saves made offline collapse to the newest when a reopened tab replays them", async () => {
  const shelf = mapShelf();
  const first = tab(shelf);
  for (const value of ["1", "2", "3"]) void first.o.send("pagestate", { board: "b1", rid: "r1", value } satisfies PageStateAct).catch(() => {});
  await tick();
  const second = tab(shelf);
  second.o.restore();
  await second.up();
  assert.deepEqual(second.sent.map((s) => JSON.parse(String(s.req.body)).value), ["3"], "last save wins");
});
