import { api, StrataPath } from '../../data/api.ts';
import { mintKey, release } from '../../data/mutate.ts';
import type { ImportStatus } from '../../../shared/imports/import-status.ts';
import type { PlanSource } from './ImportPlan.tsx';

export interface LocalImport {
  id: string; board: string; filename: string; size: number; error?: string;
  attempts: number; retryAt: number; warning?: string; verify?: boolean; study?: boolean;
}
const listeners = new Set<()=>void>();
const memory = new Map<string,LocalImport>();
const files = new Map<string,File>();
const active = new Set<string>();
const saving = new Set<string>();
let database: Promise<IDBDatabase> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const prefix = () => `strata-import:${StrataPath('/')}:`;
const changed = () => listeners.forEach(fn=>fn());

// the uploader keeps its own retry schedule; a save-path retry under it would stack two clocks
const importOp = (id:string, label:string, method:'POST'|'DELETE', path:string, body?:unknown) =>
  release({ label, lanes:[`import:${id}`], method, path, body });
export const ImportAPI = {
  list: () => api<{imports:ImportStatus[]}>('/api/imports',{cache:'no-store',signal:AbortSignal.timeout(15_000)}),
  get: (id:string) => api<{import:ImportStatus}>(`/api/imports/${id}`),
  groups: (id:string) => api<PlanSource>(`/api/imports/${id}/groups`),
  choose: (id:string,plan:unknown) => importOp(id,'use those groups','POST',`/api/imports/${id}/groups`,{plan}),
  retry: (id:string) => importOp(id,'try that import again','POST',`/api/imports/${id}/retry`),
  cancel: (id:string) => importOp(id,'cancel that import','DELETE',`/api/imports/${id}`),
};

function fileDB(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve,reject)=>{
    const request=indexedDB.open('strata-import-files',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('files');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(new Error('Browser storage is blocked.'));
  });
}
async function fileStore(id:string,action:'get'|'put'|'delete',file?:File): Promise<File|undefined> {
  const db=await fileDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('files',action==='get'?'readonly':'readwrite');
    const store=tx.objectStore('files');const key=prefix()+id;
    const request=action==='get'?store.get(key):action==='put'?store.put(file,key):store.delete(key);
    tx.oncomplete=()=>resolve(action==='get'?request.result:undefined);
    tx.onabort=()=>reject(tx.error??new Error('Browser storage is full.'));
    tx.onerror=()=>reject(tx.error??new Error('Browser storage is unavailable.'));
  });
}
function save(job:LocalImport): void {
  memory.set(job.id,job);
  try { localStorage.setItem(prefix()+job.id,JSON.stringify(job)); }
  catch { job.warning='Browser storage is unavailable. Keep this tab open until the file is uploaded.'; }
  changed();
}
export function localImports(): LocalImport[] {
  try {
    for(let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i)!;
      if(key.startsWith(prefix())) { const item=JSON.parse(localStorage.getItem(key)!);memory.set(item.id,item); }
    }
  } catch { /* In-memory uploads remain available; save() exposes the limitation. */ }
  return [...memory.values()];
}
async function forget(id:string): Promise<void> {
  memory.delete(id);files.delete(id);
  try { localStorage.removeItem(prefix()+id); } catch { /* unavailable storage */ }
  await fileStore(id,'delete').catch(()=>{});changed();
}

export async function addImports(selected: File[],board:string,study=true): Promise<void> {
  const jobs=selected.map(file=>{
    // mintKey, not randomUUID: the plain-http tailnet address is no secure context and has none
    const job:LocalImport={id:mintKey(),board,filename:file.name,size:file.size,attempts:0,retryAt:0,...(study?{}:{study:false})};
    files.set(job.id,file);saving.add(job.id);save(job);return job;
  });
  for(const job of jobs) {
    try { await fileStore(job.id,'put',files.get(job.id)); }
    catch { job.warning='Cannot retain this file in browser storage. Keep this tab open until upload finishes.';save(job); }
    finally { saving.delete(job.id); }
    schedule();
  }
}

async function transfer(job:LocalImport): Promise<void> {
  try {
    const response=await api<{import:ImportStatus;chunkBytes:number}>('/api/imports',{method:'POST',body:JSON.stringify(job)});
    let row=response.import;
    if(row.stage!=='uploading') { await forget(job.id);return; }
    const file=files.get(job.id)??await fileStore(job.id,'get');
    if(!file) throw new Error('The original file is no longer on this browser. Select it again to resume.');
    // A reselected file is checked against every saved chunk before appending new bytes.
    let offset=job.verify?0:row.received;
    while(offset<job.size) {
      if(!memory.has(job.id)) return;
      const end=Math.min(offset+response.chunkBytes,job.size);
      const result=await api<{import:ImportStatus}>(`/api/imports/${job.id}/bytes?offset=${offset}`,{
        method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file.slice(offset,end),signal:AbortSignal.timeout(60_000),
      });
      row=result.import;offset=end;changed();
    }
    await api(`/api/imports/${job.id}/complete`,{method:'POST'});
    await forget(job.id);
  } catch(error) {
    if(!memory.has(job.id)) return;
    const status=(error as {status?:number}).status;
    job.attempts++;
    job.error=(error as Error).message;
    const permanent=(status!==undefined&&status>=400&&status<500&&![408,409,429].includes(status))||job.error.includes('Select it again');
    job.retryAt=permanent||job.attempts>=5 ? Number.MAX_SAFE_INTEGER : Date.now()+Math.min(60_000,2000*2**job.attempts);
    save(job);
  }
}
function schedule(): void {
  clearTimeout(timer);
  for(const job of localImports()) {
    if(active.size>=2) break;
    if(active.has(job.id)||saving.has(job.id)||job.retryAt>Date.now()) continue;
    active.add(job.id);
    const run=async()=>{await transfer(job);};
    const work=navigator.locks ? navigator.locks.request(prefix()+job.id,{ifAvailable:true},lock=>lock?run():Promise.resolve()) : run();
    void work.finally(()=>{active.delete(job.id);timer=setTimeout(schedule,2000);});
  }
  if(memory.size) timer=setTimeout(schedule,2000);
}
export function subscribeImports(listener:()=>void): ()=>void { listeners.add(listener);schedule();return ()=>{listeners.delete(listener);}; }
export function resumeImport(id:string,file?:File): void {
  const job=memory.get(id);if(!job)return;
  if(file) {
    if(file.name!==job.filename||file.size!==job.size) { job.error='Choose the original file with the same name and size.';save(job);return; }
    files.set(id,file);job.verify=true;job.error=undefined;void fileStore(id,'put',file).catch(()=>{});
  }
  job.attempts=0;job.retryAt=0;save(job);schedule();
}
export async function cancelUpload(id:string): Promise<void> {
  // Create the receipt first so cancellation cannot race an in-flight create request.
  const job=memory.get(id);
  if(job) {
    try { await api('/api/imports',{method:'POST',body:JSON.stringify(job)}); }
    catch(error) { const status=(error as {status?:number}).status;if(status===400||status===413||status===404){await forget(id);return;}throw error; }
  }
  try { await ImportAPI.cancel(id); } catch(error) { if((error as {status?:number}).status!==404)throw error; }
  await forget(id);
}
if(typeof window!=='undefined') window.addEventListener('online',()=>{
  for(const job of localImports()) if(job.retryAt!==Number.MAX_SAFE_INTEGER) {job.retryAt=0;save(job);}
  schedule();
});
