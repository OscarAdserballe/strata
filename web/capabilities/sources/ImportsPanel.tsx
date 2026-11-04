import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ImportAPI, resumeImport, cancelUpload, type LocalImport } from './imports.ts';
import type { PlanSource } from './ImportPlan.tsx';
import { importsMoving } from './import-poll.ts';
import { importsNow, lookAgain, watchImports } from './import-watch.ts';
import { StrataMB, StrataPath } from '../../data/api.ts';
import type { ImportStatus } from '../../../shared/imports/import-status.ts';
import { importPlanNow, loadImportPlan } from './import-plan-load.ts';
import './import-activity.css';
import './import-modal.css';

// each screen subscribes for itself, so only it re-renders when an import moves
export function useImportActivity() {
  const {jobs,local,error}=useSyncExternalStore(watchImports,importsNow,importsNow);
  const attention = new Set([...jobs.filter(j=>j.stage==='error'||j.stage==='awaiting_groups'||j.generation?.failed).map(j=>j.id),...local.filter(j=>j.error).map(j=>j.id)]).size;
  return {jobs,local,error,attention,refresh:lookAgain};
}

export function ImportsStatus({onOpen,className='seg',floating=false}:{onOpen:(board:string,resource:string)=>void;className?:string;floating?:boolean}) {
  const {jobs,local,attention}=useImportActivity();
  const [open,setOpen]=useState(false);
  const moving=jobs.filter(j=>importsMoving([j],[])).length+local.filter(j=>!j.error&&!jobs.some(s=>s.id===j.id)).length;
  const any=moving>0||attention>0;
  useEffect(()=>{if(!any)setOpen(false);},[any]);
  useEffect(()=>{
    if(!open)return;
    const esc=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.stopPropagation();setOpen(false);}};
    window.addEventListener('keydown',esc,true);
    return ()=>window.removeEventListener('keydown',esc,true);
  },[open]);
  if(!any)return null;
  const words=[moving?`importing ${moving}`:'',attention?`${attention} import${attention===1?' needs':'s need'} you`:''].filter(Boolean).join(' · ');
  return <span className={'imports-status'+(floating?' floating':'')+(attention?' attention':'')}>
    <button className={className} aria-expanded={open} aria-label={`Imports: ${words}`} title="imports in progress"
      onClick={(e)=>{e.stopPropagation();setOpen(o=>!o);}}>{moving?<i className="dk-spin" aria-hidden="true"/>:null}{words}</button>
    {open?<div className="imports-pop" onClick={(e)=>e.stopPropagation()}>
      <button className="imports-pop-x" aria-label="Close imports" onClick={()=>setOpen(false)}>✕</button>
      <ImportActivity label="Imports in progress" onOpen={(b,r)=>{setOpen(false);onOpen(b,r);}}/>
    </div>:null}
  </span>;
}

