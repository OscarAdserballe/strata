import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.argv[2] || "http://127.0.0.1:8804";
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: "block" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    let calls = 0, writes = 0, patches = 0, failSave = true;
    const keys = [];
    const front = `Tidy smoke ${viewport.width} ${Date.now()}`;
    await page.route("**/api/cards/tidy", async route => {
      calls++;
      if (calls === 1) return route.fulfill({ status: 502, json: { error: "Tidying failed; your draft is still here." } });
      const { faces } = route.request().postDataJSON();
      return route.fulfill({ json: { faces: { ...faces, back: faces.back.replaceAll("x²", "$x^2$").replaceAll("y³", "$y^3$") } } });
    });
    await page.route("**/api/library/cards", async route => {
      writes++;
      keys.push(route.request().headers()["idempotency-key"]);
      if (failSave) { failSave = false; return route.fulfill({ status: 502, json: { error: "Save interrupted" } }); }
      return route.continue();
    });
    page.on("request", r => { if (r.method() === "PATCH" && r.url().includes("/cards/")) patches++; });
    const format = () => page.getByRole("button", { name: "Format & Preview", exact: true }).click();
    const confirm = () => page.getByRole("button", { name: "Confirm save", exact: true }).click();
    const back = () => page.getByRole("button", { name: "Back to editing", exact: true }).click();
    const preview = page.getByRole("region", { name: "Formatted card preview" });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "New card", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await page.getByLabel("Front", { exact: true }).fill(front);
    await page.getByLabel("Back", { exact: true }).fill("x²");
    await page.getByLabel("Source or attribution (optional)").fill("My notebook");
    await format();
    await dialog.getByRole("alert").filter({ hasText: "Tidying failed" }).waitFor();
    assert.equal(writes, 0);
    assert.equal(await page.getByLabel("Back", { exact: true }).inputValue(), "x²");
    await format();
    await preview.locator(".katex").waitFor();
    assert.equal(writes, 0, "formatting never creates the card");
    assert.equal(await page.getByLabel("Back", { exact: true }).count(), 0, "the preview replaces the form");
    await back();
    assert.equal(await page.getByLabel("Back", { exact: true }).inputValue(), "$x^2$");
    assert.equal(await page.getByLabel("Source or attribution (optional)").inputValue(), "My notebook");
    await page.getByLabel("Back", { exact: true }).fill("y³");
    await format();
    await preview.locator(".katex").waitFor();
    assert.equal(calls, 3, "editing invalidates the previous preview");
    assert.equal(writes, 0);
    await confirm();
    // a 502 is a lost answer: resent under the same key, so the card is saved once without a second press
    await page.getByRole("status").filter({ hasText: "Saved to Unfiled" }).waitFor();
    assert.equal(writes, 2, "the interrupted save was sent again, once");
    assert.ok(keys[0] && keys[0] === keys[1], "under the same Idempotency-Key");
    assert.equal(calls, 3, "confirmation and persistence retries never call the model");
    const library = await (await fetch(base + "/api/library")).json();
    assert.equal(library.cards.filter(c => c.front === front).length, 1, "one card");
    const stored = library.cards.find(c => c.front === front);
    assert.equal(stored.back, "$y^3$");
    assert.equal(stored.source, "My notebook");
    await dialog.getByText(front, { exact: true }).click();
    await dialog.locator(".katex").first().waitFor();
    const review = await (await fetch(base + "/api/review")).json();
    // newly kept cards are scheduled in the future; make this one due in the browser fixture only
    const card = { ...stored, type: "flashcard", deck: "strata-personal-cards/yours", course: "strata-personal-cards",
      courseTitle: "Unfiled cards", rung: 0, dueAt: Date.now(), ord: 0 };
    await page.route("**/api/review", route => route.fulfill({ json: { ...review, cards: [card], total: 1 } }));
    await page.goto(base + "/?view=review", { waitUntil: "networkidle" });
    await page.locator(".ced-b").click();
    assert.equal(await page.getByRole("button", { name: "tidy", exact: true }).count(), 0);
    await page.locator(".ced textarea").first().fill(front + " edited");
    await format();
    await preview.waitFor();
    assert.equal(patches, 0, "previewing an edit does not patch the card");
    await back();
    assert.equal(await page.locator(".ced textarea").first().inputValue(), front + " edited");
    await page.keyboard.press("Control+Enter");
    await preview.waitFor();
    await page.keyboard.press("Control+Enter");
    assert.equal(patches, 0, "the format shortcut cannot confirm a preview");
    await confirm();
    await page.locator(".ced").waitFor({ state: "detached" });
    assert.equal(calls, 4);
    assert.equal(patches, 1);
    const edited = (await (await fetch(base + "/api/library")).json()).cards.find(c => c.id === stored.id);
    assert.equal(edited.front, front + " edited");
    assert.equal(edited.back, "$y^3$");
    await page.getByRole("button", { name: "new card", exact: true }).click();
    await page.locator(".rcompose .front").fill(front + " composer");
    await page.locator(".rcompose .back").fill("x²");
    await format();
    await preview.locator(".katex").waitFor();
    assert.equal(writes, 2, "composer formatting also waits for confirmation");
    await back();
    assert.equal(await page.locator(".rcompose .back").inputValue(), "$x^2$");
    await page.locator(".rcompose .back").fill("y³");
    await format();
    await confirm();
    await page.locator(".rcompose").waitFor({ state: "detached" });
    assert.equal(calls, 6);
    assert.equal((await (await fetch(base + "/api/library")).json()).cards.find(c => c.front === front + " composer").back, "$y^3$");
    await page.getByRole("button", { name: "new card", exact: true }).click();
    await page.locator(".rcompose .front").fill(front + " cancelled");
    await page.locator(".rcompose .back").fill("x²");
    await format();
    await preview.waitFor();
    await page.locator(".rcompose").getByRole("button", { name: "esc", exact: true }).click();
    await page.locator(".rcompose").waitFor({ state: "detached" });
    assert.equal(writes, 3, "cancelling a preview saves nothing");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("✓ format, preview, back to editing, exact confirmation, failures, retries and cancel at desktop and phone sizes");
} finally { await browser.close(); }
