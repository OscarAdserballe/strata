import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/writing-smoke.mjs [base]: the dashboard's Writer keeps what you type through a save, keeps focus and the caret, keeps the last line in view, and stores bold, italics, lists and pasted images as Markdown that survives a reload; the notepad opens in both apps.
const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
let n = 0;
const run = Date.now().toString(36);
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": `writing-${run}-${++n}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const tid = () => "t_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const bodyOf = async (id) => (await api("/api/dashboard")).tasks.find((t) => t.id === id)?.body;
async function open(page, title, body = "", id = tid()) {
  if (body !== null) await api("/api/dashboard/tasks", "POST", { id, title, body, area: "work", stage: "thinking" });
  await page.goto(`${base}/dashboard?view=thinking`, { waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(title).click();
  await page.locator(".dbody[contenteditable=true]").waitFor();
  return id;
}
const focused = (page) => page.evaluate(() => document.activeElement?.classList.contains("dbody"));
// what the field shows, list items as "- ", blocks a blank line apart: the shape of what was typed
const shown = (page) => page.evaluate(() => {
  const walk = (x) => x.type === "text" ? x.text : x.type === "bulletList" ? x.content.map((li) => "- " + walk(li)).join("\n") : (x.content ?? []).map(walk).join(x.type === "doc" ? "\n\n" : "");
  return walk(document.querySelector(".dbody").editor.getJSON());
});
// a 2×2 PNG, red
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=";

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // a list typed with pauses between items: each pause saves, and none of them takes back a space, an item or the caret
  const id = await open(page, `Writing ${run}: a list with pauses`);
  await page.getByRole("textbox", { name: "Notes" }).click();
  const steps = [["- buy tape", "- buy tape"], ["\n", "- buy tape\n- "], ["- fetch poster ", "- buy tape\n- fetch poster "], ["\n", "- buy tape\n- fetch poster \n- "], ["- ", "- buy tape\n- fetch poster \n- "]];
  for (const [part, want] of steps) {
    await page.keyboard.type(part, { delay: 15 });
    await page.waitForTimeout(1500);
    assert.equal(await focused(page), true, "the notes keep focus through a save");
    assert.equal(await shown(page), want, `after typing ${JSON.stringify(part)}`);
  }
  await page.keyboard.type("and glue", { delay: 15 });
  const typed = "- buy tape\n- fetch poster \n- and glue";
  assert.equal(await shown(page), typed, "the field shows exactly what was typed");
  await page.waitForTimeout(1500);
  assert.equal(await bodyOf(id), typed, "the server keeps spaces and items as typed");
  // typed in the middle: the caret stays where the keys go, not at the end after the save answers
  await page.keyboard.press("Home");
  await page.keyboard.type("first ", { delay: 15 });
  await page.waitForTimeout(1500);
  await page.keyboard.type("+", { delay: 15 });
  await page.waitForTimeout(1500);
  assert.equal(await bodyOf(id), "- buy tape\n- fetch poster \n- first +and glue");
  console.log("✓ a list typed with pauses keeps every space, item, the caret and focus");

  // the last line of a long doc stays above the footer while you type at it
  const long = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n\n");
  await open(page, `Writing ${run}: a long doc`, long);
  await page.getByRole("textbox", { name: "Notes" }).click();
  await page.keyboard.press("Control+End");
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Enter"); await page.keyboard.type(`more ${i}`, { delay: 10 }); }
  const gap = await page.evaluate(() => document.querySelector(".doc-foot").getBoundingClientRect().top - getSelection().getRangeAt(0).getBoundingClientRect().bottom);
  assert.ok(gap >= 0, `the line being typed sits above the footer, not under it (${gap.toFixed(0)}px)`);
  console.log("✓ the last line of a long doc stays above the footer");

  // opening a doc written elsewhere writes nothing back
  const writes = [];
  const seen = (r) => { if (r.method() !== "GET" && r.url().includes("/api/dashboard/tasks/")) writes.push(r.url()); };
  page.on("request", seen);
  await open(page, `Writing ${run}: from an agent`, "## Context\nWritten by an agent, with snake_case and a [link](https://example.com).\n\n- [ ] one\n- [x] two");
  await page.waitForTimeout(1500);
  page.off("request", seen);
  assert.deepEqual(writes, [], "opening a doc saves nothing");
  console.log("✓ opening a doc writes nothing back");

  // bold and italics by key, a list by typing, a pasted image: stored as Markdown, and the same after a reload
  const title = `Writing ${run}: bold, a list and an image`;
  const rich = await open(page, title);
  await page.getByRole("textbox", { name: "Notes" }).click();
  await page.keyboard.press("ControlOrMeta+b"); await page.keyboard.type("bold", { delay: 10 }); await page.keyboard.press("ControlOrMeta+b");
  await page.keyboard.type(" and ", { delay: 10 });
  await page.keyboard.press("ControlOrMeta+i"); await page.keyboard.type("leaning", { delay: 10 }); await page.keyboard.press("ControlOrMeta+i");
  await page.keyboard.type(" then *typed* and **typed**", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("- one\ntwo\n\n", { delay: 10 });
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "red.png", { type: "image/png" }));
    document.querySelector(".dbody").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await page.locator(".dbody img.strata-img").waitFor();
  await page.keyboard.type("after", { delay: 10 });
  const want = /^\*\*bold\*\* and \*leaning\* then \*typed\* and \*\*typed\*\*\n\n- one\n- two\n\n!\[\]\(img:[0-9a-f]{16}\)\n\nafter$/;
  let stored = "";
  for (let i = 0; i < 20 && !want.test(stored); i++) { await page.waitForTimeout(250); stored = await bodyOf(rich); }
  assert.match(stored, want, "bold, italics, a list and the image are on the server as Markdown");
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(title).click();
  const doc = page.locator(".dbody[contenteditable=true]");
  await doc.waitFor();
  assert.equal(await doc.locator("strong").first().textContent(), "bold");
  assert.equal(await doc.locator("em").first().textContent(), "leaning");
  assert.equal(await doc.locator("strong").count(), 2);
  assert.equal(await doc.locator("li").count(), 2);
  const img = doc.locator("img.strata-img");
  await img.waitFor();
  assert.match(await img.getAttribute("src"), /\/api\/images\/[0-9a-f]{16}$/);
  assert.ok(await img.evaluate((el) => el.decode().then(() => el.naturalWidth === 2, () => false)), "the image draws after a reload");
  assert.equal(await bodyOf(rich), stored, "the reload changed nothing on the server");
  console.log("✓ bold, italics, a list and a pasted image survive a reload");

  // the notepad: opened by its chip on the dashboard, by ⌘; in the reader; what one wrote, the other shows
  const line = `friction ${run}`;
  await page.goto(`${base}/dashboard`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Notepad", exact: true }).click();
  await page.locator(".pad-text[contenteditable=true]").waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains("pad-text"));
  await page.keyboard.press("Enter");
  await page.keyboard.type(line, { delay: 10 });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".pad-sheet").count(), 0, "esc closes the notepad");
  let pad = "";
  for (let i = 0; i < 20 && !pad.includes(line); i++) { await page.waitForTimeout(250); pad = (await api("/api/dashboard/pad")).text; }
  assert.ok(pad.includes(line), `the notepad saved: ${JSON.stringify(pad)}`);
  const boards = await api("/api/boards");
  const reader = (boards.boards ?? boards)[0]?.id;
  await page.goto(`${base}/${reader ? `?board=${reader}` : ""}`, { waitUntil: "networkidle" });
  await page.keyboard.press("ControlOrMeta+Semicolon");
  const there = page.locator(".pad-text[contenteditable=true]");
  await there.waitFor();
  assert.ok((await there.innerText()).includes(line), "the reader's notepad shows the dashboard's line");
  await page.keyboard.type(" and r o h b", { delay: 10 });
  assert.ok((await there.innerText()).includes(`${line} and r o h b`), "letters typed in the notepad stay out of the room's shortcuts");
  await page.keyboard.press("ControlOrMeta+Semicolon");
  assert.equal(await page.locator(".pad-sheet").count(), 0, "⌘; closes it again");
  console.log("✓ the notepad opens on the dashboard and in the reader, and keeps what either wrote");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
