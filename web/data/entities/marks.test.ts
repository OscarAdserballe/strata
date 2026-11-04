import { test } from "node:test";
import assert from "node:assert/strict";
import type { Mark } from "../../../shared/types/index.ts";
import { Store } from "../store.ts";
import { Mutator, type SendAnswer, type SendRequest } from "../mutate.ts";
import { markOps, newMarkId } from "./marks.ts";

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
function room() {
  const store = new Store();
  const sent: { req: SendRequest; reply: (a: SendAnswer) => void }[] = [];
  const m = new Mutator({
    store,
    transport: (req) => new Promise<SendAnswer>((resolve) => sent.push({ req, reply: resolve })),
    setTimer: () => 0, clearTimer: () => {},
  });
  store.apply<Mark[]>("marks:b1", 3, [], "wire");
  return { store, sent, m };
}
const draft = { resourceId: "r1", page: 2, start: 10, end: 20, quote: "a passage", rects: [[0, 0, 1, 1]] };

test("a mark's client id is its identity; a note and a delete wait behind it in its lane", async () => {
  const { store, sent, m } = room();
  const id = newMarkId();
  assert.match(id, /^mk-[0-9a-f]{16}$/);
  const making = m.mutate(markOps.create("b1", { ...draft, id }, () => 42));
  const noting = m.mutate(markOps.note("b1", id, "why this matters"));
  const removing = m.mutate(markOps.remove("b1", id, false, store));
  assert.deepEqual(store.get<Mark[]>("marks:b1")?.map((x) => x.id), [], "painted, noted and removed on screen at once");
  assert.equal(store.entry<Mark[]>("marks:b1")?.layers.length, 3);
  assert.equal(sent.length, 1, "only the create is on the wire");
  assert.match(sent[0].req.headers["Idempotency-Key"], /^[0-9a-f]{32}$/, "a key of the op's own, not the mark id");
  assert.deepEqual(JSON.parse(sent[0].req.body!), { ...draft, id });
  const saved: Mark = { ...draft, id, note: null, createdAt: 42 };
  sent[0].reply({ status: 200, body: { id, mark: saved, rev: 4 }, rev: 4, epoch: "" });
  await making;
  await tick();
  assert.equal(sent[1].req.method, "PATCH", "the note went after the create's answer");
  assert.equal(sent[1].req.path, `/api/boards/b1/marks/${id}`);
  sent[1].reply({ status: 200, body: { mark: { ...saved, note: "why this matters" }, rev: 5 }, rev: 5, epoch: "" });
  await noting;
  await tick();
  assert.equal(sent[2].req.method, "DELETE");
  assert.deepEqual(store.entry<Mark[]>("marks:b1")?.base?.map((x) => x.note), ["why this matters"], "the confirmed rows, by shape");
  sent[2].reply({ status: 200, body: { ok: true, id, rev: 6 }, rev: 6, epoch: "" });
  await removing;
  assert.deepEqual(store.entry<Mark[]>("marks:b1")?.base, [], "the delete's answer drops the row");
  assert.equal(store.entry("marks:b1")?.rev, 6);
  assert.deepEqual(m.pending(), []);
});

test("a refused highlight is taken back off the page", async () => {
  const { store, sent, m } = room();
  const making = m.mutate(markOps.create("b1", draft)).catch((e) => e);
  assert.equal(store.get<Mark[]>("marks:b1")?.length, 1);
  sent[0].reply({ status: 409, body: { error: "that id names another passage" }, rev: 0, epoch: "" });
  assert.equal((await making).status, 409);
  assert.deepEqual(store.get("marks:b1"), []);
  assert.equal(markOps.remove("b1", "mk-1", true).path, "/api/boards/b1/marks/mk-1?undo=1", "an undo says so to the log");
  assert.equal(markOps.note("b1", "mk-1", null).flush, true);
});

test("create, delete, create again under the same mark id: three ops, three keys, the row back", async () => {
  const { store, sent, m } = room();
  const id = newMarkId();
  const saved: Mark = { ...draft, id, note: null, createdAt: 42 };
  const making = m.mutate(markOps.create("b1", { ...draft, id }, () => 42));
  sent[0].reply({ status: 201, body: { id, mark: saved, rev: 4 }, rev: 4, epoch: "" });
  await making;
  const undoing = m.mutate(markOps.remove("b1", id, true, store));
  await tick();
  sent[1].reply({ status: 200, body: { ok: true, id, rev: 5 }, rev: 5, epoch: "" });
  await undoing;
  assert.deepEqual(store.get<Mark[]>("marks:b1"), [], "undone");
  const redoing = m.mutate(markOps.create("b1", { ...draft, id }, () => 43));
  await tick();
  assert.equal(sent.length, 3);
  const keys = sent.map((s) => s.req.headers["Idempotency-Key"]);
  assert.equal(new Set(keys).size, 3, `every op its own key (${keys.join(", ")})`);
  assert.ok(!keys.includes(id), "the mark id is never the key: a redo must not replay the first create's receipt");
  assert.equal(JSON.parse(sent[2].req.body!).id, id, "the same mark id, in the body");
  assert.deepEqual(store.get<Mark[]>("marks:b1")?.map((x) => x.id), [id], "painted again at once");
  sent[2].reply({ status: 201, body: { id, mark: { ...saved, createdAt: 43 }, rev: 6 }, rev: 6, epoch: "" });
  await redoing;
  assert.deepEqual(store.entry<Mark[]>("marks:b1")?.base?.map((x) => x.id), [id], "the redo's row is the base");
});

test("a reply waits in its note's lane, and a confirmed reply stays in the mark once its optimistic copy is gone", async () => {
  const { store, sent, m } = room();
  const id = newMarkId();
  const making = m.mutate(markOps.create("b1", { ...draft, id, note: "a note" }, () => 42));
  const replying = m.mutate(markOps.reply("b1", id, "mr-00000001ab12cd34", "  and why  ", () => 50, store));
  assert.deepEqual(store.get<Mark[]>("marks:b1")?.[0].replies?.map((r) => r.text), ["and why"], "shown at once");
  assert.equal(sent.length, 1, "the reply waits for the note it answers");
  sent[0].reply({ status: 201, body: { id, mark: { ...draft, id, note: "a note", createdAt: 42 }, rev: 4 }, rev: 4, epoch: "" });
  await making;
  await tick();
  assert.equal(sent[1].req.path, `/api/boards/b1/marks/${id}/replies`);
  sent[1].reply({ status: 201, body: { reply: { id: "mr-00000001ab12cd34", author: "you", text: "and why", at: 51 }, rev: 5 }, rev: 5, epoch: "" });
  await replying;
  await tick();
  const entry = store.entry<Mark[]>("marks:b1");
  assert.equal(entry?.layers.length, 0, "no optimistic copy left");
  assert.deepEqual(store.get<Mark[]>("marks:b1")?.[0].replies, [{ id: "mr-00000001ab12cd34", author: "you", text: "and why", at: 51 }]);
});
