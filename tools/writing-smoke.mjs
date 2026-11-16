import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/writing-smoke.mjs [base]: the dashboard's Writer keeps what you type through a save, keeps focus and the caret, formats, takes images, and keeps the last line in view.
const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
let n = 0;
const run = Date.now().toString(36);
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": `writing-${run}-${++n}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const tid = () => "t_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const bodyOf = async (id) => (await api("/api/dashboard")).tasks.find((t) => t.id === id)?.body;
async function settle(id, want, ms = 6000) {
  const until = Date.now() + ms;
  let got;
  while (Date.now() < until) { got = await bodyOf(id); if (typeof want === "function" ? want(got) : got === want) return got; await new Promise((r) => setTimeout(r, 200)); }
  return got;
}
async function open(page, title, body = "") {
  const id = tid();
  await api("/api/dashboard/tasks", "POST", { id, title, body, area: "work", stage: "thinking" });
  await page.goto(`${base}/dashboard?view=thinking`, { waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(title).click();
  await page.locator(".ProseMirror.dbody").waitFor();
  return id;
}
const md = (page) => page.evaluate(() => document.querySelector(".ProseMirror.dbody").editor.getMarkdown());
const inField = (page) => page.evaluate(() => document.activeElement?.classList.contains("dbody") ?? false);
// a real PNG, as a screenshot paste or a dropped file carries it
const withImage = (page, kind) => page.evaluate(async (kind) => {
  const c = Object.assign(document.createElement("canvas"), { width: 40, height: 30 });
  const g = c.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, 40, 30);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
  const field = document.querySelector(".ProseMirror.dbody");
  if (kind === "paste") field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  else { const r = field.getBoundingClientRect(); field.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 })); }
}, kind);

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // a bullet list typed with pauses that each save: none takes back a key, the caret or focus
  const id = await open(page, `Writing ${run}: a list with pauses`);
  await page.locator(".ProseMirror.dbody").click();
  const steps = [["- buy tape", "- buy tape"], ["Enter", "- buy tape\n- "], ["fetch poster ", "- buy tape\n- fetch poster "], ["Enter", null], ["glue", "- buy tape\n- fetch poster \n- glue"],
    ["Enter", null], ["Enter", null], ["Then hang it.", "- buy tape\n- fetch poster \n- glue\n\nThen hang it."]];
  for (const [keys, want] of steps) {
    if (keys === "Enter") await page.keyboard.press("Enter"); else await page.keyboard.type(keys, { delay: 15 });
    await page.waitForTimeout(1300);
    assert.equal(await inField(page), true, `the notes keep focus through a save (after ${JSON.stringify(keys)})`);
    if (want !== null && !want.endsWith("- ")) assert.equal(await md(page), want, `the field holds what was typed (after ${JSON.stringify(keys)})`);
  }
  const typed = "- buy tape\n- fetch poster \n- glue\n\nThen hang it.";
  assert.equal(await settle(id, typed), typed, "the server keeps the list, its spaces and its paragraphs as typed");
  assert.equal(await page.locator(".dbody li").count(), 3, "three bullets, none nested");
  // typed in the middle after a save: the caret stays where the keys go
  await page.locator(".dbody li").nth(1).click();
  await page.keyboard.press("Home");
  await page.keyboard.type("go ", { delay: 15 });
  await page.waitForTimeout(1300);
  await page.keyboard.type("and ", { delay: 15 });
  assert.equal(await md(page), "- buy tape\n- go and fetch poster \n- glue\n\nThen hang it.", "the caret stays put through a save");
  console.log("✓ a bullet list typed with pauses keeps every key, the caret and focus");

  // bold and italics from the keyboard, stored as Markdown
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+b"); await page.keyboard.type("loud", { delay: 15 }); await page.keyboard.press("Control+b");
  await page.keyboard.type(" and ", { delay: 15 });
  await page.keyboard.press("Control+i"); await page.keyboard.type("soft", { delay: 15 }); await page.keyboard.press("Control+i");
  const styled = await settle(id, (b) => b?.endsWith("**loud** and *soft*"));
  assert.ok(styled?.endsWith("\n\n**loud** and *soft*"), `bold and italics save as Markdown (${JSON.stringify(styled)})`);
  console.log("✓ ⌘B and ⌘I save as **bold** and *italics*");

  // a pasted screenshot and a dropped image upload, show in the field and save as stored refs
  await withImage(page, "paste");
  const pasted = await settle(id, (b) => /!\[\]\(img:[0-9a-f]{16}\)/.test(b ?? ""), 10000);
  assert.match(pasted ?? "", /!\[\]\(img:[0-9a-f]{16}\)/, "a pasted image is saved as a stored ref");
  await page.locator(".dbody img.strata-img").first().waitFor();
  assert.ok(await page.locator(".dbody img.strata-img").first().evaluate((img) => img.complete && img.naturalWidth > 0), "the pasted image draws");
  assert.equal(await inField(page), true, "pasting keeps focus");
  await withImage(page, "drop");
  await page.waitForFunction(() => document.querySelectorAll(".dbody img.strata-img").length === 2, null, { timeout: 10000 });
  console.log("✓ a pasted and a dropped image upload, draw and save");

  // the last line of a long doc stays above the sticky footer while you type at it
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n\n");
  await open(page, `Writing ${run}: a long doc`, long);
  await page.locator(".ProseMirror.dbody").click();
  await page.keyboard.press("Control+End");
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Enter"); await page.keyboard.type(`more ${i}`, { delay: 10 }); }
  const gap = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getBoundingClientRect(), foot = document.querySelector(".doc-foot");
    return foot.getBoundingClientRect().top - r.bottom;
  });
  assert.ok(gap >= 0, `the line being typed sits above the footer, not under it (${gap.toFixed(0)}px)`);
  console.log("✓ the last line of a long doc stays above the footer");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
