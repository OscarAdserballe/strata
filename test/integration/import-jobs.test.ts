import {test,before,after} from 'node:test';
import { freePort } from "../support/free-port.ts";
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {importStore} from '../../server/features/imports/store.ts';
import {ensureImports} from '../../server/platform/db/schema.ts';
import {stopServer} from '../support/stop-server.ts';
import {book} from '../../tools/fixture-pdf.mjs';

test('upload chunks are atomic, idempotent, bounded, and enforce transitions',()=>{
  const db=new DatabaseSync(':memory:');ensureImports(db);const store=importStore(db);
  try {
    store.create('upload-test','b','test.pdf',6);
    assert.throws(()=>store.create('upload-test','other','test.pdf',6),/different file/);
    assert.throws(()=>store.transition('upload-test','uploading','imported'),/invalid import transition/);
    assert.throws(()=>store.transition('upload-test','uploading','stored'),/incomplete upload/);
    assert.equal(store.chunk('upload-test',0,Buffer.from('abc')).received,3);
    assert.equal(store.chunk('upload-test',0,Buffer.from('abc')).received,3);
    assert.throws(()=>store.chunk('upload-test',0,Buffer.from('bad')),/differs/);
    assert.throws(()=>store.chunk('upload-test',4,Buffer.from('de')),/offset changed/);
    assert.throws(()=>store.chunk('upload-test',3,Buffer.from('defg')),/Invalid upload chunk/);
    assert.equal(store.chunk('upload-test',3,Buffer.from('def')).received,6);
    assert.equal(store.bytes('upload-test').toString(),'abcdef');
    store.transition('upload-test','uploading','stored');store.transition('upload-test','stored','extracting');
    store.recover();assert.equal(store.get('upload-test')!.stage,'stored');
    store.transition('upload-test','stored','cancelled');
    assert.throws(()=>store.chunk('upload-test',0,Buffer.from('abc')),/already finished/);
  } finally{db.close();}
});

const dir=mkdtempSync(join(tmpdir(),'strata-import-test-'));
const dbPath=join(dir,'strata.db');
let server:ChildProcess;let base:string;let logs='';
const port=await freePort();base=`http://127.0.0.1:${port}`;
async function boot(){
  server=spawn(process.execPath,['server/main.ts'],{env:{...process.env,STRATA_PORT:String(port),STRATA_OPEN:'1',STRATA_DB:dbPath,STRATA_DATA:dir,GEMINI_API_KEY:'',STRATA_MIN_SECTION_WORDS:'1'},stdio:['ignore','pipe','pipe']});
  server.stdout!.on('data',data=>{logs+=data;});server.stderr!.on('data',data=>{logs+=data;});
  // a deadline, not a count of tries: a loaded machine boots slowly, and a dead server says so at once
  for(const end=Date.now()+60_000;Date.now()<end&&server.exitCode===null;){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,50));}
  throw new Error(`the import test server did not come up (exit ${server.exitCode})\n${logs}`);
}
const request=async(path:string,method='GET',body?:unknown)=>{
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;
};
async function waitStage(id:string,stage:string){
  for(const end=Date.now()+120_000;Date.now()<end;) {const {import:row}=await request(`/api/imports/${id}`);if(row.stage===stage)return row;if(row.stage==='error'&&stage!=='error')throw new Error(row.error+'\n'+logs);await new Promise(r=>setTimeout(r,50));}
  throw new Error(`Timed out waiting for ${stage}\n${logs}`);
}
async function send(id:string,offset:number,bytes:Uint8Array){
  const response=await fetch(`${base}/api/imports/${id}/bytes?offset=${offset}`,{method:'PUT',body:Buffer.from(bytes)});
  assert.equal(response.status,200);return response.json();
}
before(boot);after(async()=>{if(server)await stopServer(server);rmSync(dir,{recursive:true,force:true});});

test('book resumes across restart, grouping survives, finalization is exactly once',async()=>{
  const {board}=await request('/api/boards','POST',{title:'Durable imports'});
  const id=randomUUID(),bytes=Buffer.from(book().bytes);
  await request('/api/imports','POST',{id,board:board.id,filename:'Russell test.pdf',size:bytes.length});
  const midpoint=Math.floor(bytes.length/2);
  await send(id,0,bytes.subarray(0,midpoint));
  await stopServer(server);await boot();
  assert.equal((await request(`/api/imports/${id}`)).import.received,midpoint);
  await send(id,0,bytes.subarray(0,midpoint));
  await send(id,midpoint,bytes.subarray(midpoint));
  await request(`/api/imports/${id}/complete`,'POST');
  await waitStage(id,'awaiting_groups');
  await stopServer(server);await boot();
  const choice=await request(`/api/imports/${id}/groups`);
  assert.ok(choice.outline.length>1);
  const textId=randomUUID(),text=Buffer.from('A short readable source.');
  await request('/api/imports','POST',{id:textId,board:board.id,filename:'second.txt',size:text.length});
  await send(textId,0,text);await request(`/api/imports/${textId}/complete`,'POST');await waitStage(textId,'imported');
  const plan={outline:choice.outline,starts:choice.defaultStarts,excluded:[]};
  await request(`/api/imports/${id}/groups`,'POST',{plan});
  const saved=await waitStage(id,'imported');
  await request(`/api/imports/${id}/complete`,'POST');
  await request('/api/imports','POST',{id,board:board.id,filename:'Russell test.pdf',size:bytes.length});
  const state=await request(`/api/boards/${board.id}`);
  assert.equal(state.resources.length,2);
  const raw=await fetch(`${base}/api/boards/${board.id}/resources/${saved.resource_id}/raw`);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()),bytes);
  const db=new DatabaseSync(dbPath,{readOnly:true});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_chunks WHERE import_id=?').get(id)!.n,0);db.close();
});

