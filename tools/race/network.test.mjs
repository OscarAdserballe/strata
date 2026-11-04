// A failing seed must fail again when handed back, or the race gate is a flake generator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hash32, rngFor, pick, pathKey, Net, cappedOn, wireOf } from "./network.mjs";

test("a seed and a label always draw the same numbers, and different seeds draw different ones", () => {
  const draw = (seed, label) => { const r = rngFor(seed, label); return [r(), r(), r()]; };
  assert.deepEqual(draw(7, "POST /api/log card_grade#3"), draw(7, "POST /api/log card_grade#3"));
  assert.notDeepEqual(draw(7, "POST /api/log card_grade#3"), draw(8, "POST /api/log card_grade#3"));
  assert.notDeepEqual(draw(7, "POST /api/log card_grade#3"), draw(7, "POST /api/log card_grade#4"));
  for (const v of draw(1, "x")) assert.ok(v >= 0 && v < 1);
  assert.equal(hash32("strata"), hash32("strata"));
});

test("pick chooses k distinct indices in 1..n, the same ones for the same dice", () => {
  const a = pick(rngFor(3, "victims"), 6, 3), b = pick(rngFor(3, "victims"), 6, 3);
  assert.deepEqual([...a], [...b]);
  assert.equal(a.size, 3);
  for (const i of a) assert.ok(Number.isInteger(i) && i >= 1 && i <= 6);
  assert.equal(pick(rngFor(3, "victims"), 2, 5).size, 2, "never more than there are");
});

test("a request's key blanks its ids, so runs with different ids draw alike", () => {
  assert.equal(pathKey("/api/boards/b-1a2b3c4d/marks"), "/api/boards/:id/marks");
  assert.equal(pathKey("/api/boards/b-9f8e7d6c/plan/milestones/ms-00aa11bb"), "/api/boards/:id/plan/milestones/:id");
  assert.equal(pathKey("/api/review/grade"), "/api/review/grade");
});

test("drop and lostAck each count every match, so 'the 2nd grade' is the 2nd sent even after a drop", () => {
  const grade = { match: (e) => e.event === "card_grade" };
  const net = new Net(1, { drop: { ...grade, pick: new Set([1, 4]) }, lostAck: { ...grade, pick: new Set([2, 3]) } }, () => {});
  const fates = [1, 2, 3, 4, 5].map((n) => net.fate({ write: true, event: "card_grade", key: "POST /api/log card_grade", n }));
  assert.deepEqual(fates.map((f) => (f.dropped ? "drop" : f.lost ? "lost" : "ok")), ["drop", "lost", "lost", "drop", "ok"]);
  // reads and other events are never victims, and do not move the count
  assert.deepEqual(net.fate({ write: false, event: "card_grade", key: "GET /x", n: 1 }), { dropped: false, lost: false });
});

// a stand-in for Playwright's route/request pair that answers when its gate opens
function fakeRoute(log, name, gate = null) {
  return {
    fetch: async () => { log.push(`in ${name}`); await gate; log.push(`answered ${name}`); return { status: () => 200, body: async () => Buffer.from("{}") }; },
    fulfill: async () => {}, abort: async () => {}, fallback: async () => {},
  };
}
const fakeRequest = (method, path, body = null) => ({ url: () => `http://room.test${path}`, method: () => method, headers: () => ({}), postDataJSON: () => body });

test("the server sees writes in the order the page sent them, and reads after the writes before them", async () => {
  const net = new Net(1, {}, () => {}), log = [];
  let open;
  const first = new Promise((r) => { open = r; });
  const move = "/api/boards/b-1/plan/milestones/m-1";
  const sent = [
    net.handle(fakeRoute(log, "move 1", first), fakeRequest("PATCH", move, { move: 1 })),
    net.handle(fakeRoute(log, "move 2"), fakeRequest("PATCH", move, { move: 1 })),
    net.handle(fakeRoute(log, "read"), fakeRequest("GET", "/api/boards/b-1")),
  ];
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(log, ["in move 1"], "nothing overtakes a write the server has not answered");
  open();
  await Promise.all(sent);
  assert.deepEqual(log, ["in move 1", "answered move 1", "in move 2", "answered move 2", "in read", "answered read"]);
});

