import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${path}: ${res.status}`); return res.json();
};
const board = (await api("/api/boards", "POST", { title: "Attribution fixture" })).board;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // a card sits on a verbatim quote of its words and nowhere else: a heading reference places nothing
  for (const [source, placed] of [['quote: "Diversification reduces the risk of individual investments"', true], ["#the-tape", false]]) {
    const r = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "Article fixture", text: "# The tape\n\nDiversification reduces the risk of individual investments.\n\nA second paragraph for reading.", pair: true });
    const pair = r.state.pairs.find(p => p.resourceId === r.id);
    await api(`/api/boards/${board.id}/pairs/${pair.id}`, "PATCH", { deck: "aio-lecture-1" });
    const made = await api(`/api/boards/${board.id}/minted`, "POST", { variant: "bare", front: "Attribution " + source, back: "An answer to remember.", source, pairId: pair.id, state: "closed", meta: { anchorExplicit: true } });
    await page.goto(`${base}/?board=${board.id}&pair=${pair.id}`, { waitUntil: "networkidle" });
    await page.locator(".page-col [data-b]").first().waitFor();
    await page.waitForTimeout(1200);
    const under = await page.evaluate((q) => {
      const sheet = [...document.querySelectorAll(".layer-plane > [data-fold]")].find((f) => f.textContent.includes(q));
      const block = sheet ? document.querySelector(`.page-col [data-b="${sheet.dataset.fold.slice(1)}"]`) : null;
      return block ? { tag: block.tagName, text: block.textContent.trim().slice(0, 60) } : null;
    }, "Attribution " + source);
    if (placed) assert.ok(under && /^Diversification reduces/.test(under.text), `the card sits under ${JSON.stringify(under)}, not the passage its quote names`);
    else assert.equal(under, null, `a card with no quote is placed nowhere, not under ${JSON.stringify(under)}`);
    await api(`/api/boards/${board.id}/minted/${made.id}`, "DELETE");
  }
  assert.deepEqual(errors, []);
  console.log("✓ a quote puts the card under its passage; a heading reference places it nowhere");
} finally { await browser.close(); await api(`/api/boards/${board.id}`, "DELETE"); }
