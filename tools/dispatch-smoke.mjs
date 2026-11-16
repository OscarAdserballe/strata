import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/dispatch-smoke.mjs [base]: a page Claude posts while Decide is open shows without a reload, and Decide and Thinking can drop a thread.
const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
let k = 0, rpc = 0;
const key = () => `dsmoke-${Date.now().toString(36)}-${++k}`;
async function api(path, method = "GET", body) {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": key() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(out)}`);
  return out;
}
const token = (await api("/api/agent/tokens", "POST", { name: "dispatch smoke", write: true })).token;
async function post(id, html) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: "dashboard_post", arguments: { key: key(), id, page: html } } }) });
  const res = (await r.json()).result;
  assert.ok(!res.isError, res.content?.[0]?.text);
}
const page = (h) => `<!doctype html><html><head><meta charset="utf-8"><title>${h}</title></head><body><main><h1>${h}</h1><p>Synthetic.</p></main></body></html>`;
async function thread(title, stage = "backlog") {
  const id = `t_smoke${Math.random().toString(36).slice(2, 12)}`;
  await api("/api/dashboard/tasks", "POST", { id, title, body: "", area: "work", stage });
  return id;
}
const stageOf = async (id) => (await api("/api/dashboard/dispatch")).threads.find((t) => t.id === id)?.stage ?? null;
const tag = Date.now().toString(36);

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const tab = await ctx.newPage(), errors = [];
  tab.on("pageerror", (e) => errors.push(e.message));

  // a page posted while Decide is open: the poller learns of v2, and the sheet draws it without a reload
  const title = `Decide fixture ${tag}`;
  const d = await thread(title);
  await api(`/api/dashboard/tasks/${d}/send`, "POST", {});
  await post(d, page(`First version ${tag}`));
  await api(`/api/dashboard/tasks/${d}/press`, "POST", { kind: "back" });
  await tab.goto(`${base}/dispatch?view=decide`, { waitUntil: "networkidle" });
  await post(d, page(`Second version ${tag}`));
  await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await tab.locator(".ws-card", { hasText: title }).locator(".t").click({ timeout: 10000 });
  const frame = tab.frameLocator("iframe.html-frame");
  await frame.getByRole("heading", { name: `Second version ${tag}` }).waitFor({ timeout: 10000 });
  console.log("✓ a page posted while Decide is open draws without a reload");

  // the same, once more, with v2 already on the sheet: v3 arrives through the poll alone
  await api(`/api/dashboard/tasks/${d}/press`, "POST", { kind: "back" });
  await post(d, page(`Third version ${tag}`));
  await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await frame.getByRole("heading", { name: `Third version ${tag}` }).waitFor({ timeout: 10000 });
  console.log("✓ a newer version replaces the one on the sheet");

  // Drop on the open Decide card: it leaves the list at once and the server has it dropped
  const card = tab.getByRole("region", { name: title });
  await card.getByRole("button", { name: "Drop" }).click();
  await card.waitFor({ state: "detached", timeout: 3000 });
  for (let i = 0; i < 20 && (await stageOf(d)) !== null; i++) await new Promise((r) => setTimeout(r, 150));
  const ended = (await api("/api/dashboard/archive")).tasks.find((t) => t.id === d);
  assert.equal(ended?.stage, "dropped", "the Decide thread is dropped into the archive");
  console.log("✓ Decide drops a thread");

  // Drop in a Thinking doc
  const tTitle = `Thinking fixture ${tag}`;
  const t = await thread(tTitle, "thinking");
  await tab.goto(`${base}/dashboard?view=thinking`, { waitUntil: "networkidle" });
  await tab.getByRole("button", { name: tTitle }).click();
  await tab.locator(".doc-foot").getByRole("button", { name: "Drop" }).click();
  await tab.getByRole("button", { name: tTitle }).waitFor({ state: "detached", timeout: 3000 });
  for (let i = 0; i < 20; i++) { if ((await api("/api/dashboard/archive")).tasks.some((x) => x.id === t)) break; await new Promise((r) => setTimeout(r, 150)); }
  assert.equal((await api("/api/dashboard/archive")).tasks.find((x) => x.id === t)?.stage, "dropped", "the Thinking thread is dropped into the archive");
  console.log("✓ Thinking drops a thread");

  assert.deepEqual(errors, []);
} finally { await browser.close(); }
