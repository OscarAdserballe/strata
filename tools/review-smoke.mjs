import assert from "node:assert/strict";
import { chromium } from "playwright";

// hold save responses: advancing must depend on the verdict, not on a fast local server
const base = process.argv[2] || "http://127.0.0.1:8804";
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const card = id => ({ id, course: "review-fixture", courseTitle: "Review fixture", type: "flashcard",
  front: `Question ${id}`, back: `Answer ${id}`, rung: 0, dueAt: 1 });
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for review request");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(cards, touch = false) {
  const context = await browser.newContext({ serviceWorkers: "block", hasTouch: touch,
    viewport: { width: touch ? 390 : 1440, height: 1000 } });
  const page = await context.newPage();
  // generous ceilings: a starved machine can take over 10 s to load the page
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  await page.addInitScript(() => { Math.random = () => 0.999; }); // Keep the shuffled fixture order stable.
  const attempts = [], receipts = new Map(), errors = [];
  const wire = { cut: false };
  // registered first, so it runs last: while the wire is cut nothing on /api answers
  await page.route(`${base}/api/**`, route => wire.cut ? route.abort("internetdisconnected") : route.fallback());
  let loads = 0, maps = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`${base}/api/review`, route => {
    loads++;
    return route.fulfill({ json: { cards: loads === 1 ? cards : [], total: loads === 1 ? cards.length : 0, nextDueAt: null, unkeptDue: 0 } });
  });
  await page.route(`${base}/api/review/tree?*`, route => wire.cut ? route.fallback() : route.fulfill({ json: { tree: null } }));
  await page.route(`${base}/api/review/history?*`, route => wire.cut ? route.fallback() : route.fulfill({ json: { reviews: [] } }));
  await page.route(`${base}/api/log`, route => wire.cut ? route.fallback() : route.fulfill({ json: {} }));
  await page.route(`${base}/api/review/session?*`, route => {
    if (wire.cut) return route.fallback();
    maps++;
    return route.fulfill({ json: { cards: new Set([...receipts.values()].map(r => r.card)).size,
      got: 1, missed: 0, sittings: 1, minutes: 1, dueLeft: 0, topics: [] } });
  });
  await page.route(`${base}/api/review/grade`, async route => {
    if (wire.cut) return route.fallback();
    const body = route.request().postDataJSON();
    const response = Promise.withResolvers();
    attempts.push({ body, reply: (status = 200) => response.resolve(status) });
    const status = await response.promise;
    // a committed grade whose acknowledgment was lost: retrying the same receipt succeeds once
    receipts.set(body.requestId, body);
    await route.fulfill({ status, json: status === 200 ? { saved: true, at: Date.now() } : { error: "Temporary save failure" } });
  });
  await page.goto(`${base}/?view=review`, { waitUntil: "domcontentloaded" });
  const review = page.locator(".reviewv");
  // a desk opens on the overview; the phone goes straight to the cards
  if (!touch) await review.getByRole("button", { name: /^Start/ }).click();
  await review.locator(".q").waitFor();
  return { page, review, attempts, receipts, wire, get loads() { return loads; }, get maps() { return maps; },
    async attempt(n) { await until(() => attempts.length >= n); return attempts[n - 1]; },
    async close() {
      for (const attempt of attempts) attempt.reply();
      await context.close();
      assert.deepEqual(errors, []);
    } };
}

