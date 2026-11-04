import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { db } from '../../platform/db/db.ts';
import { tx } from '../../platform/db/tx.ts';
import { q } from "../repo.ts";
import type { SectionRow } from "../../platform/db/rows.ts";
import { APP, BUDGET_TOKENS, MIN_SECTION_WORDS, deps } from '../../platform/config.ts';
import { logEvent } from '../../platform/events/events.ts';
import { background } from '../../platform/background.ts';
import { runJob } from '../../platform/jobs.ts';
import { countGeminiTokens } from '../../platform/llm/gemini.ts';
import { cleanImportedMarkdown } from '../sources/markdown-clean.ts';
import { htmlSource, prepareSource, reviseSource, revisedBy, writeSource } from '../sources/ingest.ts';
import { importStore, type ImportRow } from './store.ts';
import { enqueueDistil, retrySourceTree } from '../distil/queue.ts';
import { httpError } from '../../platform/http/http.ts';
import { pageGroups, sourceTokens, studyTokens } from '../../../shared/imports/budget.ts';
import { compileImportPlan } from '../../../shared/imports/import-plan.ts';
import type { PdfStructure } from '../../../shared/reading/pdf-structure.ts';
import type { ImportStatus } from '../../../shared/imports/import-status.ts';

export const imports = importStore(db);
interface Prepared extends PdfStructure { tokens?: number | null; text?: string }
let pumping = false;
const workers = new Map<string,Worker>();

const setSha = db.prepare('UPDATE imports SET sha256=? WHERE id=? AND sha256 IS NULL');
const setAutoPlan = db.prepare("UPDATE imports SET prepared=?,plan=?,stage='queued',updated_at=? WHERE id=? AND stage='sizing'");

/** The split the picker would suggest, if it compiles within the budget: bookmarks first, then page groups. */
function defaultPlan(p: Prepared): unknown | null {
  const tries = p.outline.length > 1 ? [{outline:p.outline,defaultStarts:p.defaultStarts}, pageGroups(p.pageText,BUDGET_TOKENS)] : [pageGroups(p.pageText,BUDGET_TOKENS)];
  for (const choice of tries) {
    const plan = {outline:choice.outline,starts:choice.defaultStarts,excluded:[]};
    try {
      if (!compileImportPlan(plan,p.pageText).some(unit=>studyTokens(unit,p.pageText)>BUDGET_TOKENS)) return plan;
    } catch { /* try the next split */ }
  }
  return null;
}

const statusOf = {
  board: db.prepare('SELECT board_id FROM resources WHERE id=?'),
  sections: db.prepare("SELECT t.status,t.error FROM sections s LEFT JOIN trees t ON t.section_id=s.id WHERE s.resource_id=? AND COALESCE(s.kind,'work')<>'apparatus'"),
  overview: db.prepare('SELECT status,error FROM source_trees WHERE resource_id=?'),
};

export function importStatus(row: ImportRow): ImportStatus {
  const {id,board_id,filename,size,received,stage,error,page,pages,resource_id,updated_at} = row;
  const result: ImportStatus = {id,board_id,filename,size,received,stage,error,page,pages,resource_id,updated_at};
  if (resource_id) {
    const resource = statusOf.board.get(resource_id);
    if (resource) result.board_id = String(resource.board_id);
    const rows = statusOf.sections.all(resource_id) as {status:string;error:string|null}[];
    const overview = statusOf.overview.get(resource_id) as {status:string;error:string|null} | undefined;
    result.generation = {
      ready: rows.filter(r=>r.status==='ready').length, total: rows.length,
      failed: rows.filter(r=>r.status==='error').length + (overview?.status==='error'?1:0),
      busy: rows.filter(r=>!['ready','error','disabled','skipped','unstudied'].includes(r.status)).length + (overview?.status==='running'?1:0),
      disabled: rows.filter(r=>r.status==='disabled').length,
      unstudied: rows.filter(r=>r.status==='unstudied').length,
      error: rows.find(r=>r.error)?.error ?? overview?.error ?? null,
    };
  }
  return result;
}

