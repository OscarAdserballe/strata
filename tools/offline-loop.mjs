// node tools/offline-loop.mjs [base]: the flight. Downloads a board, goes offline and reloads, then does the whole study loop,
// and on reconnect reads the server back: every write made in the air is there exactly once.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { until } from "./settled.mjs";

const app = process.argv[2] || "http://127.0.0.1:8804";
const api = async (path, method = "GET", body) => {
  const r = await fetch(app + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `${method} ${path}: ${r.status}`);
  return r.json();
};
const { boards } = await api("/api/boards");
const book = boards.find((b) => b.title === "The Discipline of Repetition");
const explore = boards.find((b) => /explorations/i.test(b.title));
assert.ok(book && explore, "Run preview.sh first");
const state = await api(`/api/boards/${book.id}`);
const treed = (state.sections || []).find((s) => s.tree || s.hasTree) ?? state.sections?.[0];
const deck = (state.pairs || []).find((p) => p.deck)?.deck;
const live = (await api(`/api/boards/${explore.id}`)).resources.find((r) => r.kind === "html");
assert.ok(treed && deck && live, "the book needs a section and a deck, and explorations a live page");

const run = Date.now().toString(36);
const front = `Offline ${run}: why does the fixed-effects estimator drop time-invariant regressors?`;
const back = `They are differenced away, ${run}.`;
const edited = `Rewritten over the sea, ${run}.`;
const link = `https://example.test/offline-loop-${run}`;
const checks = [];
const check = (what, ok, why) => { checks.push(what); assert.ok(ok, `${what}${why ? ` — ${why}` : ""}`); console.log(`✓ ${what}`); };

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // the capture provider is stubbed: the link becomes a text source on the board it was saved to
  const captures = [];
  await context.route("**/api/boards/*/capture", async (route) => {
    const key = route.request().headers()["idempotency-key"];
    const id = new URL(route.request().url()).pathname.split("/")[3];
    captures.push({ key, id });
    const source = await api(`/api/boards/${id}/resources`, "POST", { filename: `Captured ${run}`, text: `# Captured ${run}\n\nRead later.`, pair: true });
    await route.fulfill({ status: 201, json: { kind: "article", resourceId: source.id, title: `Captured ${run}`, state: source.state } });
  });

  for (const b of [explore, book]) {
    await page.goto(`${app}/?board=${b.id}`);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.getByRole("button", { name: "Project menu", exact: true }).click();
    await page.locator('button[title*="keep this board readable offline"]').click();
    const said = page.getByText(/^downloaded/);
    await said.waitFor({ timeout: 90000 });
    assert.match(await said.innerText(), /^downloaded for offline reading/, `${b.title}: ${await said.innerText()}`);
    await said.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  }
  check("both boards download for the flight", true);

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".connection-mark.off").waitFor({ timeout: 30000 });
  check("offline, the room reopens with a small marker, not a bar", await page.locator(".connection-banner").count() === 0);

  const status = (u) => page.evaluate(async (url) => (await fetch(url)).status, u);
  check("the concept tree opens offline", await status(`${app}/api/boards/${book.id}/resources/${treed.resourceId}/tree?section=${encodeURIComponent(treed.id)}`) === 200);
  check("review's tree for the deck opens offline", 200 === (await status(`${app}/api/review/tree?course=${encodeURIComponent(deck)}`)));
  check("a live primer opens offline", await status(`${app}/api/boards/${explore.id}/resources/${live.id}/live${live.generation ? `?v=${live.generation}` : ""}`) === 200);

  // cram: reveal, edit the card's back without formatting, grade it
  await page.keyboard.press("x");
  await page.locator(".cramv").waitFor();
  await page.getByRole("button", { name: "every card", exact: true }).click();
  await page.keyboard.press("Enter");
  await page.locator(".cramv .cram-card").waitFor();
  const cardFront = (await page.locator(".cramv .cram-card .q").first().innerText()).trim();
  await page.keyboard.press(" ");
  await page.keyboard.press("e");
  const form = page.locator(".cramv .ced");
  await form.waitFor();
  const format = form.getByRole("button", { name: "Format · needs a connection", exact: true });
  check("offline, Format is greyed out and says why", await format.isDisabled());
  const faces = form.locator("textarea");
  await faces.nth(1).fill(edited);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await form.waitFor({ state: "detached" });
  check("an edit saves offline without formatting", true);
  await page.keyboard.press("2");
  await page.keyboard.press("Escape");

  // review grades offline are driven by review-smoke's flight; the preview's review has nothing due

  // a new card, from the library
  await page.goto(`${app}/`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New card", exact: true }).click();
  await page.getByLabel("Front", { exact: true }).fill(front);
  await page.getByLabel("Back", { exact: true }).fill(back);
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved on this device. It goes to Unfiled when you're back online.").waitFor().catch(async (e) => {
    const seen = await page.evaluate(() => ({ online: navigator.onLine, mark: !!document.querySelector(".connection-mark.off"),
      dialog: document.querySelector("dialog[open]")?.textContent?.slice(0, 400) ?? null }));
    throw new Error(`the new card's offline notice never showed: ${JSON.stringify(seen)}`, { cause: e });
  });
  check("a new card saves offline, as typed", true);
  await page.keyboard.press("Escape");

  // a link, saved for later, from Projects where the unfiled sit
  await page.goto(`${app}/?view=projects`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Link to save" }).fill(link);
  await page.getByRole("button", { name: "Save link", exact: true }).click();
  await until(() => page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("strata.links."))), { what: "the link to wait on the device" });
  check("a pasted link waits for the connection", captures.length === 0);

  const owed = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("strata.outbox.") || k.startsWith("strata.links.")).length);
  check("everything written in the air is kept on the device: the edit, the new card and the link", owed === 3, `${owed} kept`);

  await context.setOffline(false);
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); window.dispatchEvent(new Event("focus")); });
  await until(() => page.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith("strata.outbox.") || k.startsWith("strata.links."))),
    { what: "the device to owe the server nothing", timeout: 60000 });

  const library = await api("/api/library");
  check("the card written offline is in Unfiled exactly once", library.cards.filter((c) => c.front === front).length === 1);
  const read = await api(`/api/decks/${deck}`);
  const cards = read.cards || read.deck?.cards || [];
  const mine = cards.find((c) => String(c.front ?? "").trim().startsWith(cardFront.slice(0, 20)));
  check("the card edited offline holds the new back", mine?.back === edited, mine ? `back is ${JSON.stringify(mine.back)}` : `no card in ${deck} starts like ${JSON.stringify(cardFront.slice(0, 40))}`);
  check("the link is captured once, under the key it waited with", captures.length === 1);
  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\noffline loop: ${checks.length} checks hold`);
} finally { await browser.close(); }
