import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/dispatch-smoke.mjs [base]: Dispatch draws a page posted while Decide is open, drops threads from Decide and Thinking,
// opens to-do from the header and shows an admin the deploy dot.
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

  // the header's To-do opens Triage on to-do and counts both areas, in grey
  const todos = (await api("/api/dashboard")).tasks.filter((t) => t.stage === "todo").length;
  await api("/api/dashboard/tasks", "POST", { id: tid(), title: `Smoke ${run}: a personal to-do`, body: "", area: "personal", stage: "todo" });
  await page.goto(`${base}/dashboard?view=thinking`, { waitUntil: "networkidle" });
  const todo = page.locator("header.dh").getByRole("button", { name: /^To-do/ });
  await todo.waitFor({ timeout: 5000 });
  assert.equal((await todo.locator("i").innerText()).trim(), String(todos + 1), "To-do counts work and personal");
  assert.notEqual(await todo.locator("i").evaluate((el) => getComputedStyle(el).backgroundColor), await page.locator(".dh-inbox i").first().evaluate((el) => getComputedStyle(el).backgroundColor), "To-do's count isn't the inbox's orange");
  await todo.click();
  assert.match(page.url(), /view=triage&sub=todo/);
  await page.locator(".tr-main #addIn").waitFor({ timeout: 5000 });
  assert.equal(await todo.getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator(".tr-nav").count(), 0, "Triage has no To-do tab of its own");
  console.log("✓ To-do in the header opens the list");

  // an admin's dashboard, mounted under /u/<slug>/ as the gateway does, shows the deploy dot by the clock
  const line = "orange: two commits behind main";
  await page.route("**/api/session", (r) => r.fulfill({ json: { adminPath: "/admin", deploy: { level: "orange", line } } }));
  await page.route("**/u/smoke/**", async (r) => {
    const u = new URL(r.request().url()), res = await r.fetch({ url: base + u.pathname.replace(/^\/u\/smoke/, "") + u.search });
    if (!(res.headers()["content-type"] ?? "").includes("text/html")) return r.fulfill({ response: res });
    r.fulfill({ response: res, body: (await res.text()).replace(/STRATA_BASE = "\/"/, 'STRATA_BASE = "/u/smoke/"') });
  });
  await page.goto(`${base}/u/smoke/dashboard`, { waitUntil: "networkidle" });
  const dot = page.locator(".dh-side.end").getByRole("img", { name: `Deploy: ${line}` });
  await dot.waitFor({ timeout: 5000 });
  assert.equal(await dot.getAttribute("title"), `Deploy: ${line}`);
  await page.unrouteAll({ behavior: "wait" });
  await page.goto(`${base}/dashboard`, { waitUntil: "networkidle" });
  assert.equal(await page.locator(".dh-side.end [role=img]").count(), 0, "no dot outside a gateway room");
  console.log("✓ the deploy dot shows for an admin");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
