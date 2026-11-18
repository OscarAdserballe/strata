import assert from "node:assert/strict";
import { chromium } from "playwright";

// A primer from the reader's side: ask for one, see it asked, and open it once the routine has written it.
const base = process.argv[2] || "http://127.0.0.1:8804";
const shot = process.env.PRIMER_SHOT || null;
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const MD = "# Panel data\n\nFixed effects remove anything constant within a unit. Random effects assume it is uncorrelated with the regressors.\n\n## The Hausman test\n\nIf the two estimates differ, random effects is inconsistent.\n";
const PRIMER = `<!doctype html><html><head><style>body{margin:0;font:15px/1.5 system-ui;background:#fbfaf7;color:#22201c}main{padding:18px}
h1{font-size:19px;margin:0 0 6px}.s{display:flex;gap:8px;margin:10px 0}.s b{flex:1;border-radius:8px;padding:8px;color:#fff;font-weight:500}
.fe{background:#3d5f91}.re{background:#8a5a14}</style></head><body><main><h1>Fixed or random effects: the Hausman test decides</h1>
<div class="s"><b class="fe">Fixed effects: drop what never changes</b><b class="re">Random effects: assume it is unrelated</b></div>
<p>Follow two threads; the test at the end says which one to trust.</p></main></body></html>`;

const board = (await api("/api/boards", "POST", { title: `Primer fixture ${Date.now()}` })).board;
const r = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "panel.md", base64: Buffer.from(MD).toString("base64"), pair: true });
const pair = r.state.pairs.find((p) => p.resourceId === r.id);
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 820 } })).newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?board=${board.id}&pair=${pair.id}`, { waitUntil: "networkidle" });
  await page.click(".rbar-chip.primer");
  await page.click(".primer-ask");
  await page.waitForSelector(".primer-panel >> text=Your routine is writing it");
  assert.equal((await api(`/api/boards/${board.id}/resources/${r.id}/primer`)).status, "asked");
  console.log("✓ Make a primer asks the routine and says it is being written");

  const { token } = await api("/api/agent/tokens", "POST", { name: "primer smoke", write: true });
  const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "apply", arguments: { board: board.id, key: `primer-smoke-${Date.now()}`, ops: [{ op: "set_primer", source: `src_${r.id}`, html: PRIMER }] } } }) });
  assert.equal((await mcp.json()).result.isError, undefined);

  await page.reload({ waitUntil: "networkidle" });
  await page.click(".rbar-chip.primer");
  const frame = await (await page.waitForSelector(".primer-panel iframe", { timeout: 15000 })).contentFrame();
  await frame.waitForSelector("h1");
  assert.match(await frame.textContent("h1"), /Hausman/);
  assert.ok(await page.$(".page .prose, .page .page-col"), "the source stays open beside it");
  if (shot) await page.screenshot({ path: shot });
  assert.deepEqual(errors, []);
  console.log("✓ the written primer opens beside the source, in a sandboxed frame");
} finally {
  await browser.close();
  await fetch(`${base}/api/boards/${board.id}`, { method: "DELETE" });
}
