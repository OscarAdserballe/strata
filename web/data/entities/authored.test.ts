import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { authored, authoredOps } from "./authored.ts";
import type { AuthoredRow } from "./boards.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
  });
  const row = { id: "m-1", front: "why?", back: "because", state: "closed", rev: 7 } as unknown as AuthoredRow;
  store.apply<AuthoredRow[]>("authored:b1", 3, [row], "wire");
  return { store, sent, m };
}

test("two drops of one draft send one key, and the second replays the first card; edited words are a new key", async () => {
  const { sent, m } = room();
  const draft = { front: "why?", variant: "bare" };
  const one = authored.create("b1", draft, { draftKey: "draft-key-0001" }, m);
  const two = authored.create("b1", { ...draft }, { draftKey: "draft-key-0001" }, m);
  await tick();
  assert.equal(sent.length, 1, "creates on one board go one at a time");
  sent[0].reply({ status: 201, body: { id: "m-2" }, rev: 4, epoch: "" });
  await tick();
  assert.equal(sent.length, 2);
  const key = sent[0].req.headers["Idempotency-Key"];
  assert.match(key, /^draft-key-0001-[0-9a-f]{8}$/);
  assert.equal(sent[1].req.headers["Idempotency-Key"], key, "the same draft is the same request: the receipt answers it");
  sent[1].reply({ status: 201, body: { id: "m-2" }, rev: 4, epoch: "" });
  assert.equal((await one).id, (await two).id);
  // a key sent again with other bytes is a 422: the edited draft is a request of its own
  assert.notEqual(authoredOps.create("b1", { front: "why, really?", variant: "bare" }, "draft-key-0001").key, key);
  assert.match(authoredOps.create("b1", draft, "f".repeat(80)).key!, /^[A-Za-z0-9-]{8,80}$/, "within the server's key shape");
});

test("a create with no draft of its own (a probe, the tour's card) gets a key of its own each time", async () => {
  const { sent, m } = room();
  void authored.create("b1", { front: "why?", variant: "bare" }, {}, m);
  void authored.create("b1", { front: "why?", variant: "bare" }, {}, m);
  await tick();
  sent[0].reply({ status: 201, body: { id: "m-2" }, rev: 4, epoch: "" });
  await tick();
  assert.notEqual(sent[0].req.headers["Idempotency-Key"], sent[1].req.headers["Idempotency-Key"]);
  assert.equal(sent[1].req.path, "/api/boards/b1/minted");
});

test("a rewrite of the text states the row's rev; a patch of meta alone states none", () => {
  const { store } = room();
  assert.equal(authoredOps.update("b1", "m-1", { back: "new" }, store).base?.(), 7);
  assert.equal(authoredOps.update("b1", "m-1", { meta: { x: 1 } }, store).base, undefined);
  assert.deepEqual(authoredOps.update("b1", "m-1", { back: "new" }, store).lanes, ["authored:m-1"]);
});

test("a 409 over a face this edit did not change is sent again over the new rev; over one it did, it fails", async () => {
  const { store, sent, m } = room();
  const saving = authored.update("b1", "m-1", { back: "mine" }, m, store);
  await tick();
  assert.equal(sent[0].req.headers["If-Match"], '"7"');
  // someone rephrased the front elsewhere: the back this edit writes is as it was
  sent[0].reply({ status: 409, body: { error: "changed", conflict: { rev: 9, value: { id: "m-1", front: "why, exactly?", back: "because", state: "closed" } } }, rev: 9, epoch: "" });
  await tick();
  assert.equal(sent[1].req.headers["If-Match"], '"9"');
  assert.equal(store.get<AuthoredRow[]>("authored:b1")?.[0].front, "why, exactly?", "the room holds their row");
  sent[1].reply({ status: 200, body: {}, rev: 10, epoch: "" });
  await saving;

  const clash = authored.update("b1", "m-1", { back: "mine again" }, m, store);
  await tick();
  sent[2].reply({ status: 409, body: { error: "changed", conflict: { rev: 11, value: { id: "m-1", front: "why, exactly?", back: "theirs", state: "closed" } } }, rev: 11, epoch: "" });
  await assert.rejects(clash, (e: { conflict?: { rev: number } }) => e.conflict?.rev === 11);
});

// late409: a slow refusal heard after a newer read must not step the row back.
const rowAt = (rev: number, front: string, back = "because") => ({ id: "m-1", front, back, state: "closed", rev }) as unknown as AuthoredRow;

test("late409: a refusal heard after a newer board read keeps that row and settles the edit over it", async () => {
  const { store, sent, m } = room();
  const saving = authored.update("b1", "m-1", { back: "mine" }, m, store);
  await tick();
  assert.equal(sent[0].req.headers["If-Match"], '"7"');
  store.apply<AuthoredRow[]>("authored:b1", 12, [rowAt(11, "why, really?")], "wire");
  sent[0].reply({ status: 409, body: { error: "changed", conflict: { rev: 9, value: rowAt(9, "why, exactly?") } }, rev: 9, epoch: "" });
  await tick();
  assert.equal(store.get<AuthoredRow[]>("authored:b1")?.[0].front, "why, really?", "the newer row stays, not the refused one");
  assert.equal(sent.length, 2, "the back this edit writes is as it was: sent again");
  assert.equal(sent[1].req.headers["If-Match"], '"11"', "over the row the room holds");
  sent[1].reply({ status: 200, body: {}, rev: 13, epoch: "" });
  await saving;
});

