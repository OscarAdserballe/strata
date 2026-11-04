import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "strata-library-"));
process.env.STRATA_DB = join(dir, "library.db");
process.env.GEMINI_API_KEY = "";
process.env.STRATA_FAKE_MODEL = "1";
const { db } = await import("../../server/platform/db/db.ts");
const { q } = await import("../../server/features/repo.ts");
const { libraryRoutes } = await import("../../server/features/library/routes.ts");
const { reviewRoutes } = await import("../../server/features/review/routes.ts");
const { chatRoutes } = await import("../../server/features/ask/routes.ts");
const { dispatch } = await import("../../server/platform/router/router.ts");
const server = createServer(async (req, res) => {
  try {
    if (!await dispatch([...libraryRoutes, ...reviewRoutes, ...chatRoutes], {
      req, res, ssn: null, url: new URL(req.url!, "http://localhost"),
    })) res.writeHead(404).end();
  } catch (e) { res.writeHead(500).end(String(e)); }
});
let base: string;
before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); rmSync(dir, { recursive: true, force: true });
});
const call = async (path: string, body?: unknown) => {
  const res = await fetch(base + path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};

test("conversation pages are bounded, ordered and isolated from other sources", async () => {
  q.insBoard.run("paged","Paged","blank",1,1);
  for(let i=0;i<205;i++) q.insMsg.run("paged",null,"user",`Message ${i}`,null,"[]",i,1);
  const first=(await call("/api/boards/paged/messages")).data;
  assert.equal(first.messages.length,100); assert.equal(first.before,105);
  const second=(await call(`/api/boards/paged/messages?before=${first.before}`)).data;
  assert.equal(second.messages.length,100); assert.equal(second.before,5);
  const last=(await call(`/api/boards/paged/messages?before=${second.before}`)).data;
  assert.equal(last.messages.length,5); assert.equal(last.before,null);
  assert.deepEqual([...last.messages,...second.messages,...first.messages].map(m=>m.idx),Array.from({length:205},(_,i)=>i));
  assert.equal((await call("/api/boards/paged/messages?resource=absent")).status,404);
});

test("clearing a conversation while its first reply streams cannot resurrect that reply", async () => {
  q.insBoard.run("cleared","Cleared","blank",1,1);
  const response=await fetch(base+"/api/boards/cleared/chat",{method:"POST",headers:{"Content-Type":"application/json",Accept:"text/event-stream"},body:JSON.stringify({message:"A slow reply"})});
  assert.equal((await fetch(base+"/api/boards/cleared/messages",{method:"DELETE"})).status,200);
  const stream=await response.text();
  assert.match(stream,/event: error/); assert.doesNotMatch(stream,/event: done/);
  assert.equal(q.threadOf.all("cleared",null,null).length,0);
});


test("a source-free quote becomes a durable authored card, enrolled once even if save is retried", async () => {
  const before = await call("/api/library");
  assert.deepEqual(before.data, { messages: [], cards: [], before:null });
  assert.equal(q.board.get("inbox"), undefined, "reading home must not create a board");
  const body = { front: "What is worth remembering?", back: "A favourite quote.", source: "My notebook", requestId: "quote-save-0001" };
  const first = await call("/api/library/cards", body);
  assert.equal(first.status, 201);
  const second = await call("/api/library/cards", body);
  assert.equal(second.data.id, first.data.id);
  const saved = q.cardAny.get(first.data.id)!;
  assert.equal(saved.course, "strata-personal-cards");
  assert.equal(JSON.parse(saved.payload).back, body.back);
  assert.ok(q.keep.get(saved.id));
  assert.equal(q.cardsOf.all(saved.course).length, 1);
  assert.equal(q.pairsOf.all("inbox").length, 0, "a quote does not invent a source or pair");
  assert.equal((await call("/api/library")).data.cards[0].source, body.source);
  assert.equal((await call("/api/library/cards", { ...body, back: "Different" })).status, 409);
  assert.equal((await call("/api/library/cards", { ...body, back: " " })).status, 400);
});

test("home chat persists independently of resource conversations", async () => {
  q.insMsg.run("inbox", "some-resource", "user", "A private source thread", null, "[]", 0, Date.now());
  const response = await call("/api/boards/inbox/chat", { message: "Help me understand this quote", here: { onHome: true } });
  assert.equal(response.status, 200);
  const home = await call("/api/library");
  assert.equal(home.data.messages.length, 2);
  assert.equal(home.data.messages[0].text, "Help me understand this quote");
  assert.ok(home.data.messages.every((m: { text: string }) => m.text !== "A private source thread"));
});

test("history shows original addition, review enrolment and only this card's review verdicts", async () => {
  const card = q.cardsOf.all("strata-personal-cards")[0];
  const event = db.prepare("INSERT INTO events(ts,app,event,props) VALUES (?,'strata',?,?)");
  const t = Date.now() - 10_000;
  event.run(t, "card_grade", JSON.stringify({ card: card.id, got: false, review: true }));
  event.run(t + 1000, "card_grade", JSON.stringify({ card: card.id, got: true, review: true }));
  event.run(t + 2000, "card_answer", JSON.stringify({ card: card.id, hit: true, review: true }));
  event.run(t + 3000, "card_grade", JSON.stringify({ card: card.id, got: true }));
  event.run(t + 4000, "card_grade", JSON.stringify({ card: "another-card", got: true, review: true }));
  const result = await call(`/api/review/history?course=strata-personal-cards&card=${encodeURIComponent(card.id)}`);
  assert.equal(result.status, 200);
  assert.ok(result.data.addedAt > 0);
  assert.ok(result.data.keptAt >= result.data.addedAt);
  assert.deepEqual(result.data.reviews, [{ at: t + 1000, got: true }, { at: t, got: false }]);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT ts FROM events WHERE event = 'card_grade' AND json_extract(props, '$.card') = ? ORDER BY ts DESC, id DESC").all(card.id);
  assert.match(JSON.stringify(plan), /events_card_grades/);
  assert.equal((await call(`/api/review/history?course=wrong&card=${encodeURIComponent(card.id)}`)).status, 404);
});

test("review persistence acknowledges exactly one verdict and rolls back on a write failure", async () => {
  const card = q.cardsOf.all("strata-personal-cards")[0];
  const body = { requestId: "review-save-0001", course: "strata-personal-cards", card: card.id, got: true };
  const first = await call("/api/review/grade", body);
  assert.equal(first.status, 200);
  assert.deepEqual((await call("/api/review/grade", body)).data, first.data);
  assert.equal((await call("/api/review/grade", { ...body, got: false })).status, 409);
  const count = () => db.prepare("SELECT COUNT(*) n FROM events WHERE json_extract(props,'$.requestId') = ?").get(body.requestId)!.n;
  assert.equal(count(), 1);
  db.exec("CREATE TEMP TRIGGER fail_review BEFORE INSERT ON events WHEN NEW.event = 'card_grade' BEGIN SELECT RAISE(ABORT, 'disk failed'); END");
  const failed = { ...body, requestId: "review-save-0002" };
  const response = await fetch(base + "/api/review/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(failed) });
  assert.equal(response.status, 500);
  assert.equal(db.prepare("SELECT id FROM review_receipts WHERE id = ?").get(failed.requestId), undefined);
  db.exec("DROP TRIGGER fail_review");
  assert.equal((await call("/api/review/grade", failed)).status, 200);
});

test("recreating a personal card after deletion does not inherit its history or tombstone", async () => {
  const draft={front:"Same words",back:"Different encounters",requestId:"personal-old-draft"};
  const first=(await call("/api/library/cards",draft)).data;
  await call("/api/review/grade",{requestId:"personal-old-grade",course:"strata-personal-cards",card:first.id,got:false});
  const old=q.cardAny.get(first.id)!;
  q.insDrop.run(old.id,old.course,old.deck,old.type,old.payload,old.ord,Date.now());
  q.delCard.run(first.id);
  const second=(await call("/api/library/cards",{...draft,requestId:"personal-new-draft"})).data;
  assert.notEqual(second.id,first.id);
  const history=(await call(`/api/review/history?course=strata-personal-cards&card=${encodeURIComponent(second.id)}`)).data;
  assert.deepEqual(history.reviews,[]);
  q.applyDrops.run(); assert.ok(q.cardAny.get(second.id));
  q.delCard.run(second.id); q.delKeep.run(first.id); q.delKeep.run(second.id);
});

