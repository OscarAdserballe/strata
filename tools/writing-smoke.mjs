import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/writing-smoke.mjs [base]: the dashboard's Writer keeps what you type through a save, keeps focus, stores Markdown,
// takes bold, italics and pasted images, and keeps the last line in view.
const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
let n = 0;
const run = Date.now().toString(36);
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": `writing-${run}-${++n}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const tid = () => "t_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const bodyOf = async (id) => (await api("/api/dashboard")).tasks.find((t) => t.id === id)?.body;
async function open(page, title, body = "") {
  const id = tid();
  await api("/api/dashboard/tasks", "POST", { id, title, body, area: "work", stage: "thinking" });
  await page.goto(`${base}/dashboard?view=thinking`, { waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(title).click();
  return id;
}

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const items = (page, sel = ".dbody") => page.locator(`${sel} li`).allInnerTexts();
const focused = (page) => page.evaluate(() => document.activeElement?.classList.contains("dbody"));
// a pasted screenshot, drawn in the page so no file is needed
const pasteImage = (page, sel) => page.evaluate(async (sel) => {
  const c = document.createElement("canvas"); c.width = 160; c.height = 90;
  const g = c.getContext("2d"); g.fillStyle = "#3a7"; g.fillRect(0, 0, 160, 90);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const dt = new DataTransfer(); dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
  document.querySelector(sel).dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, sel);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [], writes = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (r.method() !== "GET") writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });

  // a list typed with pauses between items: each pause saves, and none of them takes back a key, the caret or focus
  const id = await open(page, `Writing ${run}: a list with pauses`);
  await page.getByRole("textbox", { name: "Notes" }).click();
  for (const part of ["- buy tape", "Enter", "fetch poster ", "Enter", "and glue"]) {
    if (part === "Enter") await page.keyboard.press("Enter"); else await page.keyboard.type(part, { delay: 15 });
    await page.waitForTimeout(1200);
    assert.equal(await focused(page), true, "the notes keep focus through a save");
  }
  assert.deepEqual(await items(page), ["buy tape", "fetch poster ", "and glue"], "the field shows the list as typed, the trailing space too");
  await page.waitForTimeout(1200);
  assert.equal(await bodyOf(id), "- buy tape\n- fetch poster \n- and glue", "the server keeps the list as Markdown, the trailing space too");
  // typed in the middle: the caret stays where the keys go, not at the end after the save answers
  await page.keyboard.press("Home");
  await page.keyboard.type("now ", { delay: 15 });
  await page.waitForTimeout(1200);
  await page.keyboard.type("+", { delay: 15 });
  assert.deepEqual(await items(page), ["buy tape", "fetch poster ", "now +and glue"]);
  console.log("✓ a list typed with pauses keeps every key, the caret and focus, and is stored as Markdown");

  // bold and italics from the keyboard, stored as Markdown
  await page.waitForTimeout(100);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Then ", { delay: 15 });
  await page.keyboard.press("Control+b"); await page.keyboard.type("hang", { delay: 15 }); await page.keyboard.press("Control+b");
  await page.keyboard.type(" it ", { delay: 15 });
  await page.keyboard.press("Control+i"); await page.keyboard.type("now", { delay: 15 }); await page.keyboard.press("Control+i");
  await page.waitForTimeout(1200);
  assert.equal(await bodyOf(id), "- buy tape\n- fetch poster \n- now +and glue\n\nThen **hang** it *now*");
  console.log("✓ bold and italics are typed with the keyboard and stored as Markdown");

  // a pasted screenshot uploads, lands where the caret was, and is stored as the room's image token
  await page.keyboard.press("Enter");
  await pasteImage(page, ".dbody");
  await page.locator(".dbody img").waitFor({ timeout: 8000 });
  await page.keyboard.type("below it", { delay: 15 });
  await page.waitForTimeout(1200);
  const withImage = await bodyOf(id);
  assert.match(withImage, /\*now\*\n\n!\[\]\(img:[0-9a-f]{16}\)\n\nbelow it$/, `the image is stored as a token, with typing carrying on under it: ${JSON.stringify(withImage)}`);
  // opened again: the image shows and nothing is written just by opening
  writes.length = 0;
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(`Writing ${run}: a list with pauses`).click();
  const img = page.locator(".dbody img");
  await img.waitFor({ timeout: 8000 });
  await page.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle());
  await page.waitForTimeout(900);
  assert.deepEqual(writes, [], "opening a doc writes nothing");
  assert.equal(await bodyOf(id), withImage);
  console.log("✓ a pasted image is stored, shown again, and opening the doc writes nothing");

  // the last line of a long doc stays above the footer while you type at it
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n\n");
  await open(page, `Writing ${run}: a long doc`, long);
  await page.locator(".dbody p", { hasText: "Line 60 of" }).click();
  await page.keyboard.press("End");
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Enter"); await page.keyboard.type(`more ${i}`, { delay: 10 });
    const gap = await page.evaluate(() => document.querySelector(".doc-foot").getBoundingClientRect().top - getSelection().getRangeAt(0).getBoundingClientRect().bottom);
    assert.ok(gap >= 0, `the line being typed sits above the footer, not under it (${gap.toFixed(0)}px)`);
  }
  console.log("✓ the last line of a long doc stays above the footer");

  // Triage's prompt is the same Writer: a list with pauses and a pasted image
  const tri = tid(), title = `Writing ${run}: triage`;
  await api("/api/dashboard/tasks", "POST", { id: tri, title, body: "", area: "work" });
  await page.goto(`${base}/dashboard?view=triage&sub=todo`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: /^Work/ }).click();
  await page.locator(".r", { hasText: title }).locator(".t").click();
  await page.locator(".tr-card.open .dtitle").click();
  await page.keyboard.press("Enter");
  assert.equal(await focused(page), true, "Enter in the title goes on to the prompt");
  for (const part of ["- one", "Enter", "two"]) {
    if (part === "Enter") await page.keyboard.press("Enter"); else await page.keyboard.type(part, { delay: 15 });
    await page.waitForTimeout(1000);
    assert.equal(await focused(page), true, "the prompt keeps focus through a save");
  }
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await pasteImage(page, ".tr-card.open .dbody");
  await page.locator(".tr-card.open .dbody img").waitFor({ timeout: 8000 });
  await page.waitForTimeout(1200);
  assert.match(await bodyOf(tri), /^- one\n- two\n\n!\[\]\(img:[0-9a-f]{16}\)$/);
  console.log("✓ Triage's prompt takes a list with pauses and a pasted image");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
