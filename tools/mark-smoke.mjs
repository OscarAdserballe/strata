// Mark on picked words makes one highlight at once; its chips open the note, a question or a card on it.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const TEXT = `# Marks and chips

The first passage is marked and left alone, and it stays.

The second passage is marked and given a note from its chips.

The third passage gets its note by typing straight away.

The fourth passage is asked about, so it keeps no highlight of its own.
`;
const board = (await api("/api/boards", "POST", { title: `Mark fixture ${Date.now()}` })).board;
const r = await api(`/api/boards/${board.id}/resources`, "POST", { filename: "marks.md", text: TEXT, pair: true });
const pair = r.state.pairs.find((p) => p.resourceId === r.id);
const marksNow = async () => (await api(`/api/boards/${board.id}`)).marks.filter((m) => m.resourceId === r.id);
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await (await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/?board=${board.id}&pair=${pair.id}`, { waitUntil: "networkidle" });
  await page.locator(".prose p", { hasText: "fourth passage" }).waitFor();
  const pick = async (words) => {
    const at = await page.evaluate((words) => {
      const walk = document.createTreeWalker(document.querySelector(".page-col.prose"), NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const i = n.nodeValue.indexOf(words);
        if (i < 0) continue;
        const rg = document.createRange();
        rg.setStart(n, i); rg.setEnd(n, i + 1); const a = rg.getBoundingClientRect();
        rg.setStart(n, i + words.length - 1); rg.setEnd(n, i + words.length); const z = rg.getBoundingClientRect();
        return { x0: a.left + 1, y0: a.top + a.height / 2, x1: z.right - 1, y1: z.top + z.height / 2 };
      }
      return null;
    }, words);
    assert.ok(at, `"${words}" is on the page`);
    await page.mouse.move(at.x0, at.y0); await page.mouse.down();
    await page.mouse.move(at.x1, at.y1, { steps: 6 }); await page.mouse.up();
    await page.locator(".selmenu").waitFor();
  };
  const painted = () => page.evaluate(() => [...new Set([...document.querySelectorAll(".page-col.prose .mk[data-mark]")].map((el) => el.dataset.mark))]);
  const settled = () => page.evaluate(() => window.__strataSettled?.());
  const chips = page.locator(".markchips");
  const chipNames = () => chips.locator("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") || b.textContent));

  await pick("marked and left alone");
  assert.deepEqual(await page.locator(".selmenu button").allTextContents(), ["Mark"], "the selection menu offers Mark alone");
  await page.locator(".selmenu").getByRole("button", { name: "Mark", exact: true }).click();
  await chips.waitFor();
  assert.deepEqual(await chipNames(), ["Note", "Ask", "Card"], "a new mark's chips: Note · Ask · Card");
  assert.equal((await painted()).length, 1, "Mark paints one highlight at once");
  await page.keyboard.press("Escape");
  await chips.waitFor({ state: "detached" });
  await settled();
  const first = await marksNow();
  assert.equal(first.length, 1, `Mark makes exactly one highlight (${first.length} on the server)`);
  assert.ok(first[0].quote.includes("marked and left alone") && !first[0].note, "a bare highlight on the picked words");
  assert.deepEqual(await painted(), [first[0].id], "Esc drops the chips and the highlight stays");
  console.log("✓ Mark makes exactly one highlight, and Esc leaves it");

  await pick("given a note from its chips");
  await page.keyboard.press("m");
  await chips.waitFor();
  await chips.getByRole("button", { name: "Note", exact: true }).click();
  const editor = page.locator(".fold .fi.note .fi-edit");
  await editor.waitFor();
  const second = (await painted()).find((id) => id !== first[0].id);
  assert.ok(second, "the second mark is painted");
  assert.equal(await page.locator(".fold .fi.note:has(.fi-edit)").getAttribute("data-id"), second, "Note from the chips opens the sheet on that mark");
  await editor.fill("why it stays");
  await editor.press("Escape");
  await settled();
  const noted = (await marksNow()).find((m) => m.id === second);
  assert.equal(noted?.note, "why it stays", "the note is saved on that mark");
  console.log("✓ Note from the chips opens the sheet on that mark");

  await pick("by typing straight away");
  await page.keyboard.press("m");
  await chips.waitFor();
  await page.keyboard.type("Ty");
  await editor.waitFor();
  assert.equal(await editor.inputValue(), "Ty", "a letter typed at the chips starts the note with it");
  await editor.press("Escape");
  await settled();
  assert.equal((await marksNow()).length, 3, "three marks, one each");
  console.log("✓ typing a letter opens the note with it");

  await pick("is asked about");
  await page.locator(".selmenu").getByRole("button", { name: "Mark", exact: true }).click();
  await chips.getByRole("button", { name: "Ask", exact: true }).click();
  await page.locator(".fold .fi.asked .fi-q").first().waitFor();
  await settled();
  assert.equal((await marksNow()).length, 3, "Ask from a new mark's chips takes the mark back: no highlight of its own");
  assert.equal((await painted()).length, 3, "…and none on the page");
  await page.keyboard.press("Escape");
  console.log("✓ Ask from the chips leaves no highlight");

  await page.locator(`.page-col.prose .mk[data-mark="${first[0].id}"]`).first().click();
  await chips.waitFor();
  assert.deepEqual(await chipNames(), ["Note", "Ask", "Card", "Remove the mark"], "a mark tapped again: its chips and ✕");
  await chips.getByRole("button", { name: "Remove the mark" }).click();
  await settled();
  assert.ok(!(await marksNow()).some((m) => m.id === first[0].id), "✕ removes the mark");
  console.log("✓ a mark tapped again reopens its chips, and ✕ removes it");

  assert.deepEqual(errors, [], "no page errors");
} finally {
  await browser.close();
  await api(`/api/boards/${board.id}`, "DELETE").catch(() => {});
}
console.log("\nmark smoke passed");
