import { chromium } from "playwright";
import assert from "node:assert/strict";
import { afterRequests, settled } from "./settled.mjs";

// The attach smoke: screenshots pasted and dropped into the Ask and onto card faces; checks read the server.
const base = process.argv[2] || "http://127.0.0.1:8804";
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const json = async (path) => (await fetch(base + path)).json();

async function shot(target, { event = "paste", width = 2400, height = 1500, label = "fig" } = {}) {
  return target.evaluate(async (el, o) => {
    const c = document.createElement("canvas"); c.width = o.width; c.height = o.height;
    const g = c.getContext("2d"); g.fillStyle = "#fafafa"; g.fillRect(0, 0, o.width, o.height);
    g.strokeStyle = "#2f47c4"; g.lineWidth = 10; g.beginPath(); g.moveTo(0, o.height / 2);
    for (let x = 0; x < o.width; x += 20) g.lineTo(x, o.height / 2 - (o.height / 3) * Math.sin(x / 250) * Math.exp(-x / o.width));
    g.stroke(); g.fillStyle = "#222"; g.font = "60px sans-serif"; g.fillText(o.label, 40, 90);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
    if (o.event === "paste") { el.focus(); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }
    else for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    return blob.size;
  }, { event, width, height, label });
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { boards } = await json("/api/boards");
  const board = boards.find((b) => b.title.startsWith("Reading")) ?? boards[0];
  await page.goto(`${base}/?board=${board.id}`, { waitUntil: "networkidle" });
  const line = page.locator(".ask .line input");
  const imports = async () => (await json("/api/imports")).imports?.length ?? 0;
  const importsBefore = await imports();

  const bytes = await shot(line, { label: "fig 3.2 — damped response" });
  await page.locator(".ask .att-thumb").first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".ask .att-ring"), null, { timeout: 15_000 });
  // a second one, dropped on the room rather than the dock: it is not a source, it is the tray's
  await shot(page.locator(".panes"), { event: "drop", width: 800, height: 500, label: "second" });
  await page.waitForFunction(() => document.querySelectorAll(".ask .att-thumb").length === 2, null, { timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".ask .att-ring"), null, { timeout: 15_000 });
  assert.equal(await imports(), importsBefore, "a dropped screenshot is not imported as a source");
  // taken back with ×, then asked about
  await page.locator(".ask .att-thumb").nth(1).getByRole("button", { name: "Remove image" }).click();
  assert.equal(await page.locator(".ask .att-thumb").count(), 1);

  const question = `What does this curve do? ${Date.now()}`;
  await line.fill(question);
  await line.press("Enter");
  await page.waitForFunction(() => document.body.innerText.includes("I can see the image you sent"), null, { timeout: 30_000 });
  await settled(page);
  const { messages } = await json(`/api/boards/${board.id}/messages`);
  const asked = messages.filter((m) => m.role === "user" && m.text.includes(question));
  assert.equal(asked.length, 1, "the question is stored once");
  const id = /\]\(img:([0-9a-f]{16})\)/.exec(asked[0].text)?.[1];
  assert.ok(id, `the question carries its image: ${JSON.stringify(asked[0].text)}`);
  const stored = await fetch(`${base}/api/images/${id}`);
  assert.equal(stored.status, 200);
  const size = (await stored.arrayBuffer()).byteLength;
  assert.ok(size < bytes, `a 2400 px screenshot is shrunk before it is kept (${bytes} → ${size} bytes)`);
  assert.equal(await page.locator(".ask .att-thumb").count(), 0, "the tray empties when the question goes");

  const mine = page.locator(".ask .turn.me", { hasText: question }).locator("img.strata-img");
  await mine.waitFor();
  assert.ok(await mine.evaluate((img) => img.naturalWidth === 1600), "the stored copy's long side is 1600 px");
  await mine.click();
  await page.locator("dialog.att-box[open]").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("dialog.att-box[open]"));
  assert.equal(await page.locator(".ask .turns").count(), 1, "esc closed the picture, not the thread under it");

  // the reply made into a card: the screenshot goes on the front with the question
  await page.locator(".ask button.mint-c").last().click();
  const front = page.locator(".comp textarea.front");
  await front.waitFor();
  assert.ok((await front.inputValue()).includes(`](img:${id})`), "the new card's front keeps the screenshot");
  await page.locator(".comp .att-thumb img").first().waitFor();
  await page.locator(".comp button.mint-ghost", { hasText: "esc" }).click();

  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "New card", exact: true }).first().click();
  const faceFront = `A portrait to read ${Date.now()}`;
  await page.getByLabel("Front", { exact: true }).fill(faceFront);
  await shot(page.locator("#personal-front"), { width: 900, height: 600, label: "phase portrait" });
  await page.waitForFunction(() => document.querySelector("#personal-front").value.includes("](img:"), null, { timeout: 15_000 });
  await page.getByLabel("Back", { exact: true }).fill("A stable spiral.");
  let tidied = null;
  await page.route("**/api/cards/tidy", async (route) => { tidied = route.request().postDataJSON().faces; await route.fallback(); });
  await page.getByRole("button", { name: "Format & Preview", exact: true }).click();
  await page.locator('[aria-label="Formatted card preview"] img.strata-img').waitFor();
  assert.ok(tidied && !JSON.stringify(tidied).includes("img:"), `the tidy never sees the image: ${JSON.stringify(tidied)}`);
  await afterRequests(page, () => page.getByRole("button", { name: "Confirm save", exact: true }).click());
  await page.getByRole("status").filter({ hasText: "Saved to Unfiled" }).waitFor();
  const library = await json("/api/library");
  const card = library.cards.find((c) => c.front.startsWith(faceFront));
  assert.ok(card && /\n!\[\]\(img:[0-9a-f]{16}\)$/.test(card.front), `the saved front carries the image after its words: ${JSON.stringify(card?.front)}`);
  assert.deepEqual(errors, [], "no page errors on the desktop");
  await ctx.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const p = await phone.newPage();
  const perrors = [];
  p.on("pageerror", (e) => perrors.push(e.message));
  await p.goto(base, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Unfiled cards", exact: true }).first().tap();
  const row = p.locator("details", { hasText: faceFront });
  await row.locator("summary").tap();
  const img = row.locator("img.strata-img");
  await img.waitFor();
  await p.waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle());
  const box = await img.boundingBox();
  assert.ok(box && box.width > 40 && box.x >= 0 && box.x + box.width <= 390, `the picture is within the screen: ${JSON.stringify(box)}`);
  assert.deepEqual(perrors, [], "no page errors on the phone");
  await phone.close();
  console.log("attach smoke passed");
} finally {
  await browser.close();
}
