import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { drillGradeRequest } from "../web/data/entities/grades.ts";

const dir = mkdtempSync(join(tmpdir(), "strata-drill-grades-"));
process.env.STRATA_DB = join(dir, "drill.db");
process.env.GEMINI_API_KEY = "";
process.env.STRATA_FAKE_MODEL = "1";
const { db } = await import("../server/platform/db/db.ts");
const { q } = await import("../server/features/repo.ts");
const { reviewRoutes } = await import("../server/features/review/routes.ts");
const { dispatch } = await import("../server/platform/router/router.ts");
const { seenFor, touchedFor } = await import("../server/features/progress/touched.ts");
const { reviewSchedules } = await import("../server/platform/projections.ts");
const { replayGrades } = await import("../server/features/review/ladder.ts");

const server = createServer(async (req, res) => {
  try {
    if (!await dispatch(reviewRoutes, { req, res, ssn: "tab-1", url: new URL(req.url!, "http://localhost") })) res.writeHead(404).end();
  } catch (e) { res.writeHead(500).end(String(e)); }
});
let base: string;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  q.insBoard.run("b-drill", "Drilled", "blank", 1, 1);
  for (const [id, ord] of [["c-one", 0], ["c-two", 1], ["c-three", 2]] as const)
    q.insCard.run(id, "course-a", "course-a/0-flashcard", "flashcard", JSON.stringify({ front: id, back: "b" }), ord);
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close(); rmSync(dir, { recursive: true, force: true });
});
const grade = async (body: Record<string, unknown>) => {
  const r = await fetch(base + "/api/review/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
const gradesOf = (card: string) => db.prepare("SELECT session, props FROM events WHERE event = 'card_grade' AND json_extract(props,'$.card') = ? ORDER BY id")
  .all(card).map((r) => ({ session: r.session, ...JSON.parse(String(r.props)) }));
const drill = (requestId: string, card: string, got: boolean, extra: Record<string, unknown> = {}) =>
  ({ requestId, course: "course-a", card, got, surface: "drill", board: "b-drill", solo: true, pass: 1, passes: 2, pos: 4, ms: 3200, ...extra });

test("a drill grade becomes a receipted request carrying what the log used to", () => {
  const card = { id: "c-one", deck: "course-a/0-flashcard", type: "flashcard" };
  assert.deepEqual(drillGradeRequest(card, true, { board: "b-drill", pass: 1, passes: 2, solo: true, pos: 4, ms: 3200.4 }, "req-0001"), {
    requestId: "req-0001", course: "course-a", card: "c-one", got: true,
    surface: "drill", board: "b-drill", solo: true, pass: 1, passes: 2, pos: 4, ms: 3200,
  });
  assert.deepEqual(drillGradeRequest(card, false, { board: "b-drill", pass: 0, passes: 0 }, "req-0002"), {
    requestId: "req-0002", course: "course-a", card: "c-one", got: false, surface: "drill", board: "b-drill", solo: false, pass: 0, passes: 0,
  });
  // an unkept mint question has no card to file the grade under…
  assert.equal(drillGradeRequest({ id: "mint:m1", mintId: "m1", deck: null }, true, { board: "b-drill" }, "req-0003"), null);
  // …but once kept it is a card, so the grade takes the receipted route
  assert.deepEqual(drillGradeRequest({ id: "course-a/yours/why", deck: "course-a/yours", mintId: "m1" }, true, { board: "b-drill" }, "req-0006"), {
    requestId: "req-0006", course: "course-a", card: "course-a/yours/why", got: true, surface: "drill", board: "b-drill", solo: false,
  });
  assert.equal(drillGradeRequest({ id: "mint:m2", deck: "named" }, true, { board: "b-drill" }, "req-0004"), null);
  assert.equal(drillGradeRequest(card, true, { board: null }, "req-0005"), null);
});

test("a drill grade writes one card_grade with the board and the drill's props, and no review flag", async () => {
  const before = Number(db.prepare("SELECT touched_at t FROM boards WHERE id = 'b-drill'").get()!.t);
  const r = await grade(drill("drill-save-0001", "c-one", false));
  assert.equal(r.status, 200);
  assert.equal(r.data.saved, true);
  const rows = gradesOf("c-one");
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    session: "tab-1", board: "b-drill", deck: "course-a/0-flashcard", card: "c-one", type: "flashcard", got: false,
    requestId: "drill-save-0001", solo: true, pass: 1, passes: 2, pos: 4, ms: 3200,
  });
  assert.equal("review" in rows[0], false);
  assert.ok(Number(db.prepare("SELECT touched_at t FROM boards WHERE id = 'b-drill'").get()!.t) > before);
});

