import assert from "node:assert/strict";
import { chromium } from "playwright";
import { settled } from "./settled.mjs";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body) => {
  const r = await fetch(base + path, {method,headers:{"Content-Type":"application/json"},body:body === undefined ? undefined : JSON.stringify(body)});
  assert.ok(r.ok, `${method} ${path}: ${r.status}`);
  return r.status === 204 ? null : r.json();
};
const run = Date.now();
const a = (await api("/api/boards","POST",{title:`Navigation A ${run}`})).board;
const b = (await api("/api/boards","POST",{title:`Navigation B ${run}`})).board;
const source = await api(`/api/boards/${a.id}/resources`,"POST",{filename:"Navigation source.md",text:"# A source\nStay where you chose to read.",pair:true});
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined});
let release;
try {
  const context = await browser.newContext({serviceWorkers:"block",viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror",e=>errors.push(e.message));
  await page.goto(base,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:/^All boards /}).click();
  const boards = page.getByRole("region",{name:"All boards",exact:true});
  let requested;
  const gate = new Promise(resolve=>{release=resolve;});
  const started = new Promise(resolve=>{requested=resolve;});
  await page.route(`${base}/api/boards/${a.id}`,async route=>{requested();await gate;await route.continue();});
  await boards.getByRole("button",{name:a.title,exact:true}).click();
  await started;
  
  await boards.getByRole("button",{name:b.title,exact:true}).click();
  await page.locator(".bp-hname").filter({hasText:b.title}).waitFor();
  const late = page.waitForResponse(`${base}/api/boards/${a.id}`);
  release(); await late;
  await settled(page);
  assert.equal(new URL(page.url()).searchParams.get("board"),b.id,"late A cannot replace B");
  assert.match(await page.locator(".bp-hname").innerText(),/Navigation B/);
  await page.unroute(`${base}/api/boards/${a.id}`);
  await page.getByRole("button",{name:"boards",exact:true}).click();
  const allBoards = page.getByRole("button",{name:/^All boards /});
  if (await allBoards.getAttribute("aria-expanded") !== "true") await allBoards.click();
  await boards.getByRole("button",{name:a.title,exact:true}).click();
  await page.locator(".bp-hname").filter({hasText:a.title}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("resource"),null,"board name opens overview");
  await page.goBack();
  await page.getByRole("button",{name:"New card",exact:true}).waitFor();
  await page.goForward();
  await page.locator(".bp-hname").filter({hasText:a.title}).waitFor();
  await page.goto(`${base}/?board=${a.id}&resource=${source.id}`,{waitUntil:"domcontentloaded"});
  await page.locator(".page").getByText("Stay where you chose to read.",{exact:false}).waitFor();
  await page.reload({waitUntil:"domcontentloaded"});
  await page.locator(".page").getByText("Stay where you chose to read.",{exact:false}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("resource"),source.id);
  const before = page.url();
  const imported = page.waitForResponse(async response => response.url().endsWith('/api/imports')
    && response.request().method()==='GET' && response.ok()
    && (await response.json()).imports.some(job=>job.filename==='Another note.md' && job.stage==='imported'));
  await page.getByLabel('Add source files',{exact:true}).setInputFiles({name:"Another note.md",mimeType:"text/markdown",buffer:Buffer.from("# Another note\nImported without navigating.")});
  await imported;
  assert.equal(page.url(),before,"import retains current resource");
  assert.equal(await page.locator('.import-float').count(),0,"imports do not overlay the reader");
  await page.getByRole('button',{name:'boards',exact:true}).click();
  const receipt = page.getByRole("region",{name:"Imports"}).locator("li").filter({hasText:"Another note.md"});
  await receipt.getByRole("button",{name:"Open book",exact:true}).waitFor();
  await receipt.getByRole("button",{name:"Open book",exact:true}).click();
  await page.waitForURL(url=>url.searchParams.get("resource")!==source.id);
  assert.equal((await api(`/api/boards/${a.id}/status`)).busy,false,"no model key means no fictitious pending work");
  console.log("✓ delayed navigation, explicit board overview, browser history, resource reload, and import receipt");

  const created = await api("/api/library/cards","POST",{requestId:crypto.randomUUID(),front:"Review persistence smoke",back:"An acknowledged verdict",source:"Smoke fixture"});
  const course = "strata-personal-cards";
  const card = (await api(`/api/decks/${course}`)).cards.find(c=>c.id===created.id);
  await api("/api/review/grade","POST",{requestId:crypto.randomUUID(),course,card:card.id,got:false});
  let graded = false;
  await page.route(`${base}/api/review`,route=>route.fulfill({json:{cards:graded?[]:[{...card,course,courseTitle:"Personal cards",rung:0,dueAt:0}],total:graded?0:1,unkeptDue:0,nextDueAt:null}}));
  await page.goto(`${base}/?view=review`,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:/reveal/i}).first().click();
  await page.locator(".ch-trace").click();
  await page.getByRole("region",{name:"Card history"}).getByText("Missed",{exact:true}).waitFor();
  const attempts = [];
  await page.route(`${base}/api/review/grade`,async route=>{
    attempts.push(route.request().postDataJSON());
    if(attempts.length===1) await route.fulfill({status:503,json:{error:"Save interrupted"}});
    else { graded=true; await route.continue(); }
  });
  await page.getByRole("button",{name:/got it/i}).first().click();
  const retry = page.getByRole("button",{name:"Retry saving reviews",exact:true});
  await retry.waitFor();
  assert.equal(await page.locator(".reviewv .rcard .q").count(),0,"the card advances while its failed save stays retryable");
  const saved = page.waitForResponse(response=>response.url()===`${base}/api/review/grade` && response.ok());
  await retry.click();
  await saved;
  await page.locator(".reviewv .smap").waitFor();
  assert.equal(attempts.length,2); assert.deepEqual(attempts[0],attempts[1],"retry uses the same receipt");
  const history = await api(`/api/review/history?course=${course}&card=${encodeURIComponent(card.id)}`);
  assert.equal(history.reviews.length,2,"failed attempt is not a grade; retry writes exactly one");
  assert.ok(history.reviews[0].got);
  console.log("✓ card history appears after reveal; failed save stays retryable after advancing and writes exactly one grade");
  await api(`/api/decks/${course}/cards/${card.id}`,"DELETE");
  await context.close();

  const phone = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:"block"});
  await phone.goto(base,{waitUntil:"domcontentloaded"});
  const boardsButton = phone.getByRole("button",{name:"All boards",exact:true});
  await boardsButton.waitFor();
  const addForm = phone.getByRole("region",{name:"Add a source",exact:true});
  assert.ok((await boardsButton.boundingBox()).y < (await addForm.boundingBox()).y, "All boards sits above the add-a-source form");
  await boardsButton.click();
  await phone.getByRole("region",{name:"All boards",exact:true}).getByRole("button",{name:b.title,exact:true}).click();
  await phone.locator(".bp-hname").filter({hasText:b.title}).waitFor();
  assert.deepEqual(errors,[]);
  console.log("✓ phone home can reach every board");
} finally {
  release?.();
  await browser.close();
  await api(`/api/boards/${a.id}`,"DELETE");
  await api(`/api/boards/${b.id}`,"DELETE");
}
