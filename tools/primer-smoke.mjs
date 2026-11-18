// A source's primer in the reader: asked for from the bar, shown over the pages once written, and its page links turn the PDF.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { book } from "./fixture-pdf.mjs";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body, headers = {}) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status} ${res.ok ? "" : await res.text()}`); return res.json();
};
const PRIMER = `<!doctype html><html><head><style>body{font:15px system-ui;margin:24px}</style></head>
<body><h1 id="map">Three strands</h1><p>Repetition, spacing, and testing.</p><a id="to5" href="#page=5">Spacing starts on p. 5</a></body></html>`;

const board = (await api("/api/boards", "POST", { title: `Primer fixture ${Date.now()}` })).board;
const pdf = book({ chapters: ["Repetition"], pagesPerChapter: 8 });
const r = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "repetition.pdf", base64: pdf.bytes.toString("base64"), pageText: pdf.pageText, pair: true, study: false });
const { token } = await api("/api/agent/tokens", "POST", { name: "primer-smoke", write: true });
const setPrimer = async () => {
  const res = await api("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "apply", arguments: { board: board.id, key: `primer-smoke-${Date.now()}`, ops: [{ op: "set_primer", source: `src_${r.id}`, html: PRIMER }] } } }, { Authorization: `Bearer ${token}` });
  assert.ok(!res.result.isError, res.result.content[0].text);
};

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?board=${board.id}&resource=${r.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".slide", { timeout: 15000 });
  const chip = page.locator(".rbar-primer");
  await chip.click();
  await page.locator(".primer-plane .primer-ask").click();
  await page.locator(".primer-plane", { hasText: "being written" }).waitFor({ timeout: 5000 });
  console.log("✓ the bar's primer chip asks for one, and the panel says it is being written");

  await setPrimer();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".slide", { timeout: 15000 });
  await page.locator(".rbar-primer").click();
  const frame = await (await page.waitForSelector(".primer-plane iframe.html-frame", { timeout: 10000 })).contentFrame();
  await frame.waitForSelector("#map");
  assert.equal(await page.locator(".rbar-primer.ready").count(), 1, "the chip shows a written primer");
  console.log("✓ a written primer shows over the source in its sandboxed frame");

  await frame.click("#to5");
  await page.waitForSelector(".primer-plane", { state: "detached", timeout: 5000 });
  await page.waitForFunction(() => {
    const sc = document.querySelector(".page"), el = document.querySelector("#pg-5");
    return !!sc && !!el && Math.abs(el.getBoundingClientRect().top - sc.getBoundingClientRect().top) < 40;
  }, null, { timeout: 5000 });
  console.log("✓ a page link in the primer closes it and turns the PDF to that page");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
