#!/usr/bin/env node
// Every screen is a route: Back, Forward and reload land where you were, and ? answers on every screen.
const APP = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
const { chromium } = await import("playwright");

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };
const boards = await (await fetch(`${APP}/api/boards`)).json();
const book = boards.boards.find((b) => b.title === "The Discipline of Repetition");
if (!book) { console.error("✗ the seeded book board is missing"); process.exit(1); }
const other = boards.boards.find((b) => b.id !== book.id);
const bookState = await (await fetch(`${APP}/api/boards/${book.id}`)).json();
const chapter = (bookState.pairs || []).find((p) => p.resourceId && p.deck);

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const sheetOnTop = () => page.evaluate(() => {
    const sheet = document.querySelector(".keys-sheet"), veil = document.querySelector(".keys-veil");
    if (!sheet || !veil) return false;
    const r = sheet.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + 12);
    return !!top && !!top.closest(".keys-sheet")
      && getComputedStyle(veil).zIndex === getComputedStyle(document.documentElement).getPropertyValue("--layer-sheet").trim();
  });
  const param = (name) => new URL(page.url()).searchParams.get(name);
  const view = () => new URL(page.url()).searchParams.get("view");
  const shown = (sel) => page.waitForSelector(sel, { timeout: 8000 }).then(() => true, () => false);
  const gone = (sel) => page.waitForSelector(sel, { state: "detached", timeout: 8000 }).then(() => true, () => false);

  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForSelector(".launcher", { timeout: 10000 });
  await page.keyboard.press("?");
  check("? opens the keys sheet over the library", await shown(".keys-sheet") && await sheetOnTop());
  await page.keyboard.press("Escape");
  await gone(".keys-sheet");

  await page.goto(`${APP}/?board=${book.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".status, .rbar", { timeout: 10000 });
  await page.keyboard.press("x");
  check("x opens the cram, and the address bar says so", await shown(".cramv") && view() === "cram", page.url());
  await page.keyboard.press("?");
  const sheet = await shown(".keys-sheet") ? await page.textContent(".keys-sheet") : "";
  check("? over the cram documents the cram's own keys, on top of it", /not on the exam|drop/.test(sheet) && await sheetOnTop());
  await page.keyboard.press("Escape");
  await gone(".keys-sheet");
  check("…and esc took the sheet, not the cram", await page.$(".cramv") !== null);
  await page.reload({ waitUntil: "networkidle" });
  check("a reload comes back to the cram", await shown(".cramv") && view() === "cram");
  await page.keyboard.press("Escape");
  check("esc leaves the cram for its board", await gone(".cramv") && view() === null && new URL(page.url()).searchParams.get("board") === book.id);
  await page.goBack();
  check("Back returns to the cram", await shown(".cramv") && view() === "cram");
  await page.goForward();
  check("Forward leaves it again", await gone(".cramv"));

  await page.keyboard.press("x");
  await shown(".cramv");
  await page.getByRole("button", { name: "every card", exact: true }).click();
  await page.keyboard.press("Enter");
  if (await shown(".cramv .cram-card")) {
    const mcq = await page.$(".cramv .cram-card .opts, .cramv .cram-card [class*=mcq]");
    await page.keyboard.press(mcq ? "1" : " ");
    await page.keyboard.press("e");
    const opened = await shown(".cramv .ced");
    await page.keyboard.press("Escape");
    const closed = await gone(".cramv .ced");
    const typing = await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA");
    const before = await page.textContent(".cramv .count");
    await page.keyboard.press("2");
    const graded = await page.waitForFunction((was) => document.querySelector(".cramv .count")?.textContent !== was
      || !!document.querySelector(".cramv .rdone-line"), before, { timeout: 4000 }).then(() => true, () => false);
    check("the cram's editor closes on esc and the keys answer at once", opened && closed && !typing && graded,
      !opened ? "e opened no editor" : !closed ? "an editor stayed in the card" : typing ? "focus stayed in a textarea" : !graded ? "2 did not grade" : undefined);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await gone(".cramv");
  } else check("the cram starts a round over every card", false);

  await page.keyboard.press("r");
  check("r opens the keeps, and the address bar says so", await shown(".bench-at, .bench-lib") && view() === "keeps", page.url());
  const keepsUrl = page.url();
  await page.reload({ waitUntil: "networkidle" });
  check("a reload comes back to the keeps", await shown(".bench-at, .bench-lib") && page.url() === keepsUrl);
  await page.goBack();
  check("Back leaves the keeps for the board", await gone(".bench-at, .bench-lib") && view() === null);

  if (chapter) {
    await page.goto(`${APP}/?board=${book.id}&resource=${chapter.resourceId}&pair=${chapter.id}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".status, .rbar", { timeout: 10000 });
    await page.keyboard.press("x");
    await shown(".cramv");
    await page.reload({ waitUntil: "networkidle" });
    await shown(".cramv");
    await page.keyboard.press("Escape");
    check("a reloaded cram closes onto the chapter it was opened from", await gone(".cramv") && param("pair") === chapter.id, page.url());
  } else check("the seeded book has a chapter with a deck", false);

  const fresh = await context.newPage();
  fresh.on("pageerror", (e) => errors.push(String(e)));
  await fresh.goto(`${APP}/?board=${book.id}`, { waitUntil: "networkidle" });
  await fresh.waitForSelector(".status, .rbar", { timeout: 10000 });
  const before = await fresh.evaluate(() => history.length);
  await fresh.goto(`${APP}/?view=keeps`, { waitUntil: "networkidle" });
  check("the library's keeps have an address", await fresh.waitForSelector(".bench-lib", { timeout: 8000 }).then(() => true, () => false));
  await fresh.waitForTimeout(300);
  check("…and loading it adds one history entry, not three", await fresh.evaluate(() => history.length) === before + 1);
  await fresh.close();

  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForSelector(".launcher", { timeout: 10000 });
  await page.keyboard.press("r");
  check("r in the library opens its keeps", await shown(".bench-lib") && view() === "keeps");
  await page.keyboard.press("?");
  check("? over the library's keeps opens the sheet on top of them", await shown(".keys-sheet") && await sheetOnTop());
  await page.keyboard.press("Escape");
  await gone(".keys-sheet");
  await page.goBack();
  check("Back from the library's keeps closes them", await gone(".bench-lib") && view() === null && await page.$(".launcher") !== null);

  if (other) {
    await page.goto(`${APP}/?board=${other.id}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".status, .rbar", { timeout: 10000 });
    await page.keyboard.press("b");
    await shown(".launcher");
    await page.keyboard.press("r");
    await shown(".bench-lib .bcov");
    await page.click(`.bench-lib .bcov:has-text(${JSON.stringify(book.title)})`);
    await page.waitForFunction((id) => new URL(location.href).searchParams.get("board") === id, book.id, { timeout: 8000 }).catch(() => {});
    check("a board opened from the library's keeps says it came from the library", param("from") === "library" && param("board") === book.id, page.url());
    await page.goBack();
    check("Back steps up to the library's keeps", view() === "keeps" && param("board") === null && await shown(".bench-lib"));
    await page.goForward();
    check("Forward comes back to that board's keeps, still over the library",
      param("from") === "library" && await shown(".bench-lib") && await page.$(".launcher") !== null && await page.$(".bench-at") === null);
    for (let i = 0; i < 3; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(150); }
    check("…and esc, frame by frame, comes down to the board that was open all along", await gone(".launcher") && param("board") === other.id && view() === null, page.url());
  } else check("the seeded room has a second board", false);

  check("no page errors", errors.length === 0, errors[0]);
} finally {
  await browser.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} navigation check(s) failed` : "\nnavigation: every screen is a route");
process.exit(failed ? 1 : 0);
