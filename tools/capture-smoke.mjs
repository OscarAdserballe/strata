import assert from "node:assert/strict";
import { chromium } from "playwright";
import { ytDlpCommand } from "../server/features/capture/capture.ts";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path,method="GET",body) => {
  const response = await fetch(base+path,{method,headers:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  assert.ok(response.ok,`${method} ${path}: ${response.status}`);
  return response.json();
};
const url = "https://www.youtube.com/watch?v=PUv66718DII";
const title = `YouTube capture ${Date.now()}`;
const articleUrl = "https://example.test/capture-smoke";
const articleTitle = `Article capture ${Date.now()}`;
const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nAn idea becomes useful when you can act on it.\n\n00:00:50.000 --> 00:00:55.000\nPractice makes the idea concrete.\n";
const board = (await api("/api/boards","POST",{title:"Capture board fixture"})).board;
const saved = [];
const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || undefined});
try {
  const context = await browser.newContext({serviceWorkers:"block",viewport:{width:1440,height:1000}});
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const requests = [],errors = [];
  page.on("pageerror",error=>errors.push(error.message));
  // Provider responses are stubbed; no YouTube or article service is called.
  let articleAttempts = 0;
  const articleKeys = [];
  await page.route("**/api/boards/*/capture",async route=>{
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.url===articleUrl) {
      articleKeys.push(route.request().headers()["idempotency-key"]);
      if (++articleAttempts===1) return route.fulfill({status:502,json:{error:"Article provider temporarily unavailable"}});
      const id = new URL(route.request().url()).pathname.split("/")[3];
      const source = await api(`/api/boards/${id}/resources`,"POST",{filename:articleTitle,text:`# ${articleTitle}\n\nA saved article remains readable.`,pair:true});
      saved.push({board:id,id:source.id});
      return route.fulfill({status:201,json:{kind:"article",resourceId:source.id,title:articleTitle,state:source.state}});
    }
    return route.fulfill({json:{kind:"youtube",url,title,author:"Capture fixture",ytDlpCommand:ytDlpCommand(url),ytDlpCommands:{macos:ytDlpCommand(url),windows:ytDlpCommand(url,"windows")}}});
  });
  await page.goto(base,{waitUntil:"domcontentloaded"});
  const cap = page.locator(".cap");
  async function fromHome() {
    await page.getByRole("textbox",{name:"Link to save"}).fill(url);
    await page.getByRole("button",{name:"Save link",exact:true}).click();
    await cap.waitFor();
    const onTop = await cap.evaluate(el=>{
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x+box.width/2,box.y+25));
    });
    assert.equal(onTop,true,"capture dialog must be above the home screen and accept clicks");
    await cap.getByText(title,{exact:true}).waitFor();
  }
  await fromHome();
  await cap.getByRole("button",{name:"Windows",exact:true}).click();
  assert.match(await cap.locator("pre.cmd").last().textContent(),/Set-Clipboard/);
  await cap.getByText("First time? Set up yt-dlp",{exact:true}).click();
  assert.match(await cap.locator("details").textContent(),/winget install/);
  await cap.getByRole("button",{name:"Mac",exact:true}).click();
  assert.match(await cap.locator("pre.cmd").last().textContent(),/pbcopy/);
  assert.match(await cap.locator("details").textContent(),/brew install yt-dlp deno/);
  assert.equal(requests.length,1,"home hands the existing YouTube response to the caption dialog");
  await cap.getByRole("button",{name:"cancel",exact:true}).click();
  await cap.waitFor({state:"detached"});
  assert.equal(page.url(),base+"/","cancelling stays home");
  assert.ok(!(await api("/api/register")).entries.some(entry=>entry.filename===title));

  await fromHome();
  await cap.locator("textarea").fill(vtt);
  const finished = page.waitForResponse(response=>response.request().method()==="POST" && response.url().endsWith("/capture/finish"));
  await cap.getByRole("button",{name:"add the transcript",exact:true}).click();
  const result = await (await finished).json();
  assert.ok(result.resourceId,JSON.stringify(result));
  saved.push({board:result.state.board.id,id:result.resourceId});
  await cap.waitFor({state:"detached"});
  assert.equal(page.url(),base+"/","adding a transcript stays home");
  await page.getByRole("region",{name:"Your library"}).getByRole("link",{name:title,exact:true}).waitFor();
  const raw = await (await fetch(`${base}/api/boards/inbox/resources/${result.resourceId}/raw`)).text();
  assert.match(raw,/\[0:00\] An idea becomes useful/);
  assert.match(raw,/\[0:50\] Practice makes the idea concrete/);
  console.log("✓ YouTube save opens a clickable caption dialog above home, cancels cleanly, and saves into the visible library without navigating");

  await page.getByRole("textbox",{name:"Link to save"}).fill(articleUrl);
  await page.getByRole("button",{name:"Save link",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"Article provider temporarily unavailable"}).waitFor();
  assert.equal(await page.getByRole("textbox",{name:"Link to save"}).inputValue(),articleUrl,"a failed capture retains the pasted link");
  assert.equal(await cap.count(),0);
  await page.getByRole("button",{name:"Save link",exact:true}).click();
  await page.getByRole("region",{name:"Your library"}).getByRole("link",{name:articleTitle,exact:true}).waitFor();
  assert.equal(page.url(),base+"/");
  assert.equal(articleAttempts,2);
  // pressing again reuses the Idempotency-Key, so a lost answer is replayed, not a second article
  assert.match(articleKeys[0] || "",/^[A-Za-z0-9-]{8,80}$/,"the form's capture goes under a key");
  assert.equal(articleKeys[1],articleKeys[0],"the same link pressed again goes under the same key");
  await page.reload({waitUntil:"domcontentloaded"});
  await page.getByRole("region",{name:"Your library"}).getByRole("link",{name:articleTitle,exact:true}).waitFor();
  console.log("✓ a failed article capture explains the error, retains the link for retry, and persists the successful retry after reload");

  await page.goto(`${base}/?board=${board.id}`,{waitUntil:"domcontentloaded"});
  await page.locator(".bp-hname").filter({hasText:board.title}).waitFor();
  await page.getByTitle("add a source — a file, or from a link",{exact:true}).click();
  await page.locator(".addmenu").getByRole("button",{name:"from a link youtube / article",exact:true}).click();
  await cap.locator("input").fill(url);
  await cap.getByRole("button",{name:"fetch it",exact:true}).click();
  await cap.getByText(title,{exact:true}).waitFor();
  await cap.getByRole("button",{name:"cancel",exact:true}).click();
  assert.equal(new URL(page.url()).searchParams.get("board"),board.id);
  assert.equal(requests.filter(request=>request.url===url).length,3,"each submitted YouTube link requests metadata once");
  assert.deepEqual(errors,[]);
  console.log("✓ board link capture still opens the caption step and retains the selected board");
} finally {
  await browser.close();
  for (const resource of saved) await api(`/api/boards/${resource.board}/resources/${resource.id}?pairs=1`,"DELETE");
  await api(`/api/boards/${board.id}`,"DELETE");
}
