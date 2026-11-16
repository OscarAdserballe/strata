// A Markdown source keeps its code blocks, draws its Mermaid charts, and fetches Mermaid only when it has one.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const PLAIN = "# Plain post\n\nNo charts here, only words that wrap\nacross two lines.\n";
const CHARTED = "# Charted post\n\nThe pipeline:\n\n```mermaid\ngraph TD\n  Capture --> Reader\n```\n\nAnd the code:\n\n```js\nconst a = 1;\nconst b = 2;\n```\n\n```mermaid\nthis is not a chart\n```\n";
const board = (await api("/api/boards", "POST", { title: `Prose fixture ${Date.now()}` })).board;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const add = async (filename, text) => { const r = await api(`/api/boards/${board.id}/resources`, "POST", { filename, text, pair: true }); return r.state.pairs.find((p) => p.resourceId === r.id); };
  const plain = await add("plain.md", PLAIN), charted = await add("charted.md", CHARTED);
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [], chunks = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => { if (/mermaid/i.test(r.url())) chunks.push(r.url()); });

  await page.goto(`${base}/?board=${board.id}&pair=${plain.id}`, { waitUntil: "networkidle" });
  await page.locator(".prose p", { hasText: "across two lines" }).waitFor();
  const mainJs = await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => /main\.js/.test(s)));
  assert.ok(mainJs, "main.js is loaded");
  assert.doesNotMatch(await (await fetch(mainJs)).text(), /flowchart-v2|Syntax error in text|sequenceDiagram/, "Mermaid stays out of the main bundle");
  assert.deepEqual(chunks, [], "a source with no chart never fetches Mermaid");
  console.log("✓ a source with no chart doesn't load Mermaid");

  await page.goto(`${base}/?board=${board.id}&pair=${charted.id}`, { waitUntil: "networkidle" });
  await page.locator(".prose figure.diagram svg").first().waitFor({ timeout: 20000 });
  const seen = await page.evaluate(() => ({
    figures: document.querySelectorAll(".prose figure.diagram svg").length,
    hiddenCode: [...document.querySelectorAll('.prose pre[data-lang="mermaid"]')].map((p) => [p.dataset.drawn, getComputedStyle(p).display]),
    code: document.querySelector('.prose pre[data-lang="js"] code')?.textContent,
    label: document.querySelector(".prose figure.diagram")?.textContent?.includes("Reader"),
  }));
  assert.equal(seen.figures, 1, JSON.stringify(seen));
  assert.deepEqual(seen.hiddenCode, [["yes", "none"], ["failed", "block"]], "a drawn chart hides its code; one Mermaid can't read keeps it");
  assert.equal(seen.code, "const a = 1;\nconst b = 2;");
  assert.ok(seen.label, "the chart shows its nodes");
  assert.ok(chunks.length > 0, "Mermaid came as a lazy chunk");
  assert.deepEqual(errors, []);
  console.log("✓ a source keeps its code blocks and draws its Mermaid chart lazily");
} finally { await browser.close(); await api(`/api/boards/${board.id}`, "DELETE"); }
