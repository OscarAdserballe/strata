import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path,method="GET",body) => {
  const response = await fetch(base+path,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  assert.ok(response.ok,`${method} ${path}: ${response.status}`);
  return response.json();
};
const board = (await api("/api/boards","POST",{title:`Loading fixture ${Date.now()}`})).board;
const filename = `Preview ${board.id}.txt`;
await api(`/api/boards/${board.id}/resources`,"POST",{filename,text:"# Preview heading\n\n"+"Reading a large source. ".repeat(10000),pair:true});
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined});
const releases = [];
async function within(promise,label) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${label}`)),15000);})]); }
  finally { clearTimeout(timer); }
}
async function hold(page,path) {
  let release,started;
  const gate = new Promise(resolve=>{release=resolve;releases.push(resolve);});
  const requested = new Promise(resolve=>{started=resolve;});
  await page.route(base+path,async route=>{started();await gate;await route.continue();});
  return {release,requested};
}
// Today lists the project; a day already reviewed opens on "You're clear." with the page one click past it
async function todayShows(page,title) {
  await page.locator(".td-proj, .today.clear").first().waitFor();
  if (await page.locator(".today.clear").count()) await page.getByRole("button",{name:"Keep reading anyway",exact:true}).click();
  await page.locator(".td-proj").filter({hasText:title}).first().waitFor();
}
try {
  const context = await browser.newContext({serviceWorkers:"block",viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const paths = [], errors = [];
  page.on("request",request=>paths.push(new URL(request.url()).pathname));
  page.on("pageerror",error=>errors.push(error.message));
  const decks = await hold(page,"/api/decks");
  await page.goto(base,{waitUntil:"domcontentloaded"});
  await page.getByRole("button",{name:"New card",exact:true}).waitFor();
  await todayShows(page,board.title);
  assert.equal(paths.filter(path=>path==="/api/decks").length,0,"home does not need the deck catalogue");
  assert.equal(paths.filter(path=>path==="/api/boards").length,1,"home only loads its board list once");
  assert.equal(paths.filter(path=>path==="/api/register").length,1,"home only loads its ledger once");
  await page.locator(".td-proj").filter({hasText:board.title}).first().click();
  await page.locator(".pp-title").filter({hasText:board.title}).waitFor();
  await within(decks.requested,"board deck request");
  assert.equal(new URL(page.url()).searchParams.get("resource"),null);
  assert.equal(paths.some(path=>path.endsWith("/raw")),false,"opening a board downloads none of its sources");
  decks.release();
  await within(page.unrouteAll({behavior:"wait"}),"release deck request");
  await page.waitForLoadState("networkidle");
  assert.equal(paths.filter(path=>path==="/api/register").length,1,"opening a board does not re-read the ledger");
  const ledger = await hold(page,"/api/register");
  await page.getByRole("navigation",{name:"Strata"}).getByRole("button",{name:"Today",exact:true}).click();
  await within(ledger.requested,"returning home refreshes ledger");
  await todayShows(page,board.title);
  ledger.release();
  await page.unrouteAll({behavior:"wait"});
  assert.deepEqual(errors,[]);
  console.log("✓ home loads once without decks; board opens while decks wait; home keeps its ledger while refreshing; opening a board downloads none of its sources");
  await context.close();

  const direct = await browser.newPage({serviceWorkers:"block",viewport:{width:1440,height:1000}});
  direct.setDefaultTimeout(15000);
  const list = await hold(direct,"/api/boards");
  const catalogue = await hold(direct,"/api/decks");
  await direct.goto(`${base}/?board=${board.id}`,{waitUntil:"domcontentloaded"});
  await direct.locator(".pp-title").filter({hasText:board.title}).waitFor();
  list.release(); catalogue.release();
  await direct.unrouteAll({behavior:"wait"});
  const asset = await direct.evaluate(()=>performance.getEntriesByType("resource").find(entry=>/\/dist\/main\.js/.test(entry.name))?.toJSON());
  assert.ok(asset && asset.encodedBodySize>0 && asset.encodedBodySize<asset.decodedBodySize/2,"the real app script transfers compressed");
  console.log(`✓ direct board link opens while the board list and decks wait; script transfers ${asset.encodedBodySize} bytes instead of ${asset.decodedBodySize}`);
} finally {
  for (const release of releases) release();
  await browser.close();
  await api(`/api/boards/${board.id}`,"DELETE");
}