export function importChoice(row: ImportRow) {
  if (row.stage !== 'awaiting_groups' || !row.prepared) throw httpError(409,'This import is not waiting for grouping.');
  const p = JSON.parse(row.prepared) as Prepared;
  return { title:row.filename.replace(/\.[^.]+$/,''), ...(p.outline.length > 1 ? {outline:p.outline,defaultStarts:p.defaultStarts} : pageGroups(p.pageText,BUDGET_TOKENS)),
    pageText:p.pageText,budgetTokens:BUDGET_TOKENS,hasBookmarks:p.outline.length>1 };
}

export function chooseImport(row: ImportRow, plan: unknown): void {
  if (row.stage !== 'awaiting_groups' || !row.prepared) throw httpError(409,'This import is not waiting for grouping.');
  const p = JSON.parse(row.prepared) as Prepared;
  try {
    const units = compileImportPlan(plan,p.pageText);
    if (units.some(unit=>studyTokens(unit,p.pageText)>BUDGET_TOKENS)) throw new Error('A study group exceeds the token budget. Split it or exclude material.');
  } catch (error) { throw httpError(400,(error as Error).message); }
  db.prepare("UPDATE imports SET plan=?,stage='queued',error=NULL,updated_at=? WHERE id=? AND stage='awaiting_groups'").run(JSON.stringify(plan),Date.now(),row.id);
  startImportPump();
}

export function cancelImport(row: ImportRow): void {
  if (row.stage === 'imported') throw httpError(409,'This book is already saved. Remove it from the library if you no longer want it.');
  tx(() => {
    if (row.stage !== 'cancelled') imports.transition(row.id,row.stage,'cancelled');
    db.prepare('DELETE FROM import_chunks WHERE import_id=?').run(row.id);
    db.prepare('UPDATE imports SET prepared=NULL,plan=NULL WHERE id=?').run(row.id);
  });
  const worker = workers.get(row.id);
  if (worker) background(`import ${row.id} worker`, worker.terminate());
}

export function retryImport(row: ImportRow): void {
  if (row.stage === 'error') imports.transition(row.id,'error',row.prepared ? (JSON.parse(row.prepared).tokens === undefined ? 'sizing' : 'queued') : 'stored');
  else if (row.stage === 'imported' && row.resource_id) {
    const owner = db.prepare('SELECT board_id FROM resources WHERE id=?').get(row.resource_id);
    if (!owner) throw httpError(404,'This book was removed.');
    let retried = false;
    for (const section of q.sectionsOf.all(row.resource_id) as SectionRow[]) {
      const status = q.tree.get(section.id)?.status;
      if (section.kind !== 'apparatus' && (!status || ['error','disabled'].includes(status))) {
        retried = enqueueDistil(String(owner.board_id),section.id,null,'import-retry') || retried;
      }
    }
    // A reduction built while a chapter had failed is incomplete; rebuild it after retry.
    if (retried) q.delSourceTree.run(row.resource_id);
    else {
      const rid = row.resource_id;
      void runJob('source-tree', rid, () => retrySourceTree(String(owner.board_id),rid), { onFail:
        (e) => db.prepare("UPDATE source_trees SET status='error',error=? WHERE resource_id=? AND status IN ('pending','running')")
          .run(String(e?.message ?? e).slice(0,300),rid) });
    }
  }
  startImportPump();
}

