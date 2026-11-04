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
  let loads = 0, maps = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`${base}/api/review`, route => {
    loads++;
    return route.fulfill({ json: { cards: loads === 1 ? cards : [], total: loads === 1 ? cards.length : 0, nextDueAt: null, unkeptDue: 0 } });
  });
  await page.route(`${base}/api/review/tree?*`, route => route.fulfill({ json: { tree: null } }));
  await page.route(`${base}/api/review/history?*`, route => route.fulfill({ json: { reviews: [] } }));
  await page.route(`${base}/api/log`, route => route.fulfill({ json: {} }));
  await page.route(`${base}/api/review/session?*`, route => {
    maps++;
    return route.fulfill({ json: { cards: new Set([...receipts.values()].map(r => r.card)).size,
      got: 1, missed: 0, sittings: 1, minutes: 1, dueLeft: 0, topics: [] } });
  });
  await page.route(`${base}/api/review/grade`, async route => {
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
  await review.locator(".q").waitFor();
  return { page, review, attempts, receipts, get loads() { return loads; }, get maps() { return maps; },
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

  // the card's id is real-shaped (`<course>/<type>/<key>`): its thread key must split at the course
  const asked = await fixture([card("review-fixture/flashcard/ask")]);
  try {
    const turns = [];
    await asked.page.route(`${base}/api/review/chat`, (route) => {
      turns.push({ body: route.request().postDataJSON(), key: route.request().headers()["idempotency-key"] });
      return route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body:
        'event: start\ndata: {"userIdx":0,"replyIdx":1}\n\nevent: delta\ndata: {"t":"Because the card says so."}\n\n' +
        'event: done\ndata: {"userIdx":0,"replyIdx":1,"messages":[{"idx":0,"role":"user","text":"why?"},{"idx":1,"role":"assistant","text":"Because the card says so."}]}\n\n' });
    });
    const line = asked.page.locator(".ask .line input");
    assert.ok(await line.isDisabled(), "before the reveal the line is shut");
    await asked.page.keyboard.press("Space");
    await asked.review.locator(".a").waitFor();
    await asked.page.keyboard.press("/");
    await asked.page.waitForFunction(() => document.activeElement === document.querySelector(".ask .line input"));
    await line.fill("why?");
    await line.press("Enter");
    await asked.page.locator(".ask .turn.it .said").filter({ hasText: "Because the card says so." }).waitFor();
    assert.equal(turns.length, 1);
    assert.deepEqual([turns[0].body.card, turns[0].body.course, turns[0].body.message], ["review-fixture/flashcard/ask", "review-fixture", "why?"]);
    assert.ok(turns[0].key, "the turn goes under an Idempotency-Key");
    await asked.page.evaluate(() => { document.activeElement?.blur?.(); });
    assert.equal(await asked.page.locator(".ask.open").count(), 1, "the thread is open after the reply");
    await asked.page.keyboard.press("Escape");
    assert.equal(await asked.page.locator(".ask.open").count(), 0, "esc closes the open Ask");
    assert.ok(await asked.review.isVisible(), "…and does not end the sitting");
    await line.fill("a draft");
    await line.press("Escape");
    assert.equal(await line.inputValue(), "a draft", "esc closes the thread and keeps the draft");
    assert.ok(await asked.review.isVisible(), "esc in the line does not end the sitting");
    console.log("✓ the review's Ask: shut before the reveal, / opens it, the card's thread answers, esc closes it first and keeps the draft");
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
