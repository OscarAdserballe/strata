import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

// node tools/writing-smoke.mjs [base]: a thread's notes keep what you type through a save, keep focus, take bold, italics and pasted images, and the last line stays in view.
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
const inNotes = (page) => page.evaluate(() => !!document.activeElement?.closest(".doc-notes"));
const shown = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".doc-notes .tiptap > :not(p:empty, p:has(> br:only-child))"), (e) => e.tagName === "UL" ? Array.from(e.children, (li) => `• ${li.textContent}`).join("\n") : e.textContent).join("\n"));

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // a list typed with pauses between items: each pause saves, and none of them takes back a space, an item or the caret
  const id = await open(page, `Writing ${run}: a list with pauses`);
  await page.getByRole("textbox", { name: "Notes" }).click();
  for (const part of ["- ", "buy tape", "\n", "fetch poster ", "\n", "and glue"]) {
    await page.keyboard.type(part, { delay: 15 });
    await page.waitForTimeout(1500);
    assert.equal(await inNotes(page), true, "the notes keep focus through a save");
  }
  assert.equal(await shown(page), "• buy tape\n• fetch poster \n• and glue", "the field shows exactly what was typed");
  // leave the list, then bold and italics from the keyboard
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.type("Then ", { delay: 15 });
  await page.keyboard.press("Control+b"); await page.keyboard.type("hang", { delay: 15 }); await page.keyboard.press("Control+b");
  await page.keyboard.type(" it ", { delay: 15 });
  await page.keyboard.press("Control+i"); await page.keyboard.type("today", { delay: 15 }); await page.keyboard.press("Control+i");
  await page.waitForTimeout(1500);
  const md = "- buy tape\n- fetch poster \n- and glue\n\nThen **hang** it *today*";
  assert.equal(await bodyOf(id), md, "the server keeps the notes as Markdown, the trailing space included");
  // typed in the middle: the caret stays where the keys go, not at the end after the save answers
  await page.locator(".doc-notes li").first().click();
  await page.keyboard.press("Home");
  await page.keyboard.type("[x] ", { delay: 15 });
  await page.waitForTimeout(1500);
  await page.keyboard.type("+", { delay: 15 });
  assert.equal((await shown(page)).split("\n")[0], "• [x] +buy tape");
  console.log("✓ a list typed with pauses keeps every space, item, the caret and focus; bold and italics save as Markdown");

  // a pasted image uploads, shows, and is kept as the room's image token
  const png = readFileSync(new URL("../public/apple-touch-icon.png", import.meta.url)).toString("base64");
  await page.keyboard.press("Control+End");
  await page.evaluate((b64) => {
    const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, png);
  await page.locator(".doc-notes img").waitFor();
  await page.waitForFunction(() => document.querySelector(".doc-notes img")?.naturalWidth > 0);
  await page.waitForTimeout(1500);
  assert.match(await bodyOf(id), /\n\n!\[\]\(img:[0-9a-f]{16}\)$/, "the image is saved as an img: token");
  console.log("✓ a pasted image uploads, shows, and saves");

  // the last line of a long doc stays above the footer while you type at it
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n\n");
  await open(page, `Writing ${run}: a long doc`, long);
  await page.getByRole("textbox", { name: "Notes" }).click();
  await page.keyboard.press("Control+End");
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Enter"); await page.keyboard.type(`more ${i}`, { delay: 10 }); }
  const gap = await page.evaluate(() => {
    const sel = getSelection().getRangeAt(0).getBoundingClientRect(), foot = document.querySelector(".doc-foot");
    return foot.getBoundingClientRect().top - sel.bottom;
  });
  assert.ok(gap >= 0, `the line being typed sits above the footer, not under it (${gap.toFixed(0)}px)`);
  console.log("✓ the last line of a long doc stays above the footer");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
