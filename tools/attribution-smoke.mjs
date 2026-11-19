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
    // a card opens by itself in the margin beside the column, level with its words
    const words = await page.evaluate(() => {
      const h = CSS.highlights.get("strata-card"), r = h && [...h][0];
      const rs = r ? [...r.getClientRects()] : [];
      return rs.length ? { text: r.toString(), x: rs[0].left + 4, y: rs[0].top + rs[0].height / 2, top: rs[0].top, right: Math.max(...[...document.querySelectorAll(".page-col [data-b]")].map((b) => b.getBoundingClientRect().right)) } : null;
    });
    const before = await page.locator(".layer-plane > .fold[data-fold]").count();
    assert.equal(before, placed ? 1 : 0, "a placed card opens by itself, and only a placed one");
    const under = await page.evaluate((q) => {
      const sheet = [...document.querySelectorAll(".layer-plane > .fold[data-fold]")].find((f) => f.textContent.includes(q));
      return sheet ? { top: sheet.getBoundingClientRect().top, left: sheet.getBoundingClientRect().left } : null;
    }, "Attribution " + source);
    if (placed) {
      assert.ok(words && /^Diversification reduces the risk of individual investments/.test(words.text), `the card's words are its quote, not ${JSON.stringify(words)}`);
      assert.ok(under && Math.abs(under.top - words.top) < 40 && under.left >= words.right, `the card's sheet lies beside the column, level with its words: ${JSON.stringify({ words, under })}`);
      // its ◢ corner resizes it; – shrinks it to a tab named by its question; the tab opens it again; ↺ puts back an answered card
      const sheet = page.locator(".layer-plane > .fold", { hasText: "Attribution " + source });
      const was = await sheet.boundingBox(), corner = await sheet.locator(".fold-rs").boundingBox();
      await page.mouse.move(corner.x + 5, corner.y + 5);
      await page.mouse.down();
      await page.mouse.move(corner.x - 55, corner.y + 85, { steps: 5 });
      await page.mouse.up();
      const now = await sheet.boundingBox();
      assert.ok(now.width < was.width - 40 && now.height > was.height + 60, `the corner resizes the sheet: ${JSON.stringify({ was, now })}`);
      await sheet.locator(".fold-shut").click();
      const tab = page.locator(".layer-plane > .ftab-at .ftab");
      await tab.waitFor({ timeout: 3000 });
      assert.match(await tab.textContent(), /^Attribution/, "the tab carries the card's question");
      assert.equal(await page.locator(".layer-plane > .fold").count(), 0, "the shrunk sheet is gone");
      await tab.click();
      await sheet.getByRole("button", { name: "Show answer" }).click();
      await sheet.getByRole("button", { name: "Got it" }).click();
      await sheet.locator(".fi.card.done .fi-re").click();
      await sheet.getByRole("button", { name: "Show answer" }).waitFor({ timeout: 3000 });
    } else assert.ok(!words && !under, `a card with no quote is placed nowhere, not on ${JSON.stringify(words)}`);
    await api(`/api/boards/${board.id}/minted/${made.id}`, "DELETE");
  }
  assert.deepEqual(errors, []);
  console.log("✓ a quote puts the card on its words, its sheet open in the margin beside them, shrinkable to a tab and answerable again; a heading reference places it nowhere");
} finally { await browser.close(); await api(`/api/boards/${board.id}`, "DELETE"); }
