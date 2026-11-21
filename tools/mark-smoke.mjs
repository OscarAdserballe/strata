// Mark highlights picked words at once; the chips under it open a note, a question or a card, and a letter starts the note.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/$/, "");
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const PHRASES = ["the first passage kept", "a second passage marked by key", "a third passage asked about", "a fourth passage made a card", "a fifth passage written on", "a sixth passage taken back"];
const TEXT = "# Marks\n\n" + PHRASES.map((p, i) => `Paragraph ${i + 1} holds ${p}, and then some words that only fill the line out.`).join("\n\n") + "\n";
const board = (await api("/api/boards", "POST", { title: `Mark fixture ${Date.now()}` })).board;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const r = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "marks.md", text: TEXT, pair: true });
  const pair = r.state.pairs.find((p) => p.resourceId === r.id);
  const page = await (await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?board=${board.id}&pair=${pair.id}`, { waitUntil: "networkidle" });
  await page.locator(".prose p", { hasText: PHRASES[0] }).waitFor();

  const menu = page.locator(".selmenu:not(.chips)"), chips = page.locator(".selmenu.chips");
  const names = (at) => at.locator("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") || [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("").trim()));
  const chip = (name) => chips.getByRole("button", { name, exact: true });
  const serverMarks = async () => (await api(`/api/boards/${board.id}`)).marks.filter((m) => m.resourceId === r.id);
  const markOf = async (phrase) => (await serverMarks()).find((m) => m.quote.includes(phrase.split(" ").slice(1, 3).join(" ")));
  const pick = async (words) => {
    const at = await page.evaluate((words) => {
      const w = document.createTreeWalker(document.querySelector(".page-col.prose"), NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.nodeValue.indexOf(words); if (i < 0) continue;
        const g = document.createRange(); g.setStart(n, i); g.setEnd(n, i + 1); const a = g.getBoundingClientRect();
        g.setStart(n, i + words.length - 1); g.setEnd(n, i + words.length); const z = g.getBoundingClientRect();
        return { x0: a.left + 1, y0: a.top + a.height / 2, x1: z.right - 1, y1: z.top + z.height / 2 };
      }
      return null;
    }, words);
    assert.ok(at, `"${words}" is on the page`);
    await page.mouse.move(at.x0, at.y0); await page.mouse.down();
    await page.mouse.move(at.x1, at.y1, { steps: 6 }); await page.mouse.up();
    await menu.waitFor();
  };
  const posted = () => page.waitForResponse((x) => x.url().endsWith(`/api/boards/${board.id}/marks`) && x.request().method() === "POST");
  const painted = (phrase) => page.locator(".page-col.prose .mk", { hasText: phrase.split(" ").slice(1, 3).join(" ") });

  await pick(PHRASES[0]);
  assert.deepEqual(await names(menu), ["Mark"], "the menu is one Mark button");
  const saved = posted();
  await menu.getByRole("button", { name: "Mark", exact: true }).click();
  await painted(PHRASES[0]).first().waitFor({ timeout: 2000 });
  await chips.waitFor();
  assert.equal(await page.locator(".fold .fi-edit").count(), 0, "no note sheet opens");
  assert.deepEqual(await names(chips), ["Note", "Ask", "Card"]);
  assert.equal((await saved).status() < 300, true, "the highlight saved");
  console.log("✓ Mark highlights the words at once, saves them, and offers Note · Ask · Card with no sheet");

  await page.keyboard.press("Escape");
  await chips.waitFor({ state: "detached" });
  assert.ok(await painted(PHRASES[0]).count() > 0, "the highlight is still painted");
  assert.ok(await markOf(PHRASES[0]), "the server holds the highlight");
  console.log("✓ Esc drops the chips; the highlight stays");

  await pick(PHRASES[1]);
  await page.keyboard.press("m");
  await chips.waitFor();
  await page.keyboard.press("n");
  const editor = page.locator(".fold .fi-edit");
  await editor.waitFor();
  assert.equal(await editor.inputValue(), "", "n opens the note empty");
  await page.keyboard.press("Escape");
  await editor.waitFor({ state: "detached" });
  console.log("✓ m marks; n opens the note sheet for that mark");

  await pick(PHRASES[2]);
  await menu.getByRole("button", { name: "Mark", exact: true }).click();
  await chip("Ask").click();
  await page.locator(".fold .fi.asked .fi-q").waitFor();
  await chips.waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await pick(PHRASES[3]);
  await page.keyboard.press("m");
  await chips.waitFor();
  await page.keyboard.press("c");
  const draft = page.locator(".fold .fi.draft");
  await draft.waitFor();
  assert.ok((await draft.innerText()).includes("fourth"), "the card's sheet is on the marked words");
  await draft.locator(".fi-front").press("Escape");
  console.log("✓ Ask and Card open their sheets on the marked words");

  await pick(PHRASES[4]);
  await menu.getByRole("button", { name: "Mark", exact: true }).click();
  await chips.waitFor();
  await page.keyboard.press("W");
  await editor.waitFor();
  assert.equal(await editor.inputValue(), "W", "the note opens with the letter typed");
  await page.keyboard.type("hy it matters");
  await page.keyboard.press("Escape");
  await page.waitForFunction(async ([b, rid]) => {
    const s = await (await fetch(`/api/boards/${b}`)).json();
    return s.marks.some((m) => m.resourceId === rid && m.note === "Why it matters");
  }, [board.id, r.id], { timeout: 5000 });
  console.log("✓ a letter typed over the chips opens the note with it");

  await pick(PHRASES[5]);
  await menu.getByRole("button", { name: "Mark", exact: true }).click();
  await chips.waitFor();
  assert.equal(await chip("Remove highlight").count(), 0, "a fresh mark has no ✕: ⌘Z takes it back");
  await page.mouse.click(5, 5);
  await chips.waitFor({ state: "detached" });
  const id = (await markOf(PHRASES[5]))?.id;
  assert.ok(id, "the sixth mark saved");
  await page.locator(`.page-col.prose .mk[data-mark="${id}"]`).first().click();
  await chips.waitFor();
  assert.equal(await page.locator(".fold .fi-edit").count(), 0, "a tap on a highlight offers its chips, not a sheet");
  await chip("Remove highlight").click();
  await page.waitForFunction(async ([b, mid]) => !(await (await fetch(`/api/boards/${b}`)).json()).marks.some((m) => m.id === mid), [board.id, id], { timeout: 5000 });
  assert.equal(await page.locator(`.page-col.prose .mk[data-mark="${id}"]`).count(), 0, "the highlight is gone from the page");
  console.log("✓ a tap on a highlight brings its chips back, and ✕ removes it");

  assert.deepEqual(errors, []);
} finally { await browser.close(); await api(`/api/boards/${board.id}`, "DELETE"); }
