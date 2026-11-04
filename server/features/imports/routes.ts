import { route, type Route } from '../../platform/router/router.ts';
import { db } from '../../platform/db/db.ts';
import { q } from "../repo.ts";
import { MAX_UPLOAD_BYTES } from '../../platform/config.ts';
import { httpError, sendJson } from '../../platform/http/http.ts';
import { imports, importStatus, importChoice, chooseImport, retryImport, cancelImport, startImportPump } from './pump.ts';
import type { ImportRow } from './store.ts';

export const CHUNK_BYTES = 512 * 1024;
const required = (id: string) => { const row=imports.get(id); if (!row) throw httpError(404,'Import not found.'); return row; };
const listed = db.prepare("SELECT id,board_id,filename,size,received,stage,error,page,pages,resource_id,updated_at FROM imports WHERE stage<>'cancelled' AND (resource_id IS NULL OR EXISTS(SELECT 1 FROM resources WHERE id=imports.resource_id)) ORDER BY created_at DESC");
export const importRoutes: Route[] = [
  route('GET','/api/imports',({res})=>{
    const rows = listed.all() as unknown as ImportRow[];
    let completed=0;
    const items=rows.map(importStatus).filter(r=>r.stage!=='imported'||r.generation?.busy||r.generation?.failed||r.generation?.disabled||completed++<10);
    sendJson(res,200,{imports:items});
  }),
  route('POST','/api/imports',async({body,commit})=>{
    const b=await body<{id:string;board:string;filename:string;size:number;study?:boolean}>(4096);
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(b.id??'') || typeof b.filename!=='string' || !b.filename.trim() || b.filename.length>200) throw httpError(400,'Invalid import name or ID.');
    if (!Number.isSafeInteger(b.size)||b.size<=0) throw httpError(400,'The file is empty or its size is invalid.');
    if (b.size>MAX_UPLOAD_BYTES) throw httpError(413,`This file exceeds the ${Math.floor(MAX_UPLOAD_BYTES/1024/1024)} MB upload limit.`);
    if (!imports.get(b.id) && !q.board.get(b.board)) throw httpError(404,'Destination board not found.');
    commit(()=>({status:201,body:{import:importStatus(imports.create(b.id,b.board,b.filename,b.size,b.study!==false)),chunkBytes:CHUNK_BYTES}}));
  },{receipt:'atomic',maxBody:4096}),
  route('GET',/^\/api\/imports\/([a-zA-Z0-9_-]+)$/,({res,params})=>sendJson(res,200,{import:importStatus(required(params[0]))})),
  route('PUT',/^\/api\/imports\/([a-zA-Z0-9_-]+)\/bytes$/,async({req,res,params,url})=>{
    required(params[0]);
    const chunks:Buffer[]=[];let size=0;
    for await (const value of req) {
      const chunk=Buffer.from(value);size+=chunk.length;
      if(size>CHUNK_BYTES) throw httpError(413,'Upload chunk is too large.');
      chunks.push(chunk);
    }
    const offset=url.searchParams.get('offset');
    if (offset===null || !/^\d+$/.test(offset)) throw httpError(400,'Missing upload offset.');
    sendJson(res,200,{import:importStatus(imports.chunk(params[0],Number(offset),Buffer.concat(chunks)))});
  },{receipt:'exempt'}), // The handler streams req itself; the router must never read it first.
  route('POST',/^\/api\/imports\/([a-zA-Z0-9_-]+)\/complete$/,({params,commit})=>{
    const row=required(params[0]);
    if(row.stage==='uploading'&&row.received!==row.size) throw httpError(409,'The upload is not complete.');
    commit(()=>{
      if(row.stage==='uploading') imports.transition(row.id,'uploading','stored');
      return {status:202,body:{import:importStatus(required(row.id))}};
    });
    startImportPump();
  },{receipt:'atomic'}),
  route('GET',/^\/api\/imports\/([a-zA-Z0-9_-]+)\/groups$/,({res,params})=>sendJson(res,200,importChoice(required(params[0])))),
  // runJob defers a job started inside a transaction until the transaction ends.
  route('POST',/^\/api\/imports\/([a-zA-Z0-9_-]+)\/groups$/,async({params,body,commit})=>{
    const b=await body<{plan:unknown}>(4*1024*1024);
    commit(()=>{chooseImport(required(params[0]),b.plan);return {status:202,body:{import:importStatus(required(params[0]))}};});
  },{receipt:'atomic',maxBody:4*1024*1024}),
  route('POST',/^\/api\/imports\/([a-zA-Z0-9_-]+)\/retry$/,({params,commit})=>{
    commit(()=>{retryImport(required(params[0]));return {status:202,body:{import:importStatus(required(params[0]))}};});
  },{receipt:'atomic'}),
  route('DELETE',/^\/api\/imports\/([a-zA-Z0-9_-]+)$/,({params,commit})=>{
    commit(()=>{cancelImport(required(params[0]));return {status:200,body:{ok:true}};});
  },{receipt:'atomic'}),
];