async function extract(row: Pick<ImportRow, 'id'>, bytes: Buffer): Promise<PdfStructure> {
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL('./pdf-worker.ts',import.meta.url),{workerData:{bytes,minimum:MIN_SECTION_WORDS}});
    workers.set(row.id,worker);
    const timeout = setTimeout(()=>{reject(new Error('PDF preparation timed out. Retry or use a smaller PDF.'));background(`import ${row.id} worker`,worker.terminate());},10*60_000);
    const cleanup = () => { clearTimeout(timeout); workers.delete(row.id); };
    worker.on('message',(message)=>{
      if (message.error) { reject(new Error(message.error)); return; }
      if (message.structure) { resolve(message.structure); return; }
      if (message.page) db.prepare("UPDATE imports SET page=?,pages=?,updated_at=? WHERE id=? AND stage='extracting'").run(message.page,message.total,Date.now(),row.id);
    });
    worker.on('error',reject);
    worker.on('exit',code=>{cleanup();reject(new Error(`PDF preparation stopped (${code}). Retry to continue.`));});
  });
}

export async function pumpImports(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const row = db.prepare("SELECT * FROM imports WHERE stage IN ('stored','sizing','queued') ORDER BY created_at LIMIT 1").get() as unknown as ImportRow | undefined;
      if (!row) break;
      const stage = row.stage === 'stored' ? 'extracting' : row.stage === 'sizing' ? 'sizing' : 'finalizing';
      if (!imports.transition(row.id,row.stage,stage)) continue;
      db.prepare('UPDATE imports SET attempts=attempts+1 WHERE id=?').run(row.id);
      try {
        if (!q.board.get(row.board_id)) throw new Error('The destination board was deleted. Cancel this import and add the file to another board.');
        const bytes = imports.bytes(row.id);
        if (bytes.length !== row.size) throw new Error('The saved file is incomplete.');
        const isPdf = /\.pdf$/i.test(row.filename);
        const html = isPdf ? null : htmlSource(row.filename,bytes.toString('utf8'));
        if (stage === 'extracting') {
          setSha.run(createHash('sha256').update(bytes).digest('hex'),row.id);
          const structure: PdfStructure = isPdf ? await extract(row,bytes) : {sections:[],outline:[],pageText:[],defaultStarts:[]};
          const text = isPdf ? undefined : bytes.toString('utf8');
          if (!isPdf && !text?.trim()) throw new Error('This file contains no readable text.');
          db.prepare("UPDATE imports SET prepared=?,stage='sizing',updated_at=? WHERE id=? AND stage='extracting'").run(JSON.stringify({...structure,text}),Date.now(),row.id);
        } else if (stage === 'sizing') {
          const structure = JSON.parse(row.prepared!) as Prepared;
          const text = isPdf ? undefined : html ? html.text : await cleanImportedMarkdown(structure.text ?? '',deps.geminiAvailable ? deps.callGeminiJson : undefined);
          const tokens = await countGeminiTokens(isPdf ? {files:[{mimeType:'application/pdf',data:bytes.toString('base64')}]} : {text});
          const total = sourceTokens({tokens,text,bytes:isPdf ? bytes.length : 0,pages:structure.pageText});
          const needsGroups = isPdf && (!!structure.defaultStarts.length || total>BUDGET_TOKENS);
          if (needsGroups && !structure.pageText.some(t=>t.trim())) throw new Error('This PDF needs smaller study groups but has no searchable text. Use a searchable PDF or a smaller excerpt.');
          if (!isPdf && total>BUDGET_TOKENS) throw new Error('This text exceeds the study budget. Split it into smaller files.');
          // An agent's upload has no one to ask, so it takes the suggested split when that one fits.
          const auto = needsGroups && (row as ImportRow & {auto?:number}).auto ? defaultPlan({...structure,tokens}) : null;
          if (auto) setAutoPlan.run(JSON.stringify({...structure,text,tokens}),JSON.stringify(auto),Date.now(),row.id);
          else db.prepare("UPDATE imports SET prepared=?,stage=?,updated_at=? WHERE id=? AND stage='sizing'").run(JSON.stringify({...structure,text,tokens}),needsGroups ? 'awaiting_groups' : 'queued',Date.now(),row.id);
        } else {
          const prepared = JSON.parse(row.prepared!) as Prepared;
          const source = await prepareSource({filename:row.filename,kind:isPdf?'pdf':html?.kind ?? 'text',data:isPdf?bytes.toString('base64'):html?.data,
            mime:isPdf?'application/pdf':html?.mime ?? 'text/plain',text:prepared.text,sections:prepared.sections,pageText:prepared.pageText,
            importPlan:row.plan ? JSON.parse(row.plan) : undefined,outline:isPdf ? prepared.outline : undefined,tokens:prepared.tokens,createPair:true,importId:row.id,study:row.study!==0});
          // Decided at finalize: the first version may still have been uploading when this one was asked for.
          const revises = revisedBy(row.board_id,row.id,row.origin_ref,row.filename);
          const landed = revises ? reviseSource(row.board_id,revises,source) : !!writeSource(row.board_id,source,null);
          if (landed) logEvent(db,APP,revises ? 'resource_revise' : 'resource_add',{board:row.board_id,kind:isPdf?'pdf':html?.kind ?? 'text',via:'upload',import:row.id,sections:q.sectionsOf.all(revises ?? `res-${row.id}`).length},null);
        }
      } catch (error) {
        // Recording the failure can fail too; recover() picks the row up at next boot.
        try { imports.transition(row.id,stage,'error',String((error as Error)?.message ?? error).slice(0,500)); }
        catch (again) { console.error(`[import ${row.id}] could not be marked failed:`, again); }
      }
    }
  } finally { pumping = false; }
}
// Never awaited: an upload's reply must not wait on a book being prepared.
export function startImportPump(): void { void runJob('imports', 'pump', pumpImports); }

