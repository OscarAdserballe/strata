import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeUsage } from './admin/usage-summary.mjs';
import { usagePage, activityStatus, estimatedCost } from './admin/usage-page.mjs';
import { collectRooms } from './admin/usage-collector.mjs';

const READERS = ['ada', 'ben', 'cy', 'di', 'ed'];

function fixture(db, at) {
  db.exec(`CREATE TABLE events(ts INTEGER,event TEXT,session TEXT,props TEXT);
    CREATE TABLE boards(id TEXT,title TEXT); CREATE TABLE resources(id TEXT,text TEXT);
    CREATE TABLE cards(id TEXT,payload TEXT); CREATE TABLE card_keeps(id TEXT);
    INSERT INTO boards VALUES('board-private','PRIVATE_SOURCE_TITLE');
    INSERT INTO resources VALUES('resource-private','PRIVATE_SOURCE_TEXT');
    INSERT INTO cards VALUES('card-private','PRIVATE_CARD_ANSWER'); INSERT INTO card_keeps VALUES('card-private');`);
  const add = (days, event, props = {}, session = 'PRIVATE_SESSION') => db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(at-days*864e5,event,session,JSON.stringify(props));
  add(1,'chat_turn',{promptTokens:100,outputTokens:20,thoughtsTokens:5,cachedTokens:80,question:'PRIVATE_QUESTION'});
  add(1,'distil_done',{cards:3,calls:2,promptTokens:200,outputTokens:40,thoughtsTokens:10,cachedTokens:50});
  add(1,'source_tree_done',{calls:1,promptTokens:10,outputTokens:2,thoughtsTokens:0,cachedTokens:0});
  add(1,'distil_error',{calls:1,promptTokens:50,outputTokens:4,thoughtsTokens:1,error:'PRIVATE_ERROR'});
  add(1,'card_grade',{review:true}); add(1,'card_grade',{review:false}); add(1,'card_keep');
  add(10,'distil_done',{cards:5,calls:1,promptTokens:20}); add(10,'resource_add');
  add(1,'chat_turn',{reply:'PRIVATE_REPLY'}); // old event without metering
  add(0,'request',{path:'/PRIVATE_PATH'}); add(0,'deck_open'); // prefetch does not make a user active
  add(-1,'card_grade',{review:true}); // future event excluded
  add(1,'distil_done',{cards:-12,promptTokens:'PRIVATE_INVALID',outputTokens:-5});
  db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(at,'request',null,'not json');
}

