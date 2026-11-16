import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const PAGE = `<!doctype html><html><head><meta name="color-scheme" content="light dark"><title>Delegation-loss curve</title>
<style>body{background:#fbfaf7}@media (prefers-color-scheme: dark){body{background:#121212}}</style><script>window.x = 1</script></head>
<body><h1>Delegation-loss curve</h1><p>Each hop loses a little.</p><ol><li>The first hop drops the brief's constraints.</li><li>The second hop drops the why.</li></ol><input type="range"><p><a id="out" href="https://example.test/elsewhere">elsewhere</a></p></body></html>`;
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
  const above = await page.evaluate(() => document.querySelector(".htmlsrc")?.firstElementChild?.className);
  assert.equal(above, "htmlsrc-body", "nothing sits above the page, as with a PDF or Markdown source");
  console.log("✓ a live page opens with no strip above it");

  // a link would load inside the sandboxed frame, where most sites refuse to be framed; it opens a tab instead
  await context.route("https://example.test/**", (route) => route.fulfill({ body: "<p>elsewhere</p>", contentType: "text/html" }));
  const [tab] = await Promise.all([context.waitForEvent("page"), frame.click("#out")]);
  await tab.waitForURL("https://example.test/elsewhere");
  assert.ok(await frame.$("#out"), "the page is still in the frame");
  await tab.close();
  console.log("✓ a link in a live page opens in a new tab, not inside the frame");

  // cards land on the page by their quotes: one inside a list item, one in a paragraph. Each still to answer lies open
  // under its words, and a click elsewhere on the page doesn't shut it; the sheets lie over the page, neither covering the other.
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
  assert.equal(await sheetsNow(), 2, "a card still to answer opens by itself");
  await again.evaluate(() => document.body.dispatchEvent(new MouseEvent("click", { clientX: 2, clientY: 2, bubbles: true, composed: true, button: 0 })));
  await again.waitForTimeout(300);
  assert.equal(await sheetsNow(), 2, "a click on the page leaves a card still to answer open");
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
  console.log("✓ a live page's cards still to answer lie open under their words, over the page, neither covering the other");

  // a note's words sit in a grid's cell, where the nearest block that stacks is the whole grid: its sheet still hangs under them
  const GRID = `<!doctype html><html><head><title>Grid</title></head><body><h1>Grid</h1>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px"><div>The left cell opens with a line worth a note. More of the left cell follows here.</div><div style="height:1400px">A tall right cell.</div></div></body></html>`;
  const g = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "grid.html", base64: Buffer.from(GRID).toString("base64"), pair: true });
  await api(`/api/boards/${board.id}/marks`, "POST", { resourceId: g.id, start: 0, end: 0, quote: "a line worth a note", note: "Under its words." });
  await page.goto(`${base}/?board=${board.id}&pair=${g.state.pairs.find((p) => p.resourceId === g.id).id}`, { waitUntil: "networkidle" });
  const grid = await (await page.waitForSelector("iframe.html-frame", { timeout: 15000 })).contentFrame();
  await grid.waitForFunction(() => CSS.highlights.get("strata-noted")?.size === 1, null, { timeout: 15000 });
  await grid.locator(".ftick:has(.fmk.note)").first().click({ timeout: 10000 });
  await grid.waitForFunction(() => [...document.querySelectorAll("strata-fold")].some((h) => h.shadowRoot?.querySelector(".fi-note")), null, { timeout: 5000 });
  const hung = await grid.evaluate(() => {
    const words = [...(CSS.highlights.get("strata-noted") ?? []), ...(CSS.highlights.get("strata-open") ?? [])][0].getClientRects(), bottom = Math.max(...[...words].map((r) => r.bottom));
    const sheet = [...document.querySelectorAll("strata-fold")].find((h) => h.shadowRoot?.querySelector(".fi-note")).getBoundingClientRect();
    return { bottom, top: sheet.top };
  });
  assert.ok(hung.top > hung.bottom && hung.top - hung.bottom < 40, "the note's sheet hangs just under its words, not under the grid: " + JSON.stringify(hung));
  assert.deepEqual(errors, []);
  console.log("✓ a note in a grid's cell hangs its sheet under its words");
} finally { await browser.close(); await api(`/api/boards/${board.id}`, "DELETE"); }