test("a retried drill grade lands once; a different verdict under the same receipt is refused", async () => {
  const body = drill("drill-save-0002", "c-two", true);
  const first = await grade(body);
  assert.equal(first.status, 200);
  assert.deepEqual((await grade(body)).data, first.data);
  assert.equal((await grade({ ...body, got: false })).status, 409);
  assert.equal(gradesOf("c-two").length, 1);
});

test("every reader of a drill grade still finds it where it looked", async () => {
  await grade(drill("drill-save-0003", "c-three", true));
  assert.ok(seenFor("b-drill").done.includes("c-three"));
  assert.equal(touchedFor("b-drill")["course-a"]?.done, 3);
  assert.ok(reviewSchedules(db, replayGrades).has("c-three"));
  const history = await fetch(`${base}/api/review/history?course=course-a&card=c-three`).then((r) => r.json());
  assert.deepEqual(history.reviews, []);
  const session = await fetch(`${base}/api/review/session?since=${Date.now() - 60_000}`).then((r) => r.json());
  assert.equal(session.cards, 0);
});

test("the review's grades are written as they were", async () => {
  const r = await grade({ requestId: "review-save-0001", course: "course-a", card: "c-one", got: true, ms: 900 });
  assert.equal(r.status, 200);
  const row = gradesOf("c-one").at(-1);
  assert.equal(row.review, true);
  assert.equal("board" in row, false, "a review names no board: it must not light a board's counts");
  const history = await fetch(`${base}/api/review/history?course=course-a&card=c-one`).then((x) => x.json());
  assert.equal(history.reviews.length, 1);
});

test("a drill grade is validated before anything is written", async () => {
  const count = () => Number(db.prepare("SELECT COUNT(*) n FROM events WHERE event = 'card_grade'").get()!.n);
  const was = count();
  for (const bad of [
    drill("drill-bad-00001", "c-one", true, { board: undefined }),
    drill("drill-bad-00002", "c-one", true, { board: "../other" }),
    drill("drill-bad-00003", "c-one", true, { pass: -1 }),
    drill("drill-bad-00004", "c-one", true, { pos: 1.5 }),
    drill("drill-bad-00005", "c-one", true, { solo: "yes" }),
    drill("drill-bad-00006", "c-one", true, { surface: "cram" }),
  ]) assert.equal((await grade(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await grade(drill("drill-bad-00007", "no-such-card", true))).status, 404);
  assert.equal(count(), was);
});

test("a kept question of yours is a real card: its drill grade is receipted and reaches the ladder", async () => {
  const id = "course-a/yours/why-this";
  q.insCard.run(id, "course-a", "course-a/yours", "flashcard",
    JSON.stringify({ front: "why?", back: "because", authored: true, mintId: "m-kept", board: "b-drill", id }), -1);
  const request = drillGradeRequest({ id, deck: "course-a/yours", mintId: "m-kept" }, true, { board: "b-drill", pass: 1, passes: 1 }, "drill-yours-0001");
  assert.ok(request, "not sent through the log");
  assert.equal((await grade(request)).status, 200);
  const rows = gradesOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].board, "b-drill");
  assert.ok(reviewSchedules(db, replayGrades).has(id));
  q.delCard.run(id);
});

test("a card set aside is still graded against its tombstone from the drill, never from the review", async () => {
  const c = q.cardAny.get("c-two")!;
  q.insDrop.run(c.id, c.course, c.deck, c.type, c.payload, c.ord, Date.now());
  q.delCard.run(c.id);
  assert.equal((await grade(drill("drill-save-0004", "c-two", false))).status, 200);
  assert.equal(gradesOf("c-two").length, 2);
  assert.equal((await grade({ requestId: "review-save-0002", course: "course-a", card: "c-two", got: true })).status, 404);
});
