import assert from "node:assert/strict";
import { chromium } from "playwright";

// node tools/writer-smoke.mjs [base]: a list typed with pauses, bold and italic by shortcut and a pasted image are stored as Markdown and drawn again after a reload.
const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
let n = 0;
const run = Date.now().toString(36);
const api = async (path, method = "GET", body) => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": `writer-${run}-${++n}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(res.ok, `${method} ${path}: ${res.status}`); return res.json();
};
const tid = () => "t_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
const bodyOf = async (id) => (await api("/api/dashboard")).tasks.find((t) => t.id === id)?.body;
// 4×4, opaque red
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGO4o6EBRwzEcQDzAxLBI9OCRQAAAABJRU5ErkJggg==";

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const title = `Writer ${run}: a list, marks and a picture`;
  const id = tid();
  await api("/api/dashboard/tasks", "POST", { id, title, body: "", area: "work", stage: "thinking" });
  await page.goto(`${base}/dashboard?view=thinking`, { waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(title).click();
  await page.getByRole("textbox", { name: "Notes" }).click();
  const focusedOnNotes = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Notes");

  // a pause after each item saves it, and the next keys still land in the list
  const steps = [["type", "- buy tape"], ["pause"], ["press", "Enter"], ["type", "fetch poster"], ["pause"], ["press", "Enter"],
    ["press", "Control+b"], ["type", "bold"], ["press", "Control+b"], ["type", " and "], ["press", "Control+i"], ["type", "italic"], ["press", "Control+i"], ["pause"],
    ["press", "Enter"], ["press", "Enter"], ["pause"]];
  for (const [what, keys] of steps) {
    if (what === "type") await page.keyboard.type(keys, { delay: 15 });
    else if (what === "press") await page.keyboard.press(keys);
    else {
      await page.waitForTimeout(1200);
      assert.equal(await focusedOnNotes(), true, "the notes keep focus through a save");
    }
  }
  await page.evaluate((b64) => {
    const file = new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "red.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await page.waitForTimeout(1500);
  await page.keyboard.press("Enter");
  await page.keyboard.type("After the picture.", { delay: 15 });
  await page.waitForTimeout(1500);

  const stored = await bodyOf(id);
  const ref = /!\[\]\(img:([0-9a-f]{16})\)/.exec(stored ?? "");
  assert.ok(ref, `the pasted image is stored as the room's image ref: ${JSON.stringify(stored)}`);
  assert.equal(stored, `- buy tape\n- fetch poster\n- **bold** and *italic*\n\n![](img:${ref[1]})\n\nAfter the picture.`, "the server holds the notes as Markdown");
  assert.equal((await fetch(`${base}/api/images/${ref[1]}`)).status, 200, "the image is stored in the room");
  console.log("✓ a list with pauses, bold and italic by shortcut and a pasted image are saved as Markdown");

  const drawn = async (scope) => scope.evaluate((el) => ({
    items: [...el.querySelectorAll("ul > li")].map((li) => li.textContent),
    bold: el.querySelector("strong")?.textContent ?? null,
    italic: el.querySelector("em")?.textContent ?? null,
    image: (() => { const img = el.querySelector("img"); return img ? { loaded: img.complete && img.naturalWidth > 0, src: img.getAttribute("src") } : null; })(),
    last: [...el.querySelectorAll("p")].filter((p) => !p.closest("li")).at(-1)?.textContent ?? null,
  }));
  const expect = { items: ["buy tape", "fetch poster", "bold and italic"], bold: "bold", italic: "italic", image: { loaded: true, src: `/api/images/${ref[1]}` }, last: "After the picture." };

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(title).click();
  const notes = page.getByRole("textbox", { name: "Notes" });
  await notes.locator("img").evaluate((img) => img.decode?.().catch(() => {}));
  assert.deepEqual(await drawn(notes), expect, "the notes draw their list, marks and image again after a reload");
  console.log("✓ after a reload the notes show the list, bold, italic and the image");

  // the same Markdown read elsewhere, where it isn't being written
  await api(`/api/dashboard/tasks/${id}`, "PATCH", { stage: "review" });
  await page.goto(`${base}/dashboard?view=review`, { waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(title).click();
  const read = page.locator(".doc.review .fold .md");
  await read.locator("img").evaluate((img) => img.decode?.().catch(() => {}));
  assert.deepEqual(await drawn(read), expect, "Review draws the same notes from the same Markdown");
  console.log("✓ Review draws the same list, marks and image");

  // notes from before the Writer: opened and left untouched they are not rewritten, and raw HTML stays text as Review shows it
  const old = tid(), oldBody = "Costs 5*3 <b>raw</b>\n- one\n- two";
  await api("/api/dashboard/tasks", "POST", { id: old, title: `Writer ${run}: old notes`, body: oldBody, area: "work", stage: "thinking" });
  await page.goto(`${base}/dashboard?view=thinking`, { waitUntil: "networkidle" });
  await page.locator(".ws-list").getByText(`Writer ${run}: old notes`).click();
  const oldNotes = page.getByRole("textbox", { name: "Notes" });
  await oldNotes.click();
  await page.keyboard.press("Tab");
  await page.waitForTimeout(1200);
  assert.equal(await oldNotes.locator("strong").count(), 0, "raw HTML is not drawn as bold");
  assert.match(await oldNotes.textContent(), /Costs 5\*3 <b>raw<\/b>/);
  assert.equal(await bodyOf(old), oldBody, "notes opened without a change are not rewritten");
  console.log("✓ older notes open as they were, raw HTML as text, and aren't rewritten unless changed");
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
