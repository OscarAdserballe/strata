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
    // a card lies shut on its words until they are clicked; then its sheet hangs just under them
    const words = await page.evaluate(() => {
      const h = CSS.highlights.get("strata-card"), r = h && [...h][0];
      const rs = r ? [...r.getClientRects()] : [];
      return rs.length ? { text: r.toString(), x: rs[0].left + 4, y: rs[0].top + rs[0].height / 2, bottom: Math.max(...rs.map((x) => x.bottom)) } : null;
    });
    const before = await page.locator(".layer-plane > [data-fold]").count();
    assert.equal(before, 0, "no card's sheet opens by itself");
    if (words) { await page.mouse.click(words.x, words.y); await page.waitForTimeout(500); }
    const under = await page.evaluate((q) => {
      const sheet = [...document.querySelectorAll(".layer-plane > [data-fold]")].find((f) => f.textContent.includes(q));
      return sheet ? { top: sheet.getBoundingClientRect().top } : null;
    }, "Attribution " + source);
    if (placed) {
      assert.ok(words && /^Diversification reduces the risk of individual investments/.test(words.text), `the card's words are its quote, not ${JSON.stringify(words)}`);
      assert.ok(under && under.top > words.bottom && under.top - words.bottom < 40, `the card's sheet hangs just under its words: ${JSON.stringify({ words, under })}`);
    } else assert.ok(!words && !under, `a card with no quote is placed nowhere, not on ${JSON.stringify(words)}`);
    await api(`/api/boards/${board.id}/minted/${made.id}`, "DELETE");
  }
  assert.deepEqual(errors, []);
  console.log("✓ a quote puts the card on its words, opened by a click; a heading reference places it nowhere");
} finally { await browser.close(); await api(`/api/boards/${board.id}`, "DELETE"); }
