import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const PAGE = `<!doctype html><html><head><meta name="color-scheme" content="light dark"><title>Delegation-loss curve</title>
<style>body{background:#fbfaf7}@media (prefers-color-scheme: dark){body{background:#121212}}</style><script>window.x = 1</script></head>
<body><h1>Delegation-loss curve</h1><p>Each hop loses a little.</p><ol><li>The first hop drops the brief's constraints.</li><li>The second hop drops the why.</li></ol><input type="range"></body></html>`;
const board = (await api("/api/boards", "POST", { title: `Live fixture ${Date.now()}` })).board;
// dark as an OS setting, not CDP emulation: emulation reaches every frame and hides what the iframe inherits
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, args: ["--blink-settings=preferredColorScheme=0"] });
try {
  const r = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "loss.html", base64: Buffer.from(PAGE).toString("base64"), pair: true });
  const pair = r.state.pairs.find((p) => p.resourceId === r.id);
  const context = await browser.newContext({ colorScheme: null, viewport: { width: 1280, height: 860 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?board=${board.id}&pair=${pair.id}`, { waitUntil: "networkidle" });
  const frame = await (await page.waitForSelector("iframe.html-frame", { timeout: 15000 })).contentFrame();
  await frame.waitForSelector("h1");
  assert.ok(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), "the OS prefers dark");
  const inside = await frame.evaluate(() => ({ dark: matchMedia("(prefers-color-scheme: dark)").matches, bg: getComputedStyle(document.body).backgroundColor }));
  assert.deepEqual(inside, { dark: false, bg: "rgb(251, 250, 247)" }, "a live page follows the room's light scheme, not the OS");
  assert.deepEqual(errors, []);
  console.log("✓ a live page renders light in a dark OS");

  // cards land on the page by their quotes: one inside a list item, one in a paragraph. Each lies shut on its words until
  // they are clicked; the page draws the sheets over itself, never inside it, and no sheet covers another.
  const tree = { title: "Delegation-loss curve", question: "?", nodes: [{ label: "hops lose", kind: "claim", anchor: "#delegation-loss-curve", children: [] }] };
  await api(`/api/boards/${board.id}/resources/${r.id}/tree`, "PUT", { tree, cards: [
    { node: "n1", type: "flashcard", source: `quote: ${JSON.stringify("The first hop drops the brief's constraints.")}`, front: "What does the first hop drop?", back: "The constraints." },
    { node: "n1", type: "flashcard", source: `quote: ${JSON.stringify("Each hop loses a little.")}`, front: "What shape is the curve?", back: "Each hop loses a little." },
  ] });
  await page.reload({ waitUntil: "networkidle" });
  const again = await (await page.waitForSelector("iframe.html-frame", { timeout: 15000 })).contentFrame();
  await again.waitForFunction(() => CSS.highlights.get("strata-card")?.size === 2, null, { timeout: 15000 });
  await again.waitForTimeout(400);
  const sheetsNow = () => again.evaluate(() => [...document.querySelectorAll("strata-fold")].filter((h) => h.shadowRoot?.querySelector(".fi.card")).length);
  assert.equal(await sheetsNow(), 0, "no card's sheet opens by itself");
  // the list item's words first: the paragraph's lie above them, where the first sheet can't cover them
  for (const quote of ["The first hop", "Each hop loses"]) {
    await again.evaluate((q) => {
      const r = [...CSS.highlights.get("strata-card")].find((x) => x.toString().startsWith(q)), at = r.getClientRects()[0];
      const x = at.left + 4, y = at.top + at.height / 2;
      document.elementFromPoint(x, y).dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true, composed: true, button: 0 }));
    }, quote);
    await again.waitForTimeout(300);
  }
  await again.waitForFunction(() => [...document.querySelectorAll("strata-fold")].filter((h) => h.shadowRoot?.querySelector(".fi.card")).length === 2, null, { timeout: 5000 });
  const laid = await again.evaluate(() => {
    const hosts = [...document.querySelectorAll("strata-fold")].filter((h) => h.shadowRoot?.querySelector(".fold"));
    const rs = hosts.map((h) => h.getBoundingClientRect());
    return {
      sheets: hosts.map((h) => ({ over: h.parentElement?.tagName === "STRATA-LAYER" && h.parentElement.parentElement === document.documentElement, q: h.shadowRoot.querySelector(".fq")?.textContent ?? "" })),
      overlap: rs.some((a, i) => rs.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)),
      inPage: document.body.querySelectorAll("strata-fold").length,
    };
  });
  assert.equal(laid.sheets.length, 2, JSON.stringify(laid));
  assert.ok(laid.sheets.every((x) => x.over) && laid.inPage === 0, "the sheets lie over the page, never inside it: " + JSON.stringify(laid));
  assert.ok(!laid.overlap, "no sheet covers another: " + JSON.stringify(laid));
  assert.match(await page.locator(".rbar-keep").textContent(), /0\/2/, "the reader's bar counts the deck");
  assert.deepEqual(errors, []);
  console.log("✓ a live page's cards open from their words, over the page, neither covering the other");
} finally { await browser.close(); await api(`/api/boards/${board.id}`, "DELETE"); }
