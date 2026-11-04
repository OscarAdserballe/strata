import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayGrades, type GradeRow } from "../features/review/ladder.ts";
import { reviewSchedules } from "./projections.ts";
const dir = mkdtempSync(join(tmpdir(), "strata-projections-"));
process.env.STRATA_DB = join(dir, "room.db");
const { db } = await import("./db/db.ts");
const { q } = await import("../features/repo.ts");
after(() => { db.close(); rmSync(dir, { recursive:true, force:true }); });
const event = db.prepare("INSERT INTO events(ts,app,event,props) VALUES (?,'strata',?,?)");
const add = (type: string, props: unknown, at=1) => event.run(at,type,JSON.stringify(props));
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("incremental progress matches the complete fold after append, edit, deletion and reset", () => {
  const expected = () => plain(db.prepare(`SELECT json_extract(props,'$.resource') resource,
    MAX(COALESCE(json_extract(props,'$.deepest'),json_extract(props,'$.pct'),0)) deepest,
    SUM(COALESCE(json_extract(props,'$.ms'),0)) ms,MAX(ts) at FROM events
    WHERE event='read_progress' AND json_extract(props,'$.resource') IS NOT NULL GROUP BY resource`).all());
  const compare = () => assert.deepEqual(plain(q.readProgressAll.all()),expected());
  add("read_progress",{board:"a",resource:"r",deepest:35,ms:20},20); compare();
  add("read_progress",{board:"b",resource:"r",pct:70,ms:10},10); compare();
  const last = add("read_progress",{board:"a",resource:"r",deepest:25,ms:4},30); compare();
  assert.equal(q.lastReadOf.get("a")?.deepest,25);
  add("resource_view",{board:"a",resource:"r"},50);
  assert.deepEqual(plain(q.readViewsAll.all()),[{resource:"r",at:50}]);
  db.prepare("UPDATE events SET props=? WHERE id=?").run('{"resource":"r","deepest":90,"ms":8}',last.lastInsertRowid); compare();
  db.prepare("DELETE FROM events WHERE id=?").run(last.lastInsertRowid); compare();
  db.exec("DELETE FROM events"); compare();
  add("read_progress",{board:"a",resource:"r",deepest:10,ms:2},1); compare();
});

test("card progress counts unique live cards and follows deletion/restoration", () => {
  q.upsertCourse.run("c","Cards","{}",1);
  for (const id of ["c/1","c/2"]) q.insCard.run(id,"c","c/deck","flashcard","{}",1);
  for (let i=0;i<10;i++) add("card_show",{board:"a",card:"c/1"});
  add("card_show",{board:"a",card:"c/2"}); add("card_grade",{board:"a",card:"c/1",got:false});
  add("bench_open",{deck:"c"});
  assert.deepEqual(plain(q.deckSeenOf.all("a")),[{slug:"c",n:2}]);
  assert.equal(q.deckLastOf.all("a")[0].card,"c/2");
  assert.deepEqual(plain(q.deckDoneOf.all("a")),[{slug:"c",n:1}]);
  assert.deepEqual(plain(q.benchedDecks.all()),[{deck:"c"}]);
  q.delCard.run("c/2"); assert.equal(q.deckSeenAll.all()[0].n,1);
  q.insCard.run("c/2","c","c/deck","flashcard","{}",1); assert.equal(q.deckSeenAll.all()[0].n,2);
});

test("cached schedules are identical to replay for corrections, reviews, keeps and historical changes", () => {
  const compare = () => {
    const kept = new Map(q.keptAll.all().map(r=>[r.id,r.created_at]));
    assert.deepEqual([...reviewSchedules(db, replayGrades)].sort(),[...replayGrades(q.gradeEvents.all() as GradeRow[],kept)].sort());
  };
  compare();
  q.insKeep.run("c/1","c","c/deck",1); compare();
  add("card_answer",{card:"c/1",hit:false},86400000*3); compare();
  const grade = add("card_grade",{card:"c/1",got:true},86400000*3+1000); compare();
  add("card_grade",{card:"c/1",got:false,review:true},86400000*5); compare();
  add("card_grade",{card:"c/1",got:true,review:true},86400000*5+2000); compare();
  db.prepare("UPDATE events SET props=? WHERE id=?").run('{"card":"c/1","got":false}',grade.lastInsertRowid); compare();
  db.prepare("DELETE FROM events WHERE id=?").run(grade.lastInsertRowid); compare();
  q.delKeep.run("c/1"); compare();
  q.delCard.run("c/1"); compare();
  q.insCard.run("c/1","c","c/deck","flashcard","{}",1); compare();
});
