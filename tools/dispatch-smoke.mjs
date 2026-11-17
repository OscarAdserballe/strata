import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/dispatch-smoke.mjs [base]: Dispatch draws a page posted while Decide is open, keeps the sheet when another arrives, and drops threads from Decide and Thinking, and To-do opens from the header.
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

  // a thread that arrives while you read doesn't take over the sheet
  const reading = await thread(`Smoke ${run}: the page being read`);
  await api(`/api/dashboard/tasks/${reading}/send`, "POST", {});
  await tool("dashboard_post", { key: key(), id: reading, page: "<!doctype html><html><body><h1>The page being read</h1></body></html>" });
  await page.locator(".ws-list").getByText(`Smoke ${run}: the page being read`).click({ timeout: 40000 });
  const before = await (await page.waitForSelector(".ws-sheet iframe.html-frame", { timeout: 15000 })).contentFrame();
  await before.waitForSelector("text=The page being read", { timeout: 15000 });
  const late = await thread(`Smoke ${run}: a page that arrives later`);
  await api(`/api/dashboard/tasks/${late}/send`, "POST", {});
  await tool("dashboard_post", { key: key(), id: late, page: "<!doctype html><html><body><h1>Arrived later</h1></body></html>" });
  await page.locator(".ws-list").getByText(`Smoke ${run}: a page that arrives later`).waitFor({ timeout: 40000 });
  const after = await (await page.waitForSelector(".ws-sheet iframe.html-frame", { timeout: 15000 })).contentFrame();
  await after.waitForSelector("text=The page being read", { timeout: 5000 });
  assert.equal(await page.locator(".ws-card.open .t").textContent(), `Smoke ${run}: the page being read`);
  console.log("✓ a thread arriving while you read leaves the sheet alone");
  await page.locator(".ws-list").getByText(`Smoke ${run}: a page posted while Decide is open`).click();

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
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