// where the fill stands, so a source with no text can say why rather than guess
const fill = { queued: new Set<string>(), reading: null as string | null, failed: new Map<string, string>() };
export function pageTextStatus(rid: string): string | null {
  if (fill.reading === rid) return "its text is being read from its file now";
  if (fill.queued.has(rid)) return `its text is waiting to be read from its file (${fill.queued.size} PDFs to go)`;
  const why = fill.failed.get(rid);
  if (why) return `its text could not be read from its file: ${why}`;
  const held = q.blobState.get(rid);
  if (!held) return "no file is stored for it";
  if (!held.file) return "its file is not stored, only its record";
  return held.text == null ? "its file is stored and its text has not been read yet" : `its stored page text reads ${JSON.stringify(held.text)}`;
}

/** A PDF stored before its pages' text was kept (none, or an empty list) has none to read or quote: read it once from its bytes, one at a time. */
export async function fillPageText(): Promise<void> {
  fill.queued = new Set(q.pdfsWithoutText.all().map((r) => r.id));
  for (const id of [...fill.queued]) {
    fill.queued.delete(id);
    fill.reading = id;
    try {
      const bytes = q.blobOf.get(id)?.bytes;
      if (!bytes) { fill.failed.set(id, "no file is stored for it"); continue; }
      let pages: string[];
      // a PDF that could not be read is left as it was, to be tried again on the next start
      try { pages = (await extract({ id: `text-${id}` }, Buffer.from(bytes))).pageText; }
      catch (e) { fill.failed.set(id, (e as Error).message.slice(0, 200)); logEvent(db, APP, 'page_text_fail', { resource: id, error: (e as Error).message.slice(0, 200) }, null); continue; }
      // a scanned PDF keeps a page of no text each, as an upload of one does, so it is not read again on every start
      if (!pages.length) { fill.failed.set(id, "it has no pages"); continue; }
      q.setPageText.run(JSON.stringify(pages), id);
      logEvent(db, APP, 'page_text_fill', { resource: id, pages: pages.length }, null);
    } finally { fill.reading = null; }
  }
}

export function startImports(): void { imports.recover(); startImportPump(); void runJob('imports', 'pagetext', fillPageText); }
