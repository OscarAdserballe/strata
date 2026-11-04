import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";

const server = useServer();
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("confirmed import groups persist exclusions even when joined into one unit", async () => {
  const {body:made} = await api('/api/boards',{method:'POST',body:JSON.stringify({title:'Import selection'})});
  const id=made.board.id;
  const omitted='EXCLUDED MATERIAL. '.repeat(2000);
  const pageText=['Introduction. '+omitted+'Results.'];
  const original=Buffer.from('%PDF-1.4 original source bytes');
  const outline=[
    {id:0,label:'Introduction',page:1,offset:0,depth:0,parent:null},
    {id:1,label:'Appendix',page:1,offset:14,depth:0,parent:null},
    {id:2,label:'Results',page:1,offset:14+omitted.length,depth:0,parent:null},
  ];
  const {status,body:resource}=await api(`/api/boards/${id}/resources`,{method:'POST',body:JSON.stringify({
    filename:'selected.pdf',base64:original.toString('base64'),pageText,
    sections:[{label:'A',firstPage:1,lastPage:1},{label:'B',firstPage:1,lastPage:1}],
    importPlan:{outline,starts:[],excluded:[1]},
  })});
  assert.equal(status,201);
  assert.equal(resource.sections,1,'explicit joining bypasses greedy regrouping');
  const sec=resource.state.sections[0];
  assert.equal(sec.kind,'work','the reader’s selection outranks apparatus classification');
  assert.ok(sec.tokens<100,'only selected text contributes to the section estimate');
  const db=new DatabaseSync(server.db,{readOnly:true,timeout:5000});
  const row=db.prepare('SELECT content_ranges FROM sections WHERE id=?').get(sec.id) as {content_ranges:string};
  assert.deepEqual(JSON.parse(row.content_ranges),[{page:1,start:0,end:14},{page:1,start:14+omitted.length,end:pageText[0].length}]);
  const blob=db.prepare('SELECT bytes FROM resource_blobs WHERE resource_id=?').get(resource.id) as {bytes:Uint8Array};
  assert.deepEqual(Buffer.from(blob.bytes),original,'the full original remains available to read');
  db.close();
  await api(`/api/boards/${id}/chat`,{method:'POST',body:JSON.stringify({message:'what is here?',here:{sectionId:sec.id,page:1}})});
  const reopened=new DatabaseSync(server.db,{readOnly:true,timeout:5000});
  const turn=reopened.prepare("SELECT props FROM events WHERE event='chat_turn' ORDER BY id DESC LIMIT 1").get() as {props:string};
  const props=JSON.parse(turn.props);
  assert.ok(props.srcChars>0 && props.srcChars<1000,'the single-unit context is sliced, never the full PDF or omitted text');
  reopened.close();
  await api(`/api/boards/${id}`,{method:'DELETE'});
});

test("malformed and empty import plans write no source", async () => {
  const {body:made}=await api('/api/boards',{method:'POST',body:JSON.stringify({title:'Invalid import'})});
  const id=made.board.id;
  for(const importPlan of [{}, {outline:[{id:0,label:'One',page:1,offset:0,depth:0,parent:null}],starts:[],excluded:[0]}]) {
    const result=await api(`/api/boards/${id}/resources`,{method:'POST',body:JSON.stringify({filename:'bad.pdf',base64:'cGRm',pageText:['One'],importPlan})});
    assert.equal(result.status,400);
  }
  const {body:state}=await api(`/api/boards/${id}`);
  assert.equal(state.resources.length,0);
  assert.equal(state.sections.length,0);
  await api(`/api/boards/${id}`,{method:'DELETE'});
});
