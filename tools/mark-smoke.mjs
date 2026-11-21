// Picked words get one button, Mark; the mark paints at once, and Note · Ask · Card come up under it as chips.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const ESSAY = `# Marking fixture

Opening words stand alone in the first paragraph, which is long enough to wrap across a line or two in the reader.

Second paragraph words are here so another passage can be marked without touching the first one at all.

Third paragraph words wait for a question asked about them, under the words, in the fold.

Fourth paragraph words become a card written from the passage, formatted before it is kept.

Fifth paragraph words are only highlighted and then taken back with the cross on their chips.
`;
const PAGE = `<!doctype html><html><head><title>Live marking</title><script>window.x = 1</script></head>
<body><h1>Live marking</h1><p id="lead">A live page is marked the same way as any other source of the room.</p><input type="range"></body></html>`;
const board = (await api("/api/boards", "POST", { title: `Mark fixture ${Date.now()}` })).board;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const marksNow = async () => (await api(`/api/boards/${board.id}`)).marks;
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) assert.fail(what); await new Promise((r) => setTimeout(r, 100)); }
};
try {
  const essay = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "marking.md", text: ESSAY, pair: true });
  const pair = essay.state.pairs.find((p) => p.resourceId === essay.id);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?board=${board.id}&pair=${pair.id}`, { waitUntil: "networkidle" });
  const para = (words) => page.locator(".page-col.prose p", { hasText: words });
  // drags over the first words of a paragraph, so the menu comes up over them
  const pick = async (words) => {
    const box = await para(words).boundingBox();
    await page.mouse.move(box.x + 2, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + 10, { steps: 6 }); await page.mouse.up();
    await page.locator(".selmenu").waitFor({ timeout: 3000 });
  };
  const chips = page.locator(".markchips");
  const chipNames = async () => chips.locator("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") || b.textContent));
  await para("Opening words").waitFor({ timeout: 15000 });

  await pick("Opening words");
  assert.deepEqual(await page.locator(".selmenu button").allTextContents(), ["Mark"], "the menu over picked words is one button");
  console.log("✓ picked words offer one button, Mark");

  // M marks: the highlight paints before its save answers
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route(`**/api/boards/${board.id}/marks`, async (route) => { if (route.request().method() === "POST") await held; await route.continue(); });
  await page.keyboard.press("m");
  await page.locator(".page-col.prose .mk[data-mark]").first().waitFor({ timeout: 1000 });
  await chips.waitFor({ timeout: 1000 });
  assert.equal(await page.locator(".selmenu").count(), 0, "the menu leaves once the words are marked");
  assert.deepEqual(await chipNames(), ["Note", "Ask", "Card"], "a mark just made offers Note · Ask · Card");
  const chipTop = (await chips.boundingBox()).y, lineBottom = await page.evaluate(() => Math.max(...[...document.querySelectorAll(".page-col.prose .mk")].map((m) => m.getBoundingClientRect().bottom)));
  assert.ok(chipTop >= lineBottom - 1, `the chips sit under the marked words (chips at ${chipTop}, words end at ${lineBottom})`);
  release();
  const first = await until(async () => (await marksNow()).find((m) => m.quote.startsWith("Opening")), "the mark reached the server");
  await page.unroute(`**/api/boards/${board.id}/marks`);
  console.log("✓ M paints the mark before it is saved, and the chips come up under it");

  await page.keyboard.press("Escape");
  await chips.waitFor({ state: "detached", timeout: 2000 });
  assert.equal(await page.locator(`.mk[data-mark="${first.id}"]`).count() > 0, true, "Esc leaves the highlight");
  console.log("✓ Esc drops the chips; the highlight stays");

  // a mark tapped again offers its chips, with a cross to take it back; a letter starts its note
  await page.locator(`.mk[data-mark="${first.id}"]`).first().click();
  await chips.waitFor({ timeout: 2000 });
  assert.deepEqual(await chipNames(), ["Note", "Ask", "Card", "Remove mark"], "a mark tapped again also offers ✕");
  await page.keyboard.press("Shift+W");
  const editor = page.locator(".fold .fi-edit");
  await editor.waitFor({ timeout: 3000 });
  await until(async () => await editor.inputValue() === "W", "the note starts with the letter typed");
  await page.keyboard.type("hy it opens");
  await page.keyboard.press("Escape");
  await until(async () => (await marksNow()).find((m) => m.id === first.id)?.note === "Why it opens", "the note was saved with the typed letter first");
  console.log("✓ a mark tapped again shows its chips with ✕; a letter typed there starts the note");

  // the Note chip opens an empty note; left empty, the mark stays a highlight
  await pick("Second paragraph");
  await page.locator(".selmenu").getByRole("button", { name: "Mark", exact: true }).click();
  await chips.getByRole("button", { name: "Note", exact: true }).click();
  await editor.waitFor({ timeout: 3000 });
  assert.equal(await editor.inputValue(), "", "the Note chip opens the note empty");
  await page.keyboard.press("Escape");
  const second = await until(async () => (await marksNow()).find((m) => m.quote.startsWith("Second")), "the second mark was saved");
  assert.equal(second.note, null, "a note left empty leaves a bare highlight");
  console.log("✓ the Note chip opens the margin note");

  // click-away drops the chips too
  await pick("Third paragraph");
  await page.locator(".selmenu").getByRole("button", { name: "Mark", exact: true }).click();
  await chips.waitFor();
  await page.mouse.click(30, 450);
  await chips.waitFor({ state: "detached", timeout: 2000 });
  console.log("✓ a click elsewhere drops the chips");

  // A from the chips opens the question under the words
  const third = await until(async () => (await marksNow()).find((m) => m.quote.startsWith("Third")), "the third mark was saved");
  await page.locator(`.mk[data-mark="${third.id}"]`).first().click();
  await chips.waitFor();
  await page.keyboard.press("a");
  await page.locator(".fold .fi.asked .fi-q").waitFor({ timeout: 3000 });
  await page.keyboard.press("Escape");
  await page.locator(".fold .fold-shut").first().click({ timeout: 2000 }).catch(() => {});
  console.log("✓ A at a mark's chips opens a question under its words");

  // C opens a card written under the words
  await pick("Fourth paragraph");
  await page.keyboard.press("m");
  await chips.waitFor();
  await page.keyboard.press("c");
  const draft = page.locator(".fold .fi.draft");
  await draft.waitFor({ timeout: 3000 });
  assert.equal(await draft.locator(".fi-format").count(), 1, "the card is formatted before it is kept");
  await page.keyboard.press("Escape");
  console.log("✓ C at a mark's chips opens a card under its words");

  // ✕ takes the mark back
  await page.locator(".fold .fold-shut").first().click({ timeout: 2000 }).catch(() => {});
  await pick("Fifth paragraph");
  await page.locator(".selmenu").getByRole("button", { name: "Mark", exact: true }).click();
  const fifth = await until(async () => (await marksNow()).find((m) => m.quote.startsWith("Fifth")), "the fifth mark was saved");
  await page.keyboard.press("Escape");
  await page.locator(`.mk[data-mark="${fifth.id}"]`).first().click();
  await chips.getByRole("button", { name: "Remove mark" }).click();
  await until(async () => !(await marksNow()).some((m) => m.id === fifth.id), "✕ removed the mark on the server");
  assert.equal(await page.locator(`.mk[data-mark="${fifth.id}"]`).count(), 0, "…and from the page");
  console.log("✓ ✕ on a mark's chips removes it");

  // a live page in the room: Mark, then the chips; tapped again, its chips have ✕ and no card
  const live = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "live.html", base64: Buffer.from(PAGE).toString("base64"), pair: true });
  const livePair = live.state.pairs.find((p) => p.resourceId === live.id);
  await page.goto(`${base}/?board=${board.id}&pair=${livePair.id}`, { waitUntil: "networkidle" });
  const frame = page.frameLocator("iframe.html-frame");
  await frame.locator("#lead").waitFor({ timeout: 15000 });
  await frame.locator("#lead").selectText();
  await frame.locator("#lead").dispatchEvent("mouseup");
  await page.locator(".selmenu").getByRole("button", { name: "Mark", exact: true }).click({ timeout: 5000 });
  await chips.waitFor({ timeout: 3000 });
  assert.deepEqual(await chipNames(), ["Note", "Ask", "Card"]);
  const liveMark = await until(async () => (await marksNow()).find((m) => m.resourceId === live.id), "the live mark was saved");
  await page.keyboard.press("Escape");
  await chips.waitFor({ state: "detached", timeout: 2000 });
  await frame.locator("#lead").click({ position: { x: 20, y: 8 } });
  await chips.waitFor({ timeout: 3000 });
  assert.deepEqual(await chipNames(), ["Note", "Ask", "Remove mark"], "a live mark tapped again offers no card: its own words are known only while picked");
  const frameBox = await page.locator("iframe.html-frame").boundingBox(), leadBox = await frame.locator("#lead").boundingBox();
  assert.ok((await chips.boundingBox()).y >= Math.min(leadBox.y, frameBox.y + leadBox.y) + 4, "the chips sit under the tapped line");
  await chips.getByRole("button", { name: "Note", exact: true }).click();
  await frame.locator(".fi-edit").waitFor({ timeout: 3000 });
  assert.ok(liveMark.id);
  console.log("✓ a live page in the room: Mark, then its chips; tapped again, ✕ and no card");

  assert.deepEqual(errors, []);

  // a phone: the native copy menu sits over picked words, so Mark and the chips sit under them
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const tp = await phone.newPage();
  tp.on("pageerror", (e) => errors.push(e.message));
  await tp.goto(`${base}/?board=${board.id}&pair=${pair.id}`, { waitUntil: "networkidle" });
  const fifthP = tp.locator(".page-col.prose p", { hasText: "Fifth paragraph" });
  await fifthP.waitFor({ timeout: 15000 });
  await fifthP.scrollIntoViewIfNeeded();
  const selBottom = await fifthP.evaluate((p) => {
    const t = p.firstChild, r = document.createRange();
    r.setStart(t, 0); r.setEnd(t, Math.min(24, t.length));
    getSelection().removeAllRanges(); getSelection().addRange(r);
    return r.getBoundingClientRect().bottom;
  });
  const menu = tp.locator(".selmenu.under");
  await menu.waitFor({ timeout: 3000 });
  assert.ok((await menu.boundingBox()).y >= selBottom, "on a phone, Mark sits under the picked words");
  await menu.getByRole("button", { name: "Mark", exact: true }).tap();
  const phoneChips = tp.locator(".markchips");
  await phoneChips.waitFor({ timeout: 3000 });
  assert.ok((await phoneChips.boundingBox()).y >= selBottom, "…and so do the chips");
  await phoneChips.getByRole("button", { name: "Note", exact: true }).tap();
  await tp.locator(".fold .fi-edit").waitFor({ timeout: 3000 });
  await phone.close();
  console.log("✓ on a phone, Mark and the chips sit under the picked words, clear of the native menu");
  assert.deepEqual(errors, []);
} finally { await browser.close(); await api(`/api/boards/${board.id}`, "DELETE"); }
