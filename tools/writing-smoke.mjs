import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/writing-smoke.mjs [base]: writing a thread's notes keeps what you type through a save, keeps focus, and the last line stays in view.
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

  // a list typed with pauses between items: each pause saves, and none of them takes back a space, a newline or the caret
  const id = await open(page, `Writing ${run}: a list with pauses`);
  await page.getByRole("textbox", { name: "Notes" }).click();
  const field = page.locator("textarea.dbody");
  const typed = "- buy tape\n- fetch poster \n- ";
  for (const part of ["- buy tape", "\n", "- fetch poster ", "\n", "- "]) {
    await page.keyboard.type(part, { delay: 15 });
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("dbody")), true, "the notes keep focus through a save");
  }
  await page.keyboard.type("and glue", { delay: 15 });
  assert.equal(await field.inputValue(), typed + "and glue", "the field shows exactly what was typed");
  await page.waitForTimeout(1500);
  assert.equal(await bodyOf(id), typed + "and glue", "the server keeps spaces and newlines as typed");
  // typed in the middle: the caret stays where the keys go, not at the end after the save answers
  await page.keyboard.press("Home");
  await page.keyboard.type("[x] ", { delay: 15 });
  await page.waitForTimeout(1500);
  await page.keyboard.type("+", { delay: 15 });
  assert.equal(await field.inputValue(), "- buy tape\n- fetch poster \n[x] +- and glue");
  console.log("✓ a list typed with pauses keeps every space, newline, the caret and focus");

  // the last line of a long doc stays above the footer while you type at it
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n");
  await open(page, `Writing ${run}: a long doc`, long);
  await page.getByRole("textbox", { name: "Notes" }).click();
  await page.keyboard.press("Control+End");
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Enter"); await page.keyboard.type(`more ${i}`, { delay: 10 }); }
  const gap = await page.evaluate(() => {
    const ta = document.querySelector("textarea.dbody"), foot = document.querySelector(".doc-foot");
    const lh = parseFloat(getComputedStyle(ta).lineHeight);
    return foot.getBoundingClientRect().top - (ta.getBoundingClientRect().bottom - parseFloat(getComputedStyle(ta).paddingBottom)) + lh * 0;
  });
  assert.ok(gap >= 0, `the line being typed sits above the footer, not under it (${gap.toFixed(0)}px)`);
  console.log("✓ the last line of a long doc stays above the footer");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
