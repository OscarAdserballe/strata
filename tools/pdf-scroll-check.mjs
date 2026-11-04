// node tools/pdf-scroll-check.mjs URL [webkit|chromium]: PDF scrolling, bitmap release and canvas retry
import assert from "node:assert/strict";
import { chromium, webkit, devices } from "playwright";
import { atRest } from "./settled.mjs";

const base = process.argv[2] || "http://127.0.0.1:8804";
const engine = process.argv[3] || "webkit";
const browser = await ({ webkit, chromium }[engine]).launch();
try {
  const context = await browser.newContext({ ...devices["iPad Pro 11"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.addInitScript(() => {
    window.removedPdfCanvases = [];
    new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node.nodeName === "CANVAS" && record.target.classList?.contains("slide")) {
          // hold references so the app, not the garbage collector, must release the backing stores
          window.removedPdfCanvases.push(node);
        }
      }
    }).observe(document, { subtree: true, childList: true });
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      if (window.failNextPdfCanvas && args[0] === "2d" && this.width > 500) {
        window.failNextPdfCanvas = false;
        window.failedPdfCanvas = this;
        return null;
      }
      return getContext.apply(this, args);
    };
  });
  const { boards } = await (await fetch(base + "/api/boards")).json();
  const book = boards.find(b => b.title === "The Discipline of Repetition");
  assert.ok(book, "seeded book exists");
  await page.goto(`${base}/?board=${book.id}`, { waitUntil: "networkidle" });
  if (!await page.locator(".slide canvas").count()) {
    await page.locator('.bp-rail [title*="step inside"]').first().click();
    await page.getByRole("button", { name: /^Open the book/ }).click();
    await page.locator('button[title^="One:"], button:has-text("One:")').first().click();
  }
  await page.waitForSelector(".slide canvas");
  const inkOn = async n => {
    await page.waitForFunction(n => {
      const cv = document.querySelector(`#pg-${n} canvas`);
      if (!cv?.width || !document.querySelector(`#pg-${n} .tlayer`)) return false;
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 0; i < d.length; i += 4 * 97) {
        if (d[i + 3] > 0 && (d[i] < 220 || d[i + 1] < 220 || d[i + 2] < 220)) return true;
      }
      return false;
    }, n, { timeout: 15000 });
  };
  const go = n => page.evaluate(n => {
    const sc = document.querySelector(".page");
    sc.scrollTop = document.querySelector(`#pg-${n}`).offsetTop;
    sc.dispatchEvent(new Event("scroll"));
  }, n);
  for (const n of [3, 12, 24, 40, 60, 80, 89, 45, 3]) {
    await go(n);
    await inkOn(n);
    const memory = await page.evaluate(() => ({
      live: document.querySelectorAll(".slide canvas").length,
      unreleased: window.removedPdfCanvases.filter(c => c.width || c.height).length,
      oversized: [...document.querySelectorAll(".slide canvas")].some(c => c.width * c.height > 2 * 1024 * 1024),
    }));
    assert.ok(memory.live <= 9, `bounded canvas count at page ${n}: ${memory.live}`);
    assert.equal(memory.unreleased, 0, `evicted bitmaps released at page ${n}`);
    assert.equal(memory.oversized, false);
    console.log(`${engine}: page ${n} has ink and selectable text; ${memory.live} live canvases`);
  }
  // a fling sends one jump a frame; obsolete queued pages must be abandoned
  for (const n of [15, 40, 65, 25, 85]) { await go(n); await page.evaluate(() => new Promise(requestAnimationFrame)); }
  await inkOn(85);
  // let the landing's adjacent prefetch finish before faulting the next window
  await atRest(page, ".page", { every: 400 });
  await page.evaluate(() => {
    window.failNextPdfCanvas = true;
    const sc = document.querySelector(".page");
    sc.scrollTop = document.querySelector("#pg-35").offsetTop;
    sc.dispatchEvent(new Event("scroll"));
  });
  const retry = page.locator(".pdf-page-error").first();
  await retry.waitFor();
  const failedPage = await retry.evaluate(el => +el.parentElement.dataset.page);
  assert.equal(await page.evaluate(() => window.failedPdfCanvas.width + window.failedPdfCanvas.height), 0,
    "failed bitmap released immediately");
  await retry.click();
  await inkOn(failedPage);
  assert.equal(await page.locator(".pdf-page-error").count(), 0);
  // a pinch replaces an existing canvas: keep that node to check its backing store is released
  await go(35);
  await inkOn(35);
  await page.evaluate(() => {
    window.beforeZoomCanvas = document.querySelector("#pg-35 canvas");
    document.querySelector(".page").dispatchEvent(new WheelEvent("wheel", {
      ctrlKey: true, deltaY: -96, cancelable: true,
    }));
  });
  await page.waitForFunction(() => +localStorage.getItem("strata.pz") > 1);
  await page.waitForFunction(() => window.beforeZoomCanvas.width === 0 && window.beforeZoomCanvas.height === 0);
  await go(35);
  await inkOn(35);
  await page.setViewportSize({ width: 1194, height: 834 });
  await go(60);
  await inkOn(60);
  const leaks = await page.evaluate(() => window.removedPdfCanvases.filter(c => c.width || c.height).length);
  assert.equal(leaks, 0, "zoom redraws and rotation release discarded bitmaps");
  assert.deepEqual(errors, []);
  console.log(`${engine}: fast scrolling, failed-page retry, zoom and rotation passed`);

  // returning to a PDF must draw it without a scroll; downloads are slowed so each interleaving happens
  {
    const { book: aBook, slides: someSlides } = await import("./fixture-pdf.mjs");
    const api = async (path, method = "GET", body) => {
      const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    };
    const { board: away } = await api("/api/boards", "POST", { title: "pdf-scroll-check: coming back" });
    const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1400, height: 900 } });
    try {
      const up = async (filename, pdf) => (await api(`/api/boards/${away.id}/resources`, "POST",
        { filename, base64: pdf.bytes.toString("base64"), pageText: pdf.pageText })).id;
      const ra = await up("away-book.pdf", aBook()), rb = await up("away-slides.pdf", someSlides());
      for (const [label, resourceId] of [["A", ra], ["B", rb]]) await api(`/api/boards/${away.id}/pairs`, "POST", { label, resourceId });
      const { pairs } = await api(`/api/boards/${away.id}`);
      const pa = pairs.find(p => p.resourceId === ra).id, pb = pairs.find(p => p.resourceId === rb).id;
      const p2 = await ctx.newPage();
      p2.on("pageerror", e => errors.push(String(e)));
      const slow = (rid, ms) => p2.route(`**/resources/${rid}/raw**`, async route => { await new Promise(r => setTimeout(r, ms)); await route.continue(); });
      await slow(ra, 2000); await slow(rb, 500);
      const nav = q => p2.evaluate(q => { history.pushState(null, "", "?" + q); dispatchEvent(new PopStateEvent("popstate")); }, q);
      const drawsOnReturn = async (what) => {
        await nav(`board=${away.id}&pair=${pb}`);
        await p2.waitForSelector(".slide canvas", { timeout: 6000 }).catch(() => {});
        const seen = await p2.evaluate(() => ({ boxes: document.querySelectorAll(".slide").length, canvases: document.querySelectorAll(".slide canvas").length }));
        assert.ok(seen.canvases > 0, `${what}: back on the PDF, a page is drawn without scrolling (${seen.boxes} boxes, ${seen.canvases} canvases)`);
        console.log(`${engine}: ${what}: drawn on return (${seen.canvases} canvases)`);
      };
      // two PDFs, then home mid-download; back after the superseded render and settle poll would have ended
      await p2.goto(`${base}/?board=${away.id}`, { waitUntil: "networkidle" });
      await nav(`board=${away.id}&pair=${pa}`); await p2.waitForTimeout(400);
      await nav(`board=${away.id}&pair=${pb}`); await p2.waitForTimeout(400);
      await nav(`board=${away.id}`); await p2.waitForTimeout(7000);
      await drawsOnReturn("two asks in flight, then home");
      // one PDF asked for, then home before it lands; back after its settle poll has ended
      await p2.goto(`${base}/?board=${away.id}`, { waitUntil: "networkidle" });
      await nav(`board=${away.id}&pair=${pb}`); await p2.waitForTimeout(150);
      await nav(`board=${away.id}`); await p2.waitForTimeout(5500);
      await drawsOnReturn("the newest ask landed on home");
      assert.deepEqual(errors, []);
    } finally {
      await ctx.close();
      await api(`/api/boards/${away.id}`, "DELETE").catch(() => {});
    }
  }
} finally {
  await browser.close();
}
