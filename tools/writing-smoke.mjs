import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/writing-smoke.mjs [base]: the shared editor keeps what you type through a save, writes marks and images as Markdown, and keeps the last line in view.
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
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  const field = page.locator(".writer.dbody");
  const focusedInField = () => page.evaluate(() => !!document.activeElement?.closest(".writer"));

  // a list typed with pauses between items: each pause saves, and none of them takes back a space, a newline or the caret
  const id = await open(page, `Writing ${run}: a list with pauses`);
  await field.click();
  for (const part of ["- buy tape", "Enter", "fetch poster ", "Enter", "and glue"]) {
    if (part === "Enter") await page.keyboard.press("Enter"); else await page.keyboard.type(part, { delay: 15 });
    await page.waitForTimeout(1500);
    assert.equal(await focusedInField(), true, "the notes keep focus through a save");
  }
  assert.deepEqual(await field.locator("li").allInnerTexts(), ["buy tape", "fetch poster ", "and glue"], "the list shows as typed");
  await page.waitForTimeout(1500);
  assert.equal(await bodyOf(id), "- buy tape\n- fetch poster \n- and glue", "the server keeps the list and its spaces as Markdown");
  // typed in the middle: the caret stays where the keys go, not at the end after the save answers
  await page.keyboard.press("Home");
  await page.keyboard.type("more ", { delay: 15 });
  await page.waitForTimeout(1500);
  await page.keyboard.type("+", { delay: 15 });
  assert.deepEqual(await field.locator("li").allInnerTexts(), ["buy tape", "fetch poster ", "more +and glue"]);
  console.log("✓ a list typed with pauses keeps every item, the caret and focus");

  // marks: by key, by typing them, and from the bar over a selection
  await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.press("Control+b"); await page.keyboard.type("loud", { delay: 15 }); await page.keyboard.press("Control+b");
  await page.keyboard.type(" and *soft* words", { delay: 15 });
  await page.keyboard.press("Shift+Home");
  await page.locator(".writer-marks").getByTitle(/Strike/).click();
  await page.waitForTimeout(1500);
  const marked = await bodyOf(id);
  assert.match(marked, /~~\*\*loud\*\* and \*soft\* words~~|~~\*\*loud\*\*~~~~ and \*soft\* words~~/, `bold, italic and strike are stored as Markdown (${JSON.stringify(marked)})`);
  console.log("✓ bold by key, italics by typing them, strike from the bar");

  // a pasted screenshot uploads and sits in the notes as an image ref
  await page.keyboard.press("End");
  await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 40; c.height = 20;
    const g = c.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, 40, 20);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await field.locator("img").waitFor({ timeout: 10000 });
  await page.waitForTimeout(1500);
  assert.match(await bodyOf(id), /!\[[^\]]*\]\(img:[0-9a-f]{16}\)/, "the image is stored as a ref, not a URL");
  assert.equal(await field.locator("img").evaluate((i) => i.complete && i.naturalWidth > 0), true, "the image draws");
  console.log("✓ a pasted image uploads and shows in the notes");

  // the stored text comes back the same on a reload
  const before = await bodyOf(id);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(`Writing ${run}: a list with pauses`).click();
  await field.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("!", { delay: 15 });
  await page.waitForTimeout(1500);
  // after an image the key starts a new paragraph; nothing else may change
  assert.equal((await bodyOf(id)).replace(/\n*!$/, ""), before, "reopening and typing changes only what was typed");
  console.log("✓ reopened notes round-trip unchanged");

  // the last line of a long doc stays above the footer while you type at it
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n");
  await open(page, `Writing ${run}: a long doc`, long);
  await field.click();
  await page.keyboard.press("Control+End");
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Enter"); await page.keyboard.type(`more ${i}`, { delay: 10 }); }
  const gap = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getClientRects()[0] ?? getSelection().focusNode.parentElement.getBoundingClientRect();
    return document.querySelector(".doc-foot").getBoundingClientRect().top - r.bottom;
  });
  assert.ok(gap >= 0, `the line being typed sits above the footer, not under it (${gap.toFixed(0)}px)`);
  console.log("✓ the last line of a long doc stays above the footer");

  // Triage's prompt is the same editor
  const tri = tid(), triTitle = `Writing ${run}: a backlog prompt`;
  await api("/api/dashboard/tasks", "POST", { id: tri, title: triTitle, body: "", area: "work", stage: "backlog" });
  await page.goto(`${base}/dashboard?view=triage&sub=backlog`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: triTitle }).click();
  const prompt = page.locator(".tr-card .writer.dbody");
  await prompt.click();
  await page.keyboard.press("Control+i"); await page.keyboard.type("just this", { delay: 15 });
  await page.waitForTimeout(1500);
  assert.equal(await bodyOf(tri), "*just this*", "the Triage prompt stores Markdown from the same editor");
  console.log("✓ Triage's prompt writes with the same editor");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