test("reads among themselves still go in parallel", async () => {
  const net = new Net(1, {}, () => {}), log = [];
  let open;
  const gate = new Promise((r) => { open = r; });
  const sent = [
    net.handle(fakeRoute(log, "board", gate), fakeRequest("GET", "/api/boards/b-1")),
    net.handle(fakeRoute(log, "decks", gate), fakeRequest("GET", "/api/decks")),
  ];
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(log, ["in board", "in decks"]);
  open();
  await Promise.all(sent);
});

test("reorder does not wait on a later write a scenario has parked in a hold", async () => {
  const net = new Net(1, { reorder: { writes: true, window: 0 } }, () => {}), log = [];
  const save = "/api/boards/b-1/notes";
  const held = net.hold((e) => e.id === 2);
  const first = net.handle(fakeRoute(log, "save 1"), fakeRequest("PUT", save, { text: "a" }));
  const second = net.handle(fakeRoute(log, "save 2"), fakeRequest("PUT", save, { text: "ab" }));
  await held.arrived(1, 2000);
  const delivered = await Promise.race([first.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
  assert.equal(delivered, true, "the first save's answer lands while the second is parked");
  held.release();
  await second;
  net.close();
});

test("a retry under a receipt the wire already judged goes through", () => {
  const net = new Net(1, { drop: { match: () => true, pick: new Set([1]), key: (e) => e.body.requestId } }, () => {});
  const send = (requestId, n) => net.fate({ write: true, body: { requestId }, key: "POST /api/cards/grade", n }).dropped;
  assert.equal(send("r-1", 1), true, "the first send of r-1 is the victim");
  assert.equal(send("r-1", 2), false, "its retry passes");
  assert.equal(send("r-2", 3), false, "and the next grade is the 2nd match, not a second victim");
});

test("lostAck with a status forwards the write, then answers the page with that status", async () => {
  const net = new Net(1, { lostAck: { match: () => true, pick: new Set([1]), status: 400 } }, () => {}), log = [];
  const answers = [];
  const route = (name) => ({ ...fakeRoute(log, name), fulfill: async (a) => { answers.push(a.status ?? a.response.status()); }, abort: async () => { answers.push("aborted"); } });
  await net.handle(route("create 1"), fakeRequest("POST", "/api/boards/b-1/minted", { front: "a" }));
  await net.handle(route("create 2"), fakeRequest("POST", "/api/boards/b-1/minted", { front: "a" }));
  assert.deepEqual(log, ["in create 1", "answered create 1", "in create 2", "answered create 2"], "both reach the server");
  assert.deepEqual(answers, [400, 200], "the first is answered 400, not aborted; the second passes");
  assert.deepEqual(net.entries.map((e) => [e.outcome, e.status]), [["lost-ack", 200], ["ok", 200]]);
});

test("a hold that ran out on a second tab's shim is the trial's, and so is its wire", () => {
  // two tabs, each behind its own shim; the hold that pins the race is on the second
  const first = new Net(1, {}, () => {}), second = new Net(1001, {}, () => {});
  first.entries.push({ method: "GET", path: "/api/boards/b-1", outcome: "ok", capped: false });
  second.entries.push({ method: "PATCH", path: "/api/boards/b-1/resources/r-1", outcome: "ok", capped: false },
    { method: "PUT", path: "/api/boards/b-1/notes", outcome: "error", capped: false });
  assert.deepEqual(cappedOn([first, second]), [], "nothing ran out");
  second.capped(second.entries[0], "net.hold");
  assert.deepEqual(cappedOn([first, second]).map((e) => e.method), ["PATCH"], "the second tab's hold is judged too");
  assert.deepEqual(cappedOn([null, second]).length, 1, "a trial with no first shim still judges the rest");
  assert.deepEqual(wireOf([first, second]), { ok: 2, error: 1 });
  assert.deepEqual(wireOf([null]), {});
});
