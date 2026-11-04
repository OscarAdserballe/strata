import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {book} from './fixture-pdf.mjs';
import {until} from './settled.mjs';

const base=process.argv[2]||'http://127.0.0.1:8804';
const request=async(path,method='GET',body)=>{
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  assert.ok(response.ok,`${method} ${path}: ${response.status}`);return response.status===204?null:response.json();
};
const {board}=await request('/api/boards','POST',{title:'Import smoke'});
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||undefined});
const ids=[];
try {
  const page=await browser.newPage({serviceWorkers:'block'});page.setDefaultTimeout(15000);const errors=[];
  page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`${base}/?board=${board.id}`);
  const file={name:'Group import smoke.pdf',mimeType:'application/pdf',buffer:Buffer.from(book().bytes)};
  // Lose a committed chunk acknowledgement, then refresh: resume from the server offset.
  let interrupted=false,notifyInterrupted;
  const interruptedRequest=new Promise(resolve=>{notifyInterrupted=resolve;});
  await page.route('**/api/imports/*/bytes?*',async route=>{
    if(!interrupted) {interrupted=true;await route.fetch();await route.abort();notifyInterrupted();}
    else await route.continue();
  });
  // Add harmless trailing bytes so this fixture spans multiple upload chunks.
  file.buffer=Buffer.concat([file.buffer,Buffer.alloc(600_000,32)]);
  const created=page.waitForResponse(r=>r.url().endsWith('/api/imports')&&r.request().method()==='POST');
  await page.getByLabel('Add source files',{exact:true}).setInputFiles(file);
  const {import:job}=await (await created).json();ids.push(job.id);
  await interruptedRequest;
  const saved=(await request(`/api/imports/${job.id}`)).import.received;
  assert.ok(saved>0&&saved<file.buffer.length);
  await page.unroute('**/api/imports/*/bytes?*');
  await page.reload();
  // extraction is a server-side job, slow on a loaded machine: wait on the job, then on the dashboard
  await until(async()=>(await request(`/api/imports/${job.id}`)).import.stage==='awaiting_groups',{what:'the book to be extracted and waiting for groups',timeout:120_000});
  await page.getByRole('button',{name:'boards',exact:true}).click();
  const row=page.getByRole('region',{name:'Imports'}).locator('li').filter({hasText:file.name});
  await row.getByRole('button',{name:'Choose study groups',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Group import smoke'});
  await modal.getByRole('checkbox',{name:'Include Notes',exact:true}).uncheck();
  await modal.getByRole('checkbox',{name:'Include Index',exact:true}).uncheck();
  await page.reload();
  await row.getByRole('button',{name:'Choose study groups',exact:true}).click();
  assert.equal(await modal.getByRole('checkbox',{name:'Include Index',exact:true}).isChecked(),false,'grouping draft survives refresh');
  await page.keyboard.press('Escape');
  await modal.waitFor({state:'hidden'});
  assert.equal((await request(`/api/imports/${job.id}`)).import.stage,'awaiting_groups','closing the dialog retains the book');
  // One book waiting for decisions must not block the remainder of a batch.
  const second={name:'Second source.txt',mimeType:'text/plain',buffer:Buffer.from('The second source keeps moving.')};
  const corrupt={name:'Broken source.pdf',mimeType:'application/pdf',buffer:Buffer.from('not a PDF')};
  await page.goto(`${base}/?board=${board.id}`);
  await page.getByLabel('Add source files',{exact:true}).setInputFiles([second,corrupt]);
  await page.getByRole('button',{name:'boards',exact:true}).click();
  // the broken PDF waits on a server-side job, so its ceiling is the job's, not a UI step's
  const secondRow=page.getByRole('region',{name:'Imports'}).locator('li').filter({hasText:second.name});
  await secondRow.getByRole('button',{name:'Open book',exact:true}).waitFor({timeout:15_000});
  const brokenRow=page.getByRole('region',{name:'Imports'}).locator('li').filter({hasText:corrupt.name});
  await brokenRow.getByRole('button',{name:'Retry',exact:true}).waitFor({timeout:120_000});
  await page.goto(base+'/');
  await page.getByRole('region',{name:'Imports'}).getByText('Import failed · original file retained',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('region',{name:'Imports'}).getByText('Import failed · original file retained',{exact:true}).waitFor();
  await row.getByRole('button',{name:'Choose study groups',exact:true}).click();
  await modal.waitFor();
  const join=modal.getByRole('button',{name:/^Join unit \d+ with previous$/});
  while(await join.count())await join.first().click();
  await modal.getByRole('button',{name:'Add source',exact:true}).click();
  await modal.waitFor({state:'hidden'});
  await row.getByRole('button',{name:'Open book',exact:true}).waitFor({timeout:120_000});   // finalizing is a job too
  const complete=(await request(`/api/imports/${job.id}`)).import;
  const state=await request(`/api/boards/${board.id}`);
  assert.equal(state.resources.filter(r=>r.filename===file.name).length,1);
  const raw=await fetch(`${base}/api/boards/${board.id}/resources/${complete.resource_id}/raw`);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()),file.buffer);
  const units=state.sections.filter(s=>s.resourceId===complete.resource_id);
  assert.equal(units.length,1);
  assert.ok(units[0].lastPage<book().sections.find(s=>s.label==='Notes').firstPage);
  await page.setViewportSize({width:390,height:844});
  await brokenRow.getByRole('button',{name:'Retry',exact:true}).waitFor();
  if(process.env.STRATA_SMOKE_SCREENSHOT)await page.screenshot({path:process.env.STRATA_SMOKE_SCREENSHOT,fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('✓ durable imports: interrupted upload, reload/resume, saved grouping, independent batch, persistent dashboard failure, original bytes, mobile');
} finally {
  await browser.close();
  const items=(await request('/api/imports')).imports.filter(j=>j.board_id===board.id&&j.stage!=='imported');
  for(const item of items)await request(`/api/imports/${item.id}`,'DELETE');
  await request(`/api/boards/${board.id}`,'DELETE');
}