test('invalid PDFs keep a visible retryable error and can be cancelled',async()=>{
  const {board}=await request('/api/boards','POST',{title:'Broken PDF'});
  const id=randomUUID(),bytes=Buffer.from('not a PDF');
  await request('/api/imports','POST',{id,board:board.id,filename:'broken.pdf',size:bytes.length});
  await send(id,0,bytes);await request(`/api/imports/${id}/complete`,'POST');
  const failed=await waitStage(id,'error');assert.ok(failed.error);
  await stopServer(server);await boot();
  assert.equal((await request(`/api/imports/${id}`)).import.error,failed.error);
  assert.ok((await request('/api/imports')).imports.some((j:{id:string})=>j.id===id));
  await request(`/api/imports/${id}/retry`,'POST');await waitStage(id,'error');
  await request(`/api/imports/${id}`,'DELETE');
  assert.equal((await request(`/api/imports/${id}`)).import.stage,'cancelled');
  assert.ok(!(await request('/api/imports')).imports.some((j:{id:string})=>j.id===id));
});

test('restart resumes a persisted finalization without re-extracting or duplicating',async()=>{
  const {board}=await request('/api/boards','POST',{title:'Finalization recovery'});
  const id=randomUUID(),text=Buffer.from('Already prepared.');
  await request('/api/imports','POST',{id,board:board.id,filename:'checkpoint.txt',size:text.length});
  await send(id,0,text);
  await stopServer(server);
  const db=new DatabaseSync(dbPath);
  db.prepare("UPDATE imports SET stage='stored' WHERE id=?").run(id);
  db.prepare("UPDATE imports SET stage='extracting' WHERE id=?").run(id);
  db.prepare("UPDATE imports SET stage='sizing',prepared=? WHERE id=?").run(JSON.stringify({text:text.toString(),tokens:5,sections:[],outline:[],pageText:[],defaultStarts:[]}),id);
  db.prepare("UPDATE imports SET stage='queued' WHERE id=?").run(id);
  db.prepare("UPDATE imports SET stage='finalizing' WHERE id=?").run(id);
  db.close();await boot();await waitStage(id,'imported');
  await stopServer(server);await boot();
  const state=await request(`/api/boards/${board.id}`);
  assert.equal(state.resources.length,1);
  assert.equal(state.resources[0].id,`res-${id}`);
});

test('a dropped HTML file lands like any source: live when it runs code, an article when it does not',async()=>{
  const {board}=await request('/api/boards','POST',{title:'Dropped pages'});
  const pages={'live.html':'<html><body><h1>Live</h1><p>Drag the slider.</p><input type="range"><script>1</script></body></html>','plain.html':'<html><body><p>Only words.</p></body></html>'};
  const kinds:Record<string,string>={};
  for(const [filename,html] of Object.entries(pages)) {
    const id=randomUUID(),bytes=Buffer.from(html);
    await request('/api/imports','POST',{id,board:board.id,filename,size:bytes.length});
    await send(id,0,bytes);await request(`/api/imports/${id}/complete`,'POST');
    const row=await waitStage(id,'imported');
    const {resources}=await request(`/api/boards/${board.id}`);
    kinds[filename]=resources.find((r:{id:string})=>r.id===row.resource_id).kind;
  }
  assert.deepEqual(kinds,{'live.html':'html','plain.html':'text'});
  await request(`/api/boards/${board.id}`,'DELETE');
});

test('an upload with flashcards turned off arrives unstudied; one left on is studied',async()=>{
  const {board}=await request('/api/boards','POST',{title:'Study toggle'});
  const status:Record<string,string>={};
  for(const [filename,study] of [['off.md',false],['on.md',undefined]] as const) {
    const id=randomUUID(),bytes=Buffer.from(`# ${filename}\n\nA paragraph long enough to be a section of its own.\n`);
    await request('/api/imports','POST',{id,board:board.id,filename,size:bytes.length,...(study===undefined?{}:{study})});
    await send(id,0,bytes);await request(`/api/imports/${id}/complete`,'POST');
    const row=await waitStage(id,'imported');
    const {sections,trees}=await request(`/api/boards/${board.id}`);
    const sec=sections.find((s:{resourceId:string})=>s.resourceId===row.resource_id);
    status[filename]=trees[sec.id]?.status;
  }
  assert.equal(status['off.md'],'unstudied');
  assert.notEqual(status['on.md'],'unstudied');
  await request(`/api/boards/${board.id}`,'DELETE');
});