test('usage is a read-only numeric projection, with truthful windows and incomplete-metering counts', () => {
  const dir = mkdtempSync(join(tmpdir(),'strata-admin-')); const path = join(dir,'room.db');
  const at = Date.UTC(2026,8,6,12);
  const writable = new DatabaseSync(path); fixture(writable,at); writable.close();
  const db = new DatabaseSync(path,{readOnly:true});
  try {
    const result=summarizeUsage(db,at), p=result.periods['7'];
    assert.equal(p.activeDays,1); assert.equal(p.browserSessions,1);
    assert.equal(p.cardsGenerated,3); assert.equal(result.periods.all.cardsGenerated,8);
    assert.equal(p.recordedApiCalls,5); assert.equal(p.promptTokens,360);
    assert.equal(p.outputTokens,66); assert.equal(p.thoughtsTokens,16); assert.equal(p.cachedTokens,130);
    assert.equal(p.unmeteredOperations,2); assert.equal(p.distillationErrors,1);
    assert.equal(p.cardsGraded,2); assert.equal(p.reviewAnswers,1);
    assert.equal(result.lastActiveAt,at-864e5);
    assert.deepEqual({...result.inventory},{boards:1,sources:1,cards:1,keptCards:1});
    assert.equal(JSON.stringify(result).includes('PRIVATE_'),false);
    assert.throws(()=>db.exec("DELETE FROM boards"),/readonly/);
    const html=usagePage({at,rooms:[{reader:'ben',status:'ok',...result},{reader:'ed',status:'unavailable'}]},'all');
    assert.equal(html.includes('PRIVATE_'),false); assert.match(html,/missing data is not zero usage/);
    assert.match(html,/recorded usage totals, not a complete bill/);
  } finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('activity uses a five-minute window, exact UTC times, and distinguishes missing or stale data', () => {
  const at = Date.UTC(2026,8,6,12);
  assert.equal(activityStatus(at-299_999, at).label, 'Active recently');
  assert.equal(activityStatus(at-300_000, at).recent, true);
  assert.equal(activityStatus(at-300_001, at).label, 'Inactive');
  assert.equal(activityStatus(null, at).label, 'No activity logged');
  assert.equal(activityStatus(at-60_000, at).relative, '1 minute ago');
  assert.equal(activityStatus(at-3600_000, at).relative, '1 hour ago');
  assert.equal(activityStatus(at-86400_000, at).relative, '1 day ago');
  assert.equal(activityStatus(at, at).exact, '2026-09-06 12:00:00 UTC');
  const db = new DatabaseSync(':memory:'); fixture(db, at);
  const room = { reader: 'ben', status: 'ok', ...summarizeUsage(db, at), lastActiveAt: at };
  db.close();
  const current = usagePage({at,rooms:[room]},'7',{now:at});
  assert.match(current,/Active recently/); assert.match(current,/Just now/);
  assert.match(current,/http-equiv="refresh" content="60"/);
  const stale = usagePage({at,rooms:[room]},'7',{now:at+121_000});
  assert.match(stale,/Snapshot delayed/); assert.match(stale,/Status unknown/);
  assert.doesNotMatch(stale,/>Active recently</);
});

test('rooms are read one database at a time, as numbers only; a missing database is unavailable', () => {
  const dir=mkdtempSync(join(tmpdir(),'strata-rooms-')), path=join(dir,'strata.db');
  const at=Date.now(), db=new DatabaseSync(path); fixture(db,at); db.close();
  try {
    const rooms=collectRooms([{reader:'ben',db:path},{reader:'cy',db:join(dir,'missing.db')}]);
    assert.equal(rooms[0].status,'ok'); assert.equal(rooms[0].reader,'ben'); assert.ok(rooms[0].periods.all.cardsGraded>0);
    assert.deepEqual(rooms[1],{reader:'cy',status:'unavailable'});
    assert.equal(JSON.stringify(rooms).includes('PRIVATE_'),false);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('estimated cost discounts cached input once and bills thinking as output', () => {
  assert.equal(estimatedCost({promptTokens:1e6,cachedTokens:800_000,outputTokens:100_000,thoughtsTokens:20_000}),0.66);
  assert.equal(estimatedCost({promptTokens:1e6,cachedTokens:0,outputTokens:0,thoughtsTokens:0}),0.75);
  assert.equal(estimatedCost({promptTokens:100,cachedTokens:200,outputTokens:0,thoughtsTokens:0}),0.0000075);
  assert.equal(estimatedCost({promptTokens:0,cachedTokens:0,outputTokens:0,thoughtsTokens:0}),0);
});

test('every room is included in each period, with per-reader and total cost', () => {
  const at=Date.now(), db=new DatabaseSync(':memory:'); fixture(db,at);
  const result=summarizeUsage(db,at); db.close();
  for (const key of ['7','30','all']) Object.assign(result.periods[key], {
    promptTokens:1e6,cachedTokens:800_000,outputTokens:100_000,thoughtsTokens:20_000,
  });
  result.periods.all.outputTokens=200_000;
  const data={at,rooms:READERS.map((reader)=>({reader,status:'ok',...result}))};
  for (const period of ['7','30','all']) {
    const html=usagePage(data,period);
    assert.match(html,/5 rooms, at a glance/); assert.match(html,/5 \/ 5 rooms reporting/);
    assert.match(html,/<td class="name">ada/); assert.doesNotMatch(html,/room\(s\) unavailable/);
    assert.match(html,/<th>Est. cost \(USD\)<\/th>/);
    assert.match(html,period==='all' ? /<strong>\$5\.18<\/strong>/ : /<strong>\$3\.30<\/strong>/);
    assert.match(html,period==='all' ? /<td>\$1\.04<\/td>/ : /<td>\$0\.66<\/td>/);
    assert.match(html,/fixed rate card/); assert.match(html,/10 logged operations lack token metadata/);
  }
  const unavailable=usagePage({at,rooms:READERS.map((reader)=>({reader,status:'unavailable'}))},'7');
  assert.match(unavailable,/0 of 5 readers/); assert.match(unavailable,/Estimated AI cost<\/span><strong>—/);
});