test("after a restore onto a backup, a refusal is taken at its lower rev and the edit settled over it", async () => {
  const { store, sent, m } = room();   // the row as read before the restore, at rev 7
  const saving = authored.update("b1", "m-1", { back: "mine" }, m, store);
  await tick();
  sent[0].reply({ status: 409, body: { error: "changed", conflict: { rev: 2, value: rowAt(2, "why, before?") } }, rev: 4, epoch: "boot-2" });
  await tick();
  assert.deepEqual([store.get<AuthoredRow[]>("authored:b1")?.[0].front, store.entry("authored:b1")?.epoch], ["why, before?", "boot-2"], "what the server holds now");
  assert.equal(sent[1].req.headers["If-Match"], '"2"');
  sent[1].reply({ status: 200, body: {}, rev: 5, epoch: "boot-2" });
  await saving;
});

// Each row's refusal is ordered by that row's own rev, not the list's.
const rowIn = (id: string, rev: number, front: string, back = "because") => ({ id, front, back, state: "closed", rev }) as unknown as AuthoredRow;
function twoRows() {
  const r = room();
  r.store.apply<AuthoredRow[]>("authored:b1", 10, [rowIn("m-A", 5, "a?"), rowIn("m-B", 6, "b?")], "wire", { epoch: "e" });
  return r;
}

test("a refusal on one row after another row's refusal raised the list's rev is still taken, by its row's own rev", async () => {
  const { store, sent, m } = twoRows();
  const a = authored.update("b1", "m-A", { back: "mine A" }, m, store).catch((e) => e);
  await tick();
  sent[0].reply({ status: 409, body: { error: "changed", conflict: { rev: 13, value: rowIn("m-A", 13, "a?", "theirs A") } }, rev: 13, epoch: "e" });
  assert.equal((await a).conflict?.rev, 13, "A's edit collides on the back it changed: said, not settled");
  assert.equal(store.entry("authored:b1")?.rev, 13, "the list's rev rose to A's; B is still as read at 10");

  const b = authored.update("b1", "m-B", { back: "mine B" }, m, store);
  await tick();
  assert.equal(sent[1].req.headers["If-Match"], '"6"');
  sent[1].reply({ status: 409, body: { error: "changed", conflict: { rev: 12, value: rowIn("m-B", 12, "b, really?") } }, rev: 12, epoch: "e" });
  await tick();
  assert.deepEqual(store.get<AuthoredRow[]>("authored:b1")?.map((r) => [r.front, r.back, r.rev]), [["a?", "theirs A", 13], ["b, really?", "because", 12]], "B as the server holds it is on screen, and A as its refusal left it");
  assert.equal(sent[2]?.req.headers["If-Match"], '"12"', "the back this edit writes is untouched there: sent again over B's rev 12");
  sent[2].reply({ status: 200, body: {}, rev: 14, epoch: "e" });
  await b;
  // and a row's refusal older than the row the list holds is still dropped, whatever the list's rev
  const late = authored.update("b1", "m-A", { front: "a, mine?" }, m, store).catch((e) => e);
  await tick();
  sent[3].reply({ status: 409, body: { error: "changed", conflict: { rev: 11, value: rowIn("m-A", 11, "a, before?") } }, rev: 11, epoch: "e" });
  await tick();
  assert.equal(store.get<AuthoredRow[]>("authored:b1")?.[0].back, "theirs A", "A's newer row stays");
  assert.equal(sent[4]?.req.headers["If-Match"], '"13"', "and the edit is settled over it");
  sent[4].reply({ status: 200, body: {}, rev: 15, epoch: "e" });
  await late;
});

// Across a restore, a row's old-epoch rev orders nothing until the board is read again.
for (const [bOld, aRev, bRev] of [[98, 40, 45], [98, 40, 30], [50, 60, 45]] as const) {
  test(`after a restore, a second row's refusal is taken whatever the row's old rev and the list's new one (B read at ${bOld}, A refused at ${aRev}, B at ${bRev})`, async () => {
    const { store, sent, m } = room();
    store.apply<AuthoredRow[]>("authored:b1", 100, [rowIn("m-A", 95, "a?"), rowIn("m-B", bOld, "b?")], "wire", { epoch: "boot-1" });
    const a = authored.update("b1", "m-A", { back: "mine A" }, m, store).catch((e) => e);
    await tick();
    sent[0].reply({ status: 409, body: { error: "changed", conflict: { rev: aRev, value: rowIn("m-A", aRev, "a?", "restored A") } }, rev: 70, epoch: "boot-2" });
    assert.equal((await a).conflict?.rev, aRev);
    assert.deepEqual([store.entry("authored:b1")?.epoch, store.entry("authored:b1")?.rev], ["boot-2", aRev], "the list is in the new epoch, B still as read before it");

    const b = authored.update("b1", "m-B", { back: "mine B" }, m, store).catch((e) => e);
    await tick();
    assert.equal(sent[1].req.headers["If-Match"], `"${bOld}"`);
    sent[1].reply({ status: 409, body: { error: "changed", conflict: { rev: bRev, value: rowIn("m-B", bRev, "b?", "restored B") } }, rev: 70, epoch: "boot-2" });
    await tick();
    assert.deepEqual(store.get<AuthoredRow[]>("authored:b1")?.map((r) => [r.back, r.rev]), [["restored A", aRev], ["restored B", bRev]], "B as the restored server holds it is on screen");
    assert.equal(sent.length, 2, `the back this edit writes changed there: said, not sent over rev ${bOld} again`);
    assert.equal((await b).conflict?.rev, bRev);
  });
}

test("a personal card's key is its draft's requestId, so the same draft saved twice is one card", () => {
  const op = authoredOps.personal({ front: "f", back: "b", source: "", requestId: "0123456789abcdef" });
  assert.equal(op.key, "0123456789abcdef");
  assert.equal(op.path, "/api/library/cards");
});
