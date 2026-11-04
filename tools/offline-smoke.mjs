import assert from "node:assert/strict";
import { chromium } from "playwright";
import { still, until } from "./settled.mjs";

const app = process.argv[2] || "http://127.0.0.1:8804";
const { boards } = await (await fetch(`${app}/api/boards`)).json();
const board = boards.find((b) => b.title === "The Discipline of Repetition");
assert.ok(board, "Run preview.sh first");
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${app}/?board=${board.id}`);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.waitForSelector('button[title*="keep this board readable offline"]');
  const cached = () => page.evaluate(async () => {
    const cache = await caches.open("strata-off-v2-api");
    return (await cache.keys()).map((r) => r.url);
  });
  assert.deepEqual(await cached(), [], "visiting a board must not download it implicitly");
  await page.locator('button[title*="keep this board readable offline"]').click();
  await page.getByText("downloaded for offline reading", { exact: true }).waitFor({ timeout: 60000 });
  const saved = await cached();
  assert.ok(saved.includes(`${app}/api/boards/${board.id}`));
  assert.ok(saved.some((url) => url.endsWith("/raw")));
  const shell = await page.evaluate(async () => (await (await caches.open("strata-off-v2-shell")).keys()).map(r=>r.url));
  assert.ok(shell.some(url=>/\/chunks\/pdf-/.test(url)), "Download includes unopened PDF runtime");
  assert.ok(shell.some(url=>/\/chunks\/katex-/.test(url)), "Download includes unopened math runtime");
  assert.ok(!saved.includes(`${app}/api/boards/${boards.find((b) => b.id !== board.id).id}`));
  console.log("✓ explicit download saves the chosen board and source, not other boards");

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".connection-banner").getByText(/saved copies from/).waitFor();
  assert.match(await page.locator(".connection-banner").innerText(), /changes can’t be saved/);
  await page.getByRole("button", { name: "boards", exact: true }).click();
  assert.ok(await page.locator(".connection-banner").isVisible(), "library must retain the offline notice");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  // measure only once the library's entrance animation has stopped moving the banner
  await page.locator(".connection-banner").waitFor();
  await still(page);
  const banner = await page.locator(".connection-banner").boundingBox();
  assert.ok(banner.x >= 0 && banner.width <= 390 && banner.height > 0);
  await page.getByRole("region", { name: "Downloaded for offline reading" }).getByRole("button", { name: board.title }).waitFor();
  if (process.env.STRATA_OFFLINE_SCREENSHOT) await page.screenshot({ path: process.env.STRATA_OFFLINE_SCREENSHOT });
  console.log("✓ saved room reopens offline with a dated read-only banner, including the mobile library");

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByRole("button", { name: "Refresh now" }).waitFor();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Refresh now" }).click();
  await page.waitForFunction(() => !document.querySelector(".connection-banner"));
  assert.deepEqual((await cached()).sort(), saved.sort(), "reconnecting must preserve downloads");

  // A short outage must pass without the banner; one longer than the grace must raise it and clear on return.
  const GRACE = 8000;
  for (let attempt = 1; ; attempt++) {
    await page.evaluate(() => {
      window.__bannerSeen = false;
      window.__offAt = Date.now();               // at or before the first refusal: the outage can only be longer
      window.__healedAt = null;
      window.addEventListener("strata:wire", () => { if (window.__awaitHeal) window.__healedAt ??= Date.now(); });
      new MutationObserver(() => { if (document.querySelector(".connection-banner")) window.__bannerSeen = true; })
        .observe(document.body, { childList: true, subtree: true });
    });
    let probesRefused = 0;
    const refused = (r) => { if (r.url().endsWith("/api/health")) probesRefused++; };
    page.on("requestfailed", refused);
    await context.route("**/api/health", (route) => route.abort("internetdisconnected"), { times: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await until(() => probesRefused >= 2, { what: "the wire to be doubted and re-asked while offline", timeout: 30_000 });
    page.off("requestfailed", refused);
    await page.evaluate(() => { window.__awaitHeal = true; });
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => window.__healedAt, null, { timeout: 30_000 });
    const { seen, outage } = await page.evaluate(() => ({ seen: window.__bannerSeen, outage: window.__healedAt - window.__offAt }));
    if (!seen) break;
    assert.ok(outage >= GRACE, `a ${outage} ms loss of the wire — inside the ${GRACE} ms grace — put up the offline banner`);
    assert.ok(attempt < 3, `the machine stretched every staged outage past the grace (the last to ${outage} ms)`);
    console.log(`  (a loaded machine stretched the outage to ${outage} ms, past the grace; staging it again)`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.querySelector(".connection-banner"), null, { timeout: 30_000 });
  }
  assert.equal(await page.locator(".connection-banner").count(), 0, "…and once the wire has answered, none is coming");
  console.log("✓ a moment's outage passes without the offline banner");

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const offline = page.locator(".connection-banner").getByText("Offline", { exact: true });
  await offline.waitFor({ timeout: 60_000 });   // ceilings, not waits: the grace (8 s) plus a probe, on a loaded machine
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await offline.waitFor({ state: "hidden", timeout: 30_000 });
  console.log("✓ an outage that lasts is still called, and clears when the wire returns");

  await page.waitForLoadState("networkidle");
  // A deployment changes every API response; a health-only mock races board polling.
  await context.route("**/api/**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "x-strata-build": "new-release" } });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForLoadState("networkidle");
  assert.equal(await page.locator(".connection-banner").count(), 0, "a new build shows no banner");
  await page.reload({ waitUntil: "networkidle" });
  assert.deepEqual((await cached()).sort(), saved.sort(), "reloading into a new build must preserve downloaded content");
  console.log("✓ a new build shows no banner, and reloading into it preserves downloaded content");
  await context.unrouteAll({ behavior: "wait" });
  await context.close();
} finally { await browser.close(); }