function description(job:ImportStatus):string {
  switch(job.stage) {
    case 'uploading':return `Uploading · ${StrataMB(job.received)} of ${StrataMB(job.size)}`;
    case 'stored':return 'File saved · waiting to prepare';
    case 'extracting':return job.pages ? `File saved · reading page ${job.page} of ${job.pages}` : 'File saved · preparing';
    case 'sizing':return 'File saved · checking study size';
    case 'awaiting_groups':return 'File saved · choose your study groups';
    case 'queued':return 'File saved · waiting to add to your library';
    case 'finalizing':return 'Adding to your library';
    case 'error':return 'Import failed · original file retained';
    case 'cancelled':return 'Cancelled';
    case 'imported': {
      const g=job.generation;
      if(g?.failed)return `Needs attention · ${g.failed} processing step${g.failed===1?'':'s'} failed · ${g.ready}/${g.total} ready`;
      if(g?.disabled)return 'Book saved · card generation unavailable on this server';
      if(g?.busy)return `Book saved · ${g.ready}/${g.total} chapters ready`;
      return 'Ready';
    }
  }
}
export function ImportActivity({onOpen,label='Imports'}:{onOpen:(board:string,resource:string)=>void;label?:string}) {
  const {jobs,local,error,refresh}=useImportActivity();
  const [choice,setChoice]=useState<{id:string;source:PlanSource}|null>(null);
  const [Plan,setPlan]=useState(importPlanNow);
  const [actionError,setActionError]=useState('');
  const [busy,setBusy]=useState<string|null>(null);
  const fileInput=useRef<HTMLInputElement>(null);
  const selected=useRef<string>('');
  const localById=new Map(local.map(j=>[j.id,j]));
  const pending=local.filter(j=>!jobs.some(s=>s.id===j.id));
  const actionable=jobs.filter(j=>j.stage!=='imported'||j.generation?.busy||j.generation?.failed||j.generation?.disabled);
  const ready=jobs.filter(j=>!actionable.includes(j));
  async function act(id:string,work:()=>Promise<unknown>) {
    setBusy(id);setActionError('');try{await work();refresh();}catch(e){setActionError((e as Error).message);}finally{setBusy(null);}
  }
  const choose=(id:string)=>act(id,async()=>{const [source,plan]=await Promise.all([ImportAPI.groups(id),loadImportPlan()]);setPlan(()=>plan);setChoice({id,source});});
  const localActions=(j:LocalImport)=><>
    {j.error&&<button disabled={busy===j.id} onClick={()=>resumeImport(j.id)}>Resume upload</button>}
    {j.error&&<button onClick={()=>{selected.current=j.id;fileInput.current?.click();}}>Select original file</button>}
  </>;
  const row=(job:ImportStatus)=>{
    const l=localById.get(job.id);
    const stale=job.stage==='uploading'&&Date.now()-job.updated_at>30_000;
    const issue=l?.error||job.error||job.generation?.error;
    return <li key={job.id} className={issue||stale||job.stage==='awaiting_groups'?'import-attention':''}>
      <div className="import-copy"><strong>{job.filename}</strong><span>{description(job)}</span>
        {job.stage==='uploading'&&<progress aria-label={`Upload progress for ${job.filename}`} max={job.size} value={job.received}/>}
        {issue&&<p className="import-error">{issue}{l&&l.retryAt<Date.now()+120_000?' Retrying automatically…':''}</p>}
        {l?.warning&&<p className="import-error">{l.warning}</p>}
        {stale&&!issue&&<p className="import-error">Upload interrupted. {l?'Resume below.':'Return to the browser where you selected this file to resume, or cancel and add it again.'}</p>}
      </div>
      <div className="import-actions">
        {job.stage==='awaiting_groups'&&<button disabled={busy===job.id} onPointerDown={()=>void loadImportPlan().catch(()=>{})} onClick={()=>void choose(job.id)}>Choose study groups</button>}
        {(job.stage==='error'||!!job.generation?.failed||!!job.generation?.disabled)&&<button disabled={busy===job.id} onClick={()=>void act(job.id,()=>ImportAPI.retry(job.id))}>Retry</button>}
        {job.stage==='uploading'&&l&&localActions(l)}
        {job.resource_id&&<button onClick={()=>onOpen(job.board_id,job.resource_id!)}>Open book</button>}
        {job.stage!=='imported'&&<button disabled={busy===job.id} onClick={()=>void act(job.id,()=>cancelUpload(job.id))}>Cancel import</button>}
      </div>
    </li>;
  };
  if(!jobs.length&&!local.length&&!error)return null;
  return <section className="import-activity" aria-label={label}>
    <div className="home-section-head"><h2>Imports</h2><span>{actionable.length+pending.length ? `${actionable.length+pending.length} in progress or needing attention` : 'Recent imports'}</span></div>
    <p className="import-hint">Uploads resume when you return to this browser. Once saved, preparation continues even when you close the tab.</p>
    {error&&<p role="alert" className="import-error">{error}</p>}
    {actionError&&<p role="alert" className="import-error">{actionError}</p>}
    <ul>{pending.map(j=><li key={j.id} className={j.error?'import-attention':''}><div className="import-copy"><strong>{j.filename}</strong><span>{j.error?'Upload needs attention':'Waiting to upload'}</span>{j.error&&<p className="import-error">{j.error}</p>}{j.warning&&<p className="import-error">{j.warning}</p>}</div><div className="import-actions">{localActions(j)}<button onClick={()=>void act(j.id,()=>cancelUpload(j.id))}>Cancel import</button></div></li>)}{actionable.map(row)}</ul>
    {!!ready.length&&<details><summary>{ready.length} completed import{ready.length===1?'':'s'}</summary><ul>{ready.map(row)}</ul></details>}
    <input ref={fileInput} type="file" hidden onChange={e=>{const f=e.target.files?.[0];if(f)resumeImport(selected.current,f);e.target.value='';}}/>
    {choice&&Plan&&<Plan.default saving={busy===choice.id} draftKey={`strata-import-plan:${StrataPath("/")}:${choice.id}`} plan={undefined} source={choice.source} onClose={()=>setChoice(null)} onConfirm={(plan:unknown)=>void act(choice.id,async()=>{await ImportAPI.choose(choice.id,plan);try { localStorage.removeItem(`strata-import-plan:${StrataPath("/")}:${choice.id}`); } catch { /* browser storage unavailable */ }setChoice(null);})}/>}
  </section>;
}
