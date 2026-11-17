import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/dispatch-smoke.mjs [base]: Dispatch draws a page posted while Decide is open, drops threads from Decide and Thinking, opens To-do from the header, and writes new threads from its sidebar.
const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
let n = 0;
const key = () => `smoke-${Date.now().toString(36)}-${++n}`;
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": key() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const token = (await api("/api/agent/tokens", "POST", { name: "dispatch smoke", write: true })).token;
const tool = async (name, args) => {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result; assert.ok(!res.isError, res.content?.[0]?.text); return res.content[0].text;
};
const run = Date.now().toString(36);
const tid = () => "t_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
async function thread(title, stage = "backlog") { const id = tid(); await api("/api/dashboard/tasks", "POST", { id, title, body: "", area: "work", stage }); return id; }
const stageOf = async (id) => (await api("/api/dashboard")).tasks.find((t) => t.id === id)?.stage ?? null;

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // a page posted after Decide read the board draws without a reload
  const fresh = await thread(`Smoke ${run}: a page posted while Decide is open`);
  await api(`/api/dashboard/tasks/${fresh}/send`, "POST", {});
  await page.goto(`${base}/dispatch?view=decide`, { waitUntil: "networkidle" });
  await tool("dashboard_post", { key: key(), id: fresh, page: "<!doctype html><html><body><h1>Posted while you looked</h1></body></html>" });
  await page.locator(".ws-list").getByText(`Smoke ${run}: a page posted while Decide is open`).click({ timeout: 40000 });
  const frame = await (await page.waitForSelector(".ws-sheet iframe.html-frame", { timeout: 15000 })).contentFrame();
  await frame.waitForSelector("text=Posted while you looked", { timeout: 15000 });
  console.log("✓ a page posted while Decide is open draws without a reload");

  // Drop on the open Decide card takes the thread off the board
  await page.getByRole("region", { name: `Smoke ${run}: a page posted while Decide is open` }).getByRole("button", { name: "Drop" }).click();
  await page.waitForSelector(`text=Smoke ${run}: a page posted while Decide is open`, { state: "detached", timeout: 5000 });
  for (let i = 0; i < 20 && (await stageOf(fresh)) !== null; i++) await page.waitForTimeout(250);
  assert.equal(await stageOf(fresh), null, "a dropped Decide thread leaves the board");
  console.log("✓ Drop on a Decide card");

  // Drop in a Thinking doc
  const think = await thread(`Smoke ${run}: a thought not worth keeping`, "thinking");
  await page.goto(`${base}/dashboard?view=thinking`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: `Smoke ${run}: a thought not worth keeping` }).click();
  await page.locator(".doc-foot").getByRole("button", { name: "Drop" }).click();
  for (let i = 0; i < 20 && (await stageOf(think)) !== null; i++) await page.waitForTimeout(250);
  assert.equal(await stageOf(think), null, "a dropped Thinking thread leaves the board");
  console.log("✓ Drop in a Thinking doc");

  // To-do sits beside Inbox in the header and opens the list from any view
  const kept = await thread(`Smoke ${run}: a thread kept in to-do`, "todo");
  await page.goto(`${base}/dispatch?view=decide`, { waitUntil: "networkidle" });
  await page.locator(".dh-todo").click();
  await page.waitForSelector(`text=Smoke ${run}: a thread kept in to-do`, { timeout: 5000 });
  assert.equal(await page.locator(".dh-todo").getAttribute("aria-pressed"), "true");
  assert.match(page.url(), /view=triage&sub=todo/);
  assert.ok(await stageOf(kept));
  console.log("✓ To-do in the header opens the list");

  // + New thread under the cards: N opens it, Esc keeps the draft, Keep files it in to-do with an Undo, Send hands it to Claude
  await page.goto(`${base}/dispatch?view=decide`, { waitUntil: "networkidle" });
  const shown = page.url();
  await page.locator("body").press("n");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByLabel("Title").fill(`Smoke ${run}: kept from Dispatch`);
  await form.getByLabel("Context").fill("Context written in the sidebar.");
  await page.keyboard.press("Escape");
  assert.equal(await form.count(), 0, "Esc closes the form");
  await page.locator(".nt-row").click();
  assert.equal(await form.getByLabel("Title").inputValue(), `Smoke ${run}: kept from Dispatch`, "Esc keeps the draft");
  await form.getByRole("tab", { name: "Personal" }).click();
  await form.getByRole("button", { name: "Keep in to-do" }).click();
  await page.locator(".dash-toast", { hasText: "Kept in to-do" }).getByRole("button", { name: "Undo" }).waitFor();
  assert.equal(page.url(), shown, "Keep leaves the page where it was");
  const keptRow = async (title) => (await api("/api/dashboard")).tasks.find((t) => t.title === title) ?? null;
  let made = null;
  for (let i = 0; i < 20 && !made; i++) { made = await keptRow(`Smoke ${run}: kept from Dispatch`); if (!made) await page.waitForTimeout(250); }
  assert.deepEqual(made && [made.stage, made.body, made.area], ["todo", "Context written in the sidebar.", "personal"], "Keep makes a to-do thread with its context and area");
  console.log("✓ + New thread: N opens it, Esc keeps the draft, Keep files it in to-do");

  await page.locator(".nt-row").click();
  await form.getByLabel("Title").fill(`Smoke ${run}: sent from Dispatch`);
  await form.getByRole("button", { name: "Send to Dispatch" }).click();
  let sent = null;
  for (let i = 0; i < 20 && sent?.stage !== "implementing"; i++) { sent = await keptRow(`Smoke ${run}: sent from Dispatch`); if (sent?.stage !== "implementing") await page.waitForTimeout(250); }
  assert.equal(sent?.stage, "implementing", "Send to Dispatch makes the thread and sends it in one step");
  console.log("✓ + New thread: Send to Dispatch makes and sends it");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
