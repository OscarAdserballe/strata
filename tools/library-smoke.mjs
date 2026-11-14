import assert from "node:assert/strict";
import { chromium } from "playwright";
import { until } from "./settled.mjs";

const base = process.argv[2] || "http://127.0.0.1:8804";
const run = Date.now();
const boards = new Set(), resources = [];
function expectResponse(page,predicate) {
  const pending = page.waitForResponse(predicate);
  pending.catch(()=>{}); // Preserve the original assertion if cleanup closes a waiting page.
  return pending;
}
const api = async path=>{
  const response = await fetch(base+path);
  assert.ok(response.ok,`${path}: ${response.status}`);
  return response.json();
};
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined});
try {
  const page = await browser.newPage({serviceWorkers:"block",viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror",error=>errors.push(error.message));
  async function expandBoards(target) {
    const toggle = target.getByRole("button",{name:/^All boards(?:\s|$)/});
    if (await toggle.getAttribute("aria-expanded")!=="true") await toggle.click();
    return target.getByRole("region",{name:"All boards",exact:true});
  }
  const navTo = (target,name)=>target.getByRole("navigation",{name:"Strata"}).getByRole("button",{name,exact:true});
  const projectCard = (target,title)=>target.locator(".pj-card").filter({hasText:title}).first();
  // a project with no material is made at once and opens on its page
  async function createProject(target,title) {
    await navTo(target,"Projects").click();
    await target.getByRole("button",{name:"New project",exact:true}).click();
    await target.getByRole("textbox",{name:"Name",exact:true}).fill(title);
    const created = expectResponse(target,response=>response.url()===base+"/api/boards" && response.request().method()==="POST");
    await target.getByRole("button",{name:"Create project",exact:true}).click();
    const result = await (await created).json();
    assert.ok(result.board?.id,JSON.stringify(result));
    boards.add(result.board.id);
    await target.locator(".pp-title").filter({hasText:title}).waitFor();
    assert.equal(new URL(target.url()).searchParams.get("board"),result.board.id);
    assert.equal(new URL(target.url()).searchParams.get("resource"),null);
    return result.board.id;
  }
  async function createBoard(target,title) {
    const region = await expandBoards(target);
    await region.getByRole("textbox",{name:"New board name"}).fill(title);
    const created = expectResponse(target,response=>response.url()===base+"/api/boards" && response.request().method()==="POST");
    await region.getByRole("button",{name:"Create board",exact:true}).click();
    const result = await (await created).json();
    assert.ok(result.board?.id,JSON.stringify(result));
    boards.add(result.board.id);
    await target.locator(".pp-title").filter({hasText:title}).waitFor();
    assert.equal(new URL(target.url()).searchParams.get("board"),result.board.id);
    assert.equal(new URL(target.url()).searchParams.get("resource"),null);
    return result.board.id;
  }
  await page.goto(base+"/?view=projects",{waitUntil:"domcontentloaded"});
  const title = `Board lifecycle ${run}`, renamed = `Renamed board ${run}`;
  const id = await createProject(page,title);
  await page.getByRole("button",{name:"Project menu",exact:true}).click();
  await page.getByRole("button",{name:"Rename",exact:true}).click();
  const renamedResponse = expectResponse(page,response=>response.url()===`${base}/api/boards/${id}` && response.request().method()==="PATCH");
  await page.getByRole("textbox",{name:"Project name",exact:true}).fill(renamed);
  await page.getByRole("textbox",{name:"Project name",exact:true}).press("Enter");
  assert.equal((await renamedResponse).status(),200);
  await page.goto(base+"/?view=projects",{waitUntil:"domcontentloaded"});
  await projectCard(page,renamed).waitFor();
  assert.equal((await api(`/api/boards/${id}`)).board.title,renamed);
  console.log("✓ a board can be created, opened as an overview, renamed, and reopened after reload");

  const library = page.getByRole("region",{name:"Unfiled"});
  const pickedName = `Picked source ${run}.md`, droppedName = `Dropped source ${run}.md`;
  const upload = () => expectResponse(page,response=>response.url().endsWith('/api/imports') && response.request().method()==="POST");
  async function landed(pending,name) {
    const response = await pending;
    assert.equal(response.status(),201);
    const {import:job} = await response.json();
    // a deadline, not a count of tries: a loaded machine is slower, not wrong
    const result = await until(async()=>{
      const r=(await api(`/api/imports/${job.id}`)).import;
      if(r.stage==='error')throw new Error(r.error);
      return r.stage==='imported' && r;
    },{what:`the import of ${name}`,timeout:120_000});
    assert.equal(result.stage,'imported');
    resources.push(result.resource_id);
    assert.equal(result.board_id,"inbox","home intake targets the inbox even after a board was open");
    await library.getByRole("link",{name,exact:true}).waitFor();
    assert.equal(page.url(),base+"/?view=projects");
    return result.resource_id;
  }
  const picked = upload();
  const chooser = page.waitForEvent("filechooser");
  await library.getByRole("button",{name:"+ Add file",exact:true}).click();
  await (await chooser).setFiles({name:pickedName,mimeType:"text/markdown",buffer:Buffer.from("# Picked source\nA source added from the home file picker.")});
  const pickedId = await landed(picked,pickedName);
  const dropped = upload();
  const transfer = await page.evaluateHandle(name=>{
    const data = new DataTransfer();
    data.items.add(new File(["# Dropped source\nA source dropped onto home."],name,{type:"text/markdown"}));
    return data;
  },droppedName);
  await page.locator(".launcher").dispatchEvent("drop",{dataTransfer:transfer});
  await transfer.dispose();
  const droppedId = await landed(dropped,droppedName);
  console.log("✓ home file picker and file drop save unfiled sources, refresh the library, and preserve the current screen");

  const row = name=>library.locator(".rg-row").filter({has:page.getByRole("link",{name,exact:true})});
  const sourceTitle = `Retitled source ${run}`;
  await row(pickedName).getByRole("button",{name:`Actions for ${pickedName}`,exact:true}).click();
  await row(pickedName).getByRole("menuitem",{name:"rename",exact:true}).click();
  const sourceRename = expectResponse(page,response=>response.url()===`${base}/api/boards/inbox/resources/${pickedId}` && response.request().method()==="PATCH");
  await library.locator(".rg-rename").fill(sourceTitle);
  await library.locator(".rg-rename").press("Enter");
  assert.equal((await sourceRename).status(),200);
  await row(sourceTitle).getByRole("button",{name:"File to board",exact:true}).click();
  const picker = page.getByRole("dialog",{name:"File to a board"});
  await picker.getByRole("searchbox",{name:"Find a board"}).fill(renamed);
  await picker.getByRole("button",{name:renamed,exact:true}).click();
  // filed, it leaves Unfiled for its project's loose ends
  await row(sourceTitle).waitFor({state:"detached"});
  await projectCard(page,renamed).click();
  await page.locator(".pp-sname").filter({hasText:sourceTitle}).click();
  await page.locator(".page").getByText("A source added from the home file picker.",{exact:false}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("board"),id);
  assert.equal(new URL(page.url()).searchParams.get("resource"),pickedId);
  await page.reload({waitUntil:"domcontentloaded"});
  await page.locator(".page").getByText("A source added from the home file picker.",{exact:false}).waitFor();
  console.log("✓ a source can be renamed, filed to a new board, opened, and read after reloading its link");

  await page.getByRole("button",{name:"boards",exact:true}).click();
  await navTo(page,"Projects").click();
  await row(droppedName).getByRole("button",{name:`Actions for ${droppedName}`,exact:true}).click();
  await row(droppedName).getByRole("menuitem",{name:"delete",exact:true}).click();
  await row(droppedName).getByRole("menuitem",{name:"delete this source?",exact:true}).waitFor();
  await page.keyboard.press("Escape");
  assert.ok((await api("/api/register")).entries.some(entry=>entry.resourceId===droppedId),"cancelling delete keeps the source");
  await row(droppedName).getByRole("button",{name:`Actions for ${droppedName}`,exact:true}).click();
  await row(droppedName).getByRole("menuitem",{name:"delete",exact:true}).click();
  await row(droppedName).getByRole("menuitem",{name:"delete this source?",exact:true}).click();
  await row(droppedName).waitFor({state:"detached"});
  assert.equal((await fetch(`${base}/api/boards/inbox/resources/${droppedId}/raw`)).status,404);
  const deleted = expectResponse(page,response=>response.url()===`${base}/api/boards/${id}` && response.request().method()==="DELETE");
  await projectCard(page,renamed).click();
  await page.getByRole("button",{name:"Project menu",exact:true}).click();
  // the first click only arms the delete
  await page.getByRole("button",{name:"Delete",exact:true}).click();
  await page.getByRole("button",{name:"Delete it, its sources and cards?",exact:true}).click();
  assert.equal((await deleted).status(),200);
  await page.goto(base+"/?view=projects",{waitUntil:"domcontentloaded"});
  await page.locator(".pj-card").first().waitFor();
  assert.equal(await projectCard(page,renamed).count(),0);
  assert.equal((await fetch(`${base}/api/boards/${id}`)).status,404);
  assert.equal((await fetch(`${base}/api/boards/${id}/resources/${pickedId}/raw`)).status,404);
  console.log("✓ source deletion can be cancelled or confirmed, and deleting a board removes it and its source after reload");

  const phone = await browser.newPage({serviceWorkers:"block",viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  phone.on("pageerror",error=>errors.push(error.message));
  await phone.goto(base,{waitUntil:"domcontentloaded"});
  const phoneTitle = `Phone board ${run}`;
  await createBoard(phone,phoneTitle);
  await navTo(phone,"Today").click();
  await (await expandBoards(phone)).getByRole("button",{name:phoneTitle,exact:true}).click();
  await phone.locator(".pp-title").filter({hasText:phoneTitle}).waitFor();
  assert.deepEqual(errors,[]);
  console.log("✓ phone home can create a board and return to it");
} finally {
  await browser.close();
  const register = await api("/api/register");
  for (const resource of register.entries.filter(entry=>resources.includes(entry.resourceId))) {
    const response = await fetch(`${base}/api/boards/${resource.boardId}/resources/${resource.resourceId}?pairs=1`,{method:"DELETE"});
    assert.ok(response.ok || response.status===404);
  }
  for (const id of boards) {
    const response = await fetch(`${base}/api/boards/${id}`,{method:"DELETE"});
    assert.ok(response.ok || response.status===404);
  }
}