try {
  const f = await fixture([card("a"), card("b"), { ...card("mcq"), type: "mcq", stem: "Question mcq",
    options: ["First", "Second"], correct: 0, explanation: "Answer mcq" }]);
  try {
    await f.page.keyboard.press("Space");
    await f.page.keyboard.press("1");
    await f.review.locator(".q").filter({ hasText: "Question b" }).waitFor();
    await f.attempt(1);
    assert.equal(await f.review.getByText("Saving review…", { exact: true }).count(), 0);
    await f.review.getByRole("button", { name: /reveal/ }).click();
    await f.review.getByRole("button", { name: /got it/ }).click();
    await f.review.locator(".q").filter({ hasText: "Question mcq" }).waitFor();
    await f.page.keyboard.press("1"); // Pick, then miss: an MCQ must leave on either verdict.
    await f.page.keyboard.press("1");
    await f.review.locator(".q").filter({ hasText: "Question a" }).waitFor();
    assert.equal(await f.review.locator(".a").count(), 0, "the missed card returns unrevealed");
    await f.page.keyboard.press("Space");
    await f.page.evaluate(() => {
      for (let i = 0; i < 2; i++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    await f.review.getByRole("status").filter({ hasText: "Finishing review" }).waitFor();
    assert.equal(f.attempts.length, 1, "grades advance while the first response is still held");
    assert.equal(f.loads, 1, "the batch cannot reload stale due cards");
    assert.equal(f.maps, 0, "the map cannot omit pending grades");
    const expected = [["a", false], ["b", true], ["mcq", false], ["a", true]];
    for (let i = 0; i < expected.length; i++) {
      const attempt = await f.attempt(i + 1);
      assert.deepEqual([attempt.body.card, attempt.body.got], expected[i]);
      attempt.reply();
    }
    await f.review.locator(".smcount").filter({ hasText: "3" }).waitFor();
    assert.equal(f.attempts.length, 4, "a repeated event before render cannot duplicate a grade");
    assert.equal(f.loads, 2);
    assert.equal(f.maps, 1);
    console.log("✓ keyboard and click grading advance before saves; misses requeue, MCQs leave, duplicate events are ignored, and the summary waits");
  } finally { await f.close(); }

  const failed = await fixture([card("retry")]);
  try {
    await failed.page.keyboard.press("Space");
    await failed.page.keyboard.press("2");
    (await failed.attempt(1)).reply(503);
    await failed.review.getByRole("alert").waitFor();
    assert.equal(failed.loads, 1);
    assert.equal(failed.maps, 0);
    await failed.page.keyboard.press("Escape");
    assert.ok(await failed.review.isVisible(), "a failed final save cannot silently leave the session");
    await failed.review.getByRole("button", { name: "Retry saving reviews" }).click();
    const retry = await failed.attempt(2);
    assert.deepEqual(retry.body, failed.attempts[0].body);
    retry.reply();
    await failed.review.locator(".smcount").filter({ hasText: "1" }).waitFor();
    assert.equal(failed.receipts.size, 1);
    console.log("✓ a failed final save stays recoverable and retries the original receipt without duplicating the review");
  } finally { await failed.close(); }

  const ended = await fixture([card("first"), card("remaining")]);
  try {
    await ended.page.keyboard.press("Space");
    await ended.page.keyboard.press("2");
    await ended.review.locator(".q").filter({ hasText: "Question remaining" }).waitFor();
    await ended.review.getByRole("button", { name: "end here — see the day" }).click();
    await ended.review.getByRole("status").filter({ hasText: "Finishing review" }).waitFor();
    await ended.page.keyboard.press("Escape");
    assert.equal(ended.maps, 0);
    assert.ok(await ended.review.isVisible());
    (await ended.attempt(1)).reply();
    await ended.review.locator(".smleft").filter({ hasText: "1 left in this sitting" }).waitFor();
    console.log("✓ ending a session waits for its pending grades before loading the day's map");
  } finally { await ended.close(); }

  const flight = await fixture([card("up"), card("down"), card("left")]);
  try {
    flight.wire.cut = true;
    await flight.page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await flight.page.locator(".connection-banner").getByText("Offline", { exact: true }).waitFor({ timeout: 30000 });
    await flight.page.keyboard.press("Space");
    await flight.page.keyboard.press("2");
    await flight.review.locator(".q").filter({ hasText: "Question down" }).waitFor();
    await flight.page.keyboard.press("Space");
    await flight.page.keyboard.press("1");
    await flight.review.locator(".q").filter({ hasText: "Question left" }).waitFor();
    assert.equal(await flight.review.getByRole("alert").count(), 0, "offline grading raises no save alert");
    await flight.page.locator(".connection-banner").getByText(/2 changes waiting, sent when you’re back/).waitFor();
    const shelved = await flight.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("strata.outbox.grade.")).length);
    assert.equal(shelved, 2, "both offline grades are kept on the device");
    assert.equal(flight.attempts.length, 0);
    flight.wire.cut = false;
    await flight.page.evaluate(() => window.dispatchEvent(new Event("online")));
    const first = await flight.attempt(1);
    first.reply();
    const second = await flight.attempt(2);
    second.reply();
    assert.deepEqual([first.body.card, first.body.got, second.body.card, second.body.got], ["up", true, "down", false]);
    assert.notEqual(first.body.requestId, second.body.requestId);
    await flight.page.waitForFunction(() => !Object.keys(localStorage).some(k => k.startsWith("strata.outbox.grade.")));
    console.log("✓ offline, grading carries on, the grades wait on the device, and they sync once, in order, on reconnect");
  } finally { await flight.close(); }

  const asked = await fixture([card("review-fixture/flashcard/ask")]);
  try {
    await asked.page.keyboard.press("Space");
    await asked.review.locator(".a").waitFor();
    await asked.page.keyboard.press("/");
    assert.equal(await asked.page.locator(".ask").count(), 0, "the review mounts no Ask");
    assert.ok(await asked.review.isVisible(), "/ does nothing to the sitting");
    console.log("✓ the review has no Ask: / after the reveal opens nothing");
  } finally { await asked.close(); }

  const phone = await fixture([card("tap"), card("next")], true);
  try {
    await phone.review.locator(".q").tap();
    await phone.review.getByRole("button", { name: "got it", exact: true }).tap();
    await phone.review.locator(".q").filter({ hasText: "Question next" }).waitFor();
    assert.equal(await phone.review.locator(".a").count(), 0, "the grade tap must not reveal the next card");
    (await phone.attempt(1)).reply(503);
    await phone.review.getByRole("alert").waitFor();
    await phone.review.locator(".q").tap();
    await phone.page.keyboard.press("2");
    assert.equal(await phone.review.locator(".q").innerText(), "Question next", "a failed save pauses further grading");
    await phone.review.getByRole("button", { name: "Retry saving reviews" }).tap();
    (await phone.attempt(2)).reply();
    await phone.review.getByRole("alert").waitFor({ state: "hidden" });
    assert.equal(await phone.review.locator(".a").innerText(), "Answer next", "retrying an earlier save must not reset the current card");
    await phone.review.getByRole("button", { name: "got it", exact: true }).tap();
    (await phone.attempt(3)).reply();
    await phone.review.locator(".smcount").filter({ hasText: "2" }).waitFor();
    console.log("✓ touch grading leaves the next card concealed; retrying an earlier failure preserves the current card and answer");
  } finally { await phone.close(); }
} finally { await browser.close(); }
