import assert from "node:assert/strict";
import { chromium } from "playwright";
import { book } from "./fixture-pdf.mjs";
import { atRest } from "./settled.mjs";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body) => {
  const response = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
};
const board = (await api("/api/boards", "POST", { title: `Reading position ${Date.now()}` })).board;
let browser, page, release;
try {
  const fixture = book();
  const pdf = await api(`/api/boards/${board.id}/resources`, "POST", {
    filename: "reading-position.pdf", base64: fixture.bytes.toString("base64"),
    sections: fixture.sections, pageText: fixture.pageText,
  });
  const prose = await api(`/api/boards/${board.id}/resources`, "POST", {
    filename: "reading-position.md", pair: true,
    text: Array.from({ length: 400 }, (_, i) => `## Passage ${i + 1}\n\nA long text should remember the paragraph under your eyes.\n`).join("\n"),
  });
  const state = await api(`/api/boards/${board.id}`);
  const pdfPair = state.pairs.find(p => p.resourceId === pdf.id);
  const prosePair = state.pairs.find(p => p.resourceId === prose.id);
  assert.ok(pdfPair && prosePair);
  const url = pair => `${base}/?board=${board.id}&resource=${pair.resourceId}&pair=${pair.id}`;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  page = await browser.newPage({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const saved = () => page.evaluate(id => JSON.parse(localStorage.getItem(`strata.at.${id}`) || "{}"), board.id);
  const at = async top => {
    await page.waitForFunction(want => Math.abs(document.querySelector(".page")?.scrollTop - want) < 3, top);
  };
  const scroll = async top => {
    await page.locator(".page").evaluate((el, want) => { el.scrollTop = want; }, top);
    await at(top);
  };

  await page.goto(url(pdfPair));
  await page.locator(".slide canvas").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".page")?.scrollHeight > 35000);
  const section = state.sections.find(s => s.id === pdfPair.sectionId);
  await page.waitForFunction(firstPage => {
    const el = document.querySelector(`#pg-${firstPage}`);
    return el && Math.abs(document.querySelector(".page").scrollTop - (firstPage > 1 ? Math.max(0, el.offsetTop - 2) : 0)) < 3;
  }, section.firstPage);
  await atRest(page);
  await scroll(30000);
  await page.waitForFunction(id => Math.abs(JSON.parse(localStorage.getItem(`strata.at.${id}`) || "{}").scroll - 30000) < 3, board.id);
  await page.reload();
  await at(30000);
  await page.locator(".slide canvas").first().waitFor();
  await at(30000);
  console.log("✓ a long PDF restores its reading position after refresh");

  // pagehide must capture a scroll even before its debounced save fires.
  await Promise.all([
    page.waitForEvent("domcontentloaded"),
    page.evaluate(() => { document.querySelector(".page").scrollTop = 32000; location.reload(); }),
  ]);
  await at(32000);
  assert.ok(Math.abs((await saved()).scroll - 32000) < 3);
  console.log("✓ refreshing immediately after scrolling keeps the latest position");

  await page.goto(url(prosePair));
  await page.waitForFunction(() => document.querySelector(".page")?.scrollHeight > 10000);
  await at(0);
  await scroll(9000);
  await page.reload();
  await at(9000);
  console.log("✓ text sources restore too; another source does not inherit the PDF position");

  // hold the source past the restore timeout, then reload mid-load: neither empty reader may overwrite the place
  // run 11 s of the page's clock instead of sleeping, once the reader has asked for the source
  const raw = `${base}/api/boards/${board.id}/resources/${prose.id}/raw`;
  const gate = new Promise(resolve => { release = resolve; });
  let asked;
  const waiting = new Promise(resolve => { asked = resolve; });
  await page.route(raw, async route => { asked(); await gate; await route.continue().catch(() => {}); });
  await page.clock.install();
  await page.reload({ waitUntil: "domcontentloaded" });
  await waiting;
  await page.clock.runFor(11000);
  assert.ok(Math.abs((await saved()).scroll - 9000) < 3);
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.ok(Math.abs((await saved()).scroll - 9000) < 3);
  release();
  await at(9000);
  await page.unrouteAll({ behavior: "wait" });
  console.log("✓ slow source loading and a second refresh preserve the pending position");

  await scroll(0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".page")?.scrollHeight > 10000);
  await at(0);
  assert.equal((await saved()).scroll, 0);
  await page.goto(`${base}/?board=${board.id}`);
  await page.locator(".bp-hname").filter({ hasText: board.title }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("pair"), null);
  assert.deepEqual(errors, []);
  console.log("✓ returning to the start is saved; a board-home URL still opens home");
} catch (error) {
  if (page) console.error(await page.evaluate(id => ({
    top: document.querySelector(".page")?.scrollTop,
    height: document.querySelector(".page")?.scrollHeight,
    saved: localStorage.getItem(`strata.at.${id}`),
  }), board.id));
  throw error;
} finally {
  release?.();
  await browser?.close();
  await api(`/api/boards/${board.id}`, "DELETE");
}
