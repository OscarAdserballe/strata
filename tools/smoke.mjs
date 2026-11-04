#!/usr/bin/env node
// The e2e smoke: drive the whole room once against a running preview (./preview.sh, then npm run smoke).

const APP = process.argv[2] || "http://127.0.0.1:8804";

const { chromium } = await import("playwright");
const { afterRequests, atRest } = await import("./settled.mjs");

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };

// found by title so reseeding never breaks the smoke
const boards = await (await fetch(`${APP}/api/boards`)).json();
const book = boards.boards.find((b) => b.title === "The Discipline of Repetition");
if (!book) { console.error("✗ the seeded book board is missing — run ./preview.sh first"); process.exit(1); }

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const fetched = [];
  page.on("request", (r) => fetched.push(r.url()));

  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForSelector("#root *", { timeout: 10000 });
  check("the app mounts", true);
  const cdn = (await page.evaluate(() => performance.getEntriesByType("resource").map((r) => r.name)))
    .filter((u) => !u.startsWith(APP) && /^https?:/.test(u));
  check("zero CDN requests", cdn.length === 0, cdn[0]);

  const post = async (path, body) => {
    const response = await fetch(APP + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  };
  const inbox = await post("/api/register/inbox", {});
  const source = await post(`/api/boards/${inbox.id}/resources`, { filename: "filing-smoke.md", text: "# Filing smoke\nA disposable note for testing the board picker." });
  await post(`/api/boards/${inbox.id}/pairs`, { resourceId: source.id, label: "filing-smoke.md" });
  await page.reload({ waitUntil: "networkidle" });
  const allBoards = page.getByRole("button", { name: /^All boards / });
  await allBoards.click();
  await page.getByRole("region", { name: "All boards", exact: true }).getByRole("button", { name: book.title, exact: true }).waitFor();
  await allBoards.click();
  const row = page.locator(".rg-row").filter({ has: page.getByRole("link", { name: "filing-smoke.md", exact: true }) });
  await row.getByRole("button", { name: "File to board", exact: true }).click();
  let picker = page.getByRole("dialog", { name: "File to a board" });
  await picker.getByRole("searchbox", { name: "Find a board" }).press("Escape");
  await picker.waitFor({ state: "hidden" });
  await row.getByRole("button", { name: "File to board", exact: true }).click();
  picker = page.getByRole("dialog", { name: "File to a board" });
  await picker.getByRole("searchbox", { name: "Find a board" }).fill(book.title);
  await picker.getByRole("button", { name: book.title, exact: true }).click();
  await row.getByRole("link", { name: book.title, exact: true }).waitFor();
  const register = await (await fetch(`${APP}/api/register`)).json();
  check("filing can be cancelled, searched, and saved", register.entries.some((e) => e.resourceId === source.id && e.boardId === book.id && !e.unfiled));
  const removed = await fetch(`${APP}/api/boards/${book.id}/resources/${source.id}?pairs=1`, { method: "DELETE" });
  if (!removed.ok) throw new Error(`Filing fixture cleanup failed: ${removed.status}`);

  await page.goto(`${APP}/?board=${book.id}`, { waitUntil: "networkidle" });
  await page.waitForSelector("#root *", { timeout: 10000 });
  // a fresh seed lands on home, a resumed board on the reader: take whichever door is open
  let canvas = await page.waitForSelector("canvas", { timeout: 4000 }).catch(() => null);
  if (!canvas) {
    await page.locator('.bp-rail [title*="step inside"]').first().click();
    await page.getByRole("button", { name: /^Open the book/ }).click();
    await page.locator('button[title^="One:"], button:has-text("One:")').first().click();
    canvas = await page.waitForSelector("canvas", { timeout: 15000 });
  }
  // any canvas with ink: an all-white sheet is the silent pdf.js failure this catches
  const painted = await page.waitForFunction(() => {
    for (const c of document.querySelectorAll("canvas")) {
      const g = c.getContext("2d"); if (!g || !c.width) continue;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 397 * 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) return true;
    }
    return false;
  }, null, { timeout: 15000 }).then(() => true, () => false);
  check("a pdf page paints real pixels", painted);

  const bands = await page.waitForFunction(() => document.querySelectorAll(".clm-row").length > 0,
    null, { timeout: 10000 }).then(() => true, () => false);
  // count both tree levels: each anchors differently, and either can silently resolve to nothing
  const levels = await page.evaluate(() => ({
    roots: document.querySelectorAll(".clm-row.d0").length,
    under: document.querySelectorAll(".clm-row.d1").length,
  }));
  check("the chapter's claims stand in the source, both levels", bands && levels.roots > 0 && levels.under > 0,
    `${levels.roots} root · ${levels.under} under`);

  await page.evaluate(() => { document.querySelector(".page").scrollTop = 2600; });
  await atRest(page);
  const was = await page.evaluate(() => document.querySelector(".page").scrollTop);
  await page.keyboard.press("t");
  await page.waitForSelector(".treeview", { timeout: 5000 });
  await page.keyboard.press("t");
  // wait for the reader to rest, then look once: a wait for the place would miss a later re-landing
  await page.waitForSelector(".treeview", { state: "detached", timeout: 5000 });
  await atRest(page);
  const now = await page.evaluate(() => document.querySelector(".page").scrollTop);
  check("t keeps your place in the book", was > 100 && Math.abs(now - was) < 40, `${Math.round(was)} → ${Math.round(now)}`);

  // every open card draws its face once its page draws: walk the book until the one in hand shows
  const handQ = async () => {
    for (let i = 0; i < 120; i++) {
      const t = await page.evaluate(() => document.querySelector(".fi-face[data-hand] .q")?.textContent || null);
      if (t !== null) return t;
      await page.evaluate((i) => { const p = document.querySelector(".page"); p.scrollTop = i ? p.scrollTop + p.clientHeight * 0.8 : 0; }, i);
      await page.waitForTimeout(250);
    }
    throw new Error("the card in hand never drew its face");
  };
  const q = await handQ();
  await page.keyboard.press("n");
  await page.waitForFunction((q) => document.querySelector(".fi-face[data-hand] .q")?.textContent !== q, q, { timeout: 5000 }).catch(() => {});
  const q2 = await handQ();
  check("n moves to the next card", q2 !== q, q2 === q ? "card did not change" : undefined);
  // space never walks past a card: on an MCQ it does nothing, so space then 1 answers the same card
  const mcq = await page.evaluate(() => !!document.querySelector(".fi-face[data-hand] .q ~ .opts .opt"));
  const backShown = await page.evaluate(() => !!document.querySelector(".fi-face[data-hand] .q ~ .a"));
  await page.keyboard.press(" ");
  if (mcq) await page.keyboard.press("1");
  const acted = !backShown && await page.waitForFunction(() => !!document.querySelector(".fi-face[data-hand] .q ~ .a, .fi-face[data-hand] .q ~ .opts .opt.correct"),
    null, { timeout: 5000 }).then(() => true, () => false);
  const stayed = (await page.textContent(".fi-face[data-hand] .q")) === q2;
  check("space acts on the card", acted && stayed,
    backShown ? "the card arrived already turned over"
      : !acted ? (mcq ? "1 did not answer the mcq" : "space did not turn the card over")
      : !stayed ? "space walked past the card" : mcq ? "an mcq: space held it, 1 answered it" : undefined);

  await page.keyboard.press("e");
  const form = await page.waitForSelector(".ced textarea", { timeout: 3000 }).then(() => true, () => false);
  const mine = "smoke: my own wording";
  if (form) {
    await page.fill(".ced textarea", mine);
    await page.click(".ced-go");
    await afterRequests(page, () => page.getByRole("button", { name: "Confirm save", exact: true }).click()).catch(() => {});
    await page.waitForFunction((mine) => !document.querySelector(".ced")
      && document.querySelector(".fi-face[data-hand] .q")?.textContent.trim() === mine, mine, { timeout: 5000 }).catch(() => {});
  }
  // the editor still up means the save was refused: report why rather than time out
  const stuck = form ? await page.$(".ced") : null;
  const front = form && !stuck ? (await page.textContent(".fi-face[data-hand] .q")).trim() : "";
  check("e rewrites the card in place, and it holds", front === mine,
    !form ? "the editor never opened" : stuck ? `not saved: ${(await page.textContent(".ced-row")).trim()}` : front.slice(0, 40));

  await page.keyboard.press("?");
  await page.waitForSelector(".keys-sheet", { timeout: 3000 });
  const sheet = await page.textContent(".keys-sheet");
  // the probe string is the sheet's own first line, so a reworded sheet cannot leave this check stale
  check("? opens the sheet, from the registered layouts", /the grade is what moves you on/.test(sheet) && !/\{pz\}/.test(sheet));
  await page.keyboard.press("Escape");

  // a question is asked under words of the page, in the fold that opens under them
  // words on the page: the book may rest on a blank stretch, so a run of them is brought into view first
  await page.evaluate(() => [...document.querySelectorAll(".tlayer [data-i]")]
    .find((e) => e.textContent.length >= 16 && e.getBoundingClientRect().width > 80)?.scrollIntoView({ block: "center" }));
  await atRest(page);
  const run = await page.evaluate(() => {
    const R = document.querySelector(".page").getBoundingClientRect();
    const el = [...document.querySelectorAll(".tlayer [data-i]")].find((e) => {
      const r = e.getBoundingClientRect();
      return e.textContent.length >= 16 && r.width > 80 && r.top > R.top + 80 && r.bottom < R.bottom - 160;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x0: r.left + 2, x1: r.left + r.width * 0.8, y: r.top + r.height / 2 };
  });
  if (run) {
    await page.mouse.move(run.x0, run.y); await page.mouse.down();
    await page.mouse.move(run.x1, run.y, { steps: 8 }); await page.mouse.up();
  }
  const asked = run && await page.locator(".selmenu").getByRole("button", { name: "Ask", exact: true }).click({ timeout: 3000 }).then(() => true, () => false);
  const line = page.locator(".fold .fi.asked .fi-q");
  check("Ask on picked words opens a fold under them", !!asked && await line.waitFor({ timeout: 5000 }).then(() => true, () => false));
  const answers = () => page.locator(".fold .fi.asked .fi-turn.claude:not(.writing)");
  const turnsNow = () => page.$$eval(".fold .fi.asked .fi-turn", (ts) => ts.map((t) => t.querySelector(".fi-say").innerText));
  await line.fill("why does repetition discipline pricing?");
  await line.press("Enter");
  const turned = await page.waitForFunction(() => [...document.querySelectorAll(".fold .fi.asked .fi-turn.claude:not(.writing)")]
    .some((el) => el.innerText.includes("the short version")), null, { timeout: 15000 }).then(() => true, () => false);
  check("a chat turn streams in", turned);

  await line.fill("and what does detection lag do?");
  await line.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".fold .fi.asked .fi-turn.claude:not(.writing)").length === 2,
    null, { timeout: 15000 }).catch(() => {});
  const said = await turnsNow();
  check("the reply's maths is drawn, not shown as TeX", await page.evaluate(() => {
    const replies = [...document.querySelectorAll(".fold .fi.asked .fi-turn.claude .fi-say")];
    return replies.length > 0 && replies.every((r) => r.querySelector(".katex") && !r.querySelector(".katex-error")
      && !/\$|\\[a-z]+/i.test([...r.childNodes].map(function text(n) {
        return n.nodeType === 3 ? n.data : n.matches?.(".katex, code, pre") ? "" : [...n.childNodes].map(text).join("");
      }).join("")));
  }));
  await answers().last().hover();
  await answers().last().locator(".fi-mk").click();
  await page.fill(".comp-ta.back", "patience is what makes the threat credible");
  await page.getByRole("button", { name: "Format & Preview" }).click();
  await page.getByRole("button", { name: "Confirm save" }).click();
  await page.waitForSelector(".comp", { state: "detached", timeout: 10000 });
  const kept = await turnsNow();
  check("making a card keeps every turn of the thread", said.length === 4 && JSON.stringify(kept) === JSON.stringify(said),
    `${said.length} turns before, ${kept.length} after`);
  check("the reader has no dock: a source is asked under its words", await page.locator(".askwrap").count() === 0);

  // the dock is the board's: asked from the board's page
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  await page.locator(".rbar-board").click();
  await page.locator('input[placeholder="ask about this board…"]').waitFor({ timeout: 10000 });
  await page.keyboard.press("/");
  await page.fill('input[placeholder="ask about this board…"]', "what is this board about?");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".ask .turn.it") && !document.querySelector(".ask input").disabled,
    null, { timeout: 15000 });

  const dock = page.locator(".ask");
  const withinRoom = () => page.evaluate(() => {
    const box = document.querySelector(".ask").getBoundingClientRect();
    const room = document.querySelector(".panes").getBoundingClientRect();
    return box.left >= room.left && box.top >= room.top && box.right <= room.right && box.bottom <= room.bottom;
  });
  const dragChat = async (selector, dx, dy) => {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 12 });
    await page.mouse.up();
  };
  const beforeMove = await dock.boundingBox();
  await dragChat(".ask .thead", -200, -80);
  const afterMove = await dock.boundingBox();
  check("chat header follows the pointer", Math.abs(afterMove.x - beforeMove.x + 200) < 2
    && Math.abs(afterMove.y - beforeMove.y + 80) < 2);
  const savedPosition = await dock.evaluate((el) => el.style.transform);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('.ask button[title="show the thread"]').click();
  check("chat position survives reload", await dock.evaluate((el) => el.style.transform) === savedPosition);
  const roomZoom = await page.evaluate(() => document.querySelector(".app").style.zoom);
  await page.keyboard.press("-");
  await page.waitForFunction((z) => document.querySelector(".app").style.zoom !== z, roomZoom, { timeout: 5000 });
  const beforeZoomDrag = await dock.boundingBox();
  await dragChat(".ask .thead", 30, 20);
  const afterZoomDrag = await dock.boundingBox();
  check("chat movement respects room zoom", Math.abs(afterZoomDrag.x - beforeZoomDrag.x - 30) < 2
    && Math.abs(afterZoomDrag.y - beforeZoomDrag.y - 20) < 2,
    `${afterZoomDrag.x - beforeZoomDrag.x}, ${afterZoomDrag.y - beforeZoomDrag.y}`);
  await dragChat(".ask .thead", -2000, -2000);
  check("chat cannot be dragged out of the reading area", await withinRoom());
  await page.setViewportSize({ width: 800, height: 600 });
  // the dock is re-fitted on resize: wait for it to settle, then check where it rests
  await page.waitForFunction(() => window.innerWidth === 800, null, { timeout: 5000 });
  await atRest(page, ".ask");
  check("chat stays reachable in a smaller window", await withinRoom());
  const beforeResize = await page.locator(".ask .turns").boundingBox();
  await dragChat(".ask .tgrip", 0, 100);
  const afterResize = await page.locator(".ask .turns").boundingBox();
  check("floating chat still resizes", afterResize.height < beforeResize.height && await withinRoom());
  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  const collapsed = await dock.boundingBox();
  await page.getByRole("button", { name: "Move chat", exact: true }).press("ArrowRight");
  const nudged = await dock.boundingBox();
  check("collapsed chat can move with the keyboard", Math.abs(nudged.x - collapsed.x - 10) < 2);
  await page.getByRole("button", { name: "Reset chat position", exact: true }).click();
  check("reset restores the bottom dock", await page.locator(".askwrap.moved").count() === 0
    && await page.evaluate(() => localStorage.getItem("strata.chat.position")) === null);

  // the keeps and cram chunks: every door must start its chunk before the act that opens it
  const keepsChunk = (u) => /\/chunks\/KeepsSurface-[A-Z0-9]+\.js$/i.test(u);
  const cramChunk = (u) => /\/chunks\/CramSurface-[A-Z0-9]+\.js$/i.test(u);
  const freshDoor = async (url, memory, { idle = false } = {}) => {
    const c = await browser.newContext();
    if (memory) await c.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* no storage */ } }, memory);
    // the room's idle warm is held off, so only a door's own warm can fetch the chunk
    if (!idle) await c.addInitScript(() => { window.requestIdleCallback = () => 0; });
    const p = await c.newPage();
    const asked = [], landed = [];
    p.on("request", (r) => asked.push(r.url()));
    p.on("requestfinished", (r) => landed.push(r.url()));
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(url, { waitUntil: "networkidle" });
    return { c, p, asked, landed };
  };
  const askedFor = (p, chunk) => p.waitForRequest((r) => chunk(r.url()), { timeout: 5000 }).then(() => true, () => false);
  const drawn = (p, sel) => p.waitForSelector(sel, { timeout: 10000 }).then(() => true, () => false);
  // the door opens the first card via this device's memory, so the drill's own warm cannot fetch the chunk
  const oneState = await (await fetch(`${APP}/api/boards/${book.id}`)).json();
  const one = oneState.pairs.find((p) => p.deck && /One:/.test(p.label));
  const { byStage } = await import("../web/capabilities/card/drill-order.ts");
  const deckCards = ((await (await fetch(`${APP}/api/decks/${one.deck}`)).json()).cards || []).slice().sort(byStage);
  const standOn = (card) => [`strata.at.${book.id}`, JSON.stringify({ cards: { [one.deck]: card.id } })];
  {
    const { c, p: doors, asked } = await freshDoor(`${APP}/?board=${book.id}`);
    const cramButton = doors.getByRole("button", { name: "Cram", exact: true });
    await cramButton.waitFor({ timeout: 10000 });
    check("opening a board fetches neither the keeps nor the cram on its way to the page", asked.length > 0 && !asked.some(keepsChunk) && !asked.some(cramChunk));
    const cramAsked = askedFor(doors, cramChunk);
    await cramButton.hover();
    const cramWarm = await cramAsked;
    await cramButton.click();
    check("a pointer over the Cram button fetches its chunk before the click, and the cram draws from it", cramWarm && await drawn(doors, ".cram-choose"));
    await c.close();
  }
  {
    const { c, p: doors, asked } = await freshDoor(`${APP}/?board=${book.id}`, standOn(deckCards[0]));
    await doors.locator(".bp-front .bp-btn.primary").click();
    await doors.locator('button[title^="One:"], button:has-text("One:")').first().click();
    const station = doors.locator(".jn-rev");
    await station.waitFor({ timeout: 15000 });
    const keepsEarly = asked.some(keepsChunk);
    const keepsAsked = askedFor(doors, keepsChunk);
    await station.hover();
    const keepsWarm = await keepsAsked;
    await station.click();
    check("a pointer over the keeps' station fetches their chunk before the click, and the keeps draw from it", !keepsEarly && keepsWarm && await drawn(doors, ".bench"));
    await c.close();
  }
  {
    const { c, p: doors, asked } = await freshDoor(`${APP}/?board=${book.id}`);
    await doors.locator(".bp-front").getByRole("button", { name: "Details", exact: true }).click();
    const keep = doors.locator(".bp-cover").getByRole("button", { name: "Choose what to keep", exact: true });
    await keep.waitFor({ timeout: 10000 });
    const keepsEarly = asked.some(keepsChunk);
    const keepsAsked = askedFor(doors, keepsChunk);
    await keep.hover();
    const keepsWarm = await keepsAsked;
    await keep.click();
    check("a pointer over the cover sheet's 'Choose what to keep' fetches the keeps' chunk before the click, and the keeps draw", !keepsEarly && keepsWarm && await drawn(doors, ".bench"));
    await c.close();
  }
  {
    const { c, p: doors, asked } = await freshDoor(`${APP}/?board=${book.id}`);
    await doors.locator(".bp-front .bp-btn.primary").click();
    const chapter = doors.locator(".dk-row").filter({ hasText: "One:" });
    await chapter.locator(".tl-more").waitFor({ timeout: 10000 });
    const keepsEarly = asked.some(keepsChunk);
    const keepsAsked = askedFor(doors, keepsChunk);
    await chapter.locator(".tl-more").click();
    const keepsWarm = await keepsAsked;
    await chapter.getByRole("button", { name: "choose what to keep", exact: true }).click();
    check("opening a chapter's ⋯ fetches the keeps' chunk before its 'choose what to keep' is clicked, and the keeps draw", !keepsEarly && keepsWarm && await drawn(doors, ".bench"));
    await c.close();
  }
  {
    // a deck on its last card: n raises the keeps, so their chunk must be requested before n
    const { c, p: doors, asked } = await freshDoor(`${APP}/?board=${book.id}&resource=${one.resourceId}&pair=${one.id}`,
      standOn(deckCards[deckCards.length - 1]));
    await doors.locator(".jn-rev").waitFor({ timeout: 15000 });
    const keepsWarm = asked.some(keepsChunk) || await askedFor(doors, keepsChunk);
    await doors.keyboard.press("n");
    check("a real deck stood on its last card has fetched the keeps' chunk before the n that drains it, and the keeps draw", deckCards.length > 2 && keepsWarm && await drawn(doors, ".bench"));
    await c.close();
  }
  {
    const { c, p: doors, asked } = await freshDoor(`${APP}/?board=${book.id}`);
    await doors.getByRole("button", { name: "Cram", exact: true }).waitFor({ timeout: 10000 });
    const early = asked.some(keepsChunk) || asked.some(cramChunk);
    const both = Promise.all([askedFor(doors, keepsChunk), askedFor(doors, cramChunk)]);
    await doors.keyboard.press("j");
    const [keepsWarm, cramWarm] = await both;
    await doors.keyboard.press("x");
    check("the room's first key fetches the keeps' and the cram's chunks before r or x is pressed, and x draws the cram", !early && keepsWarm && cramWarm && await drawn(doors, ".cram-choose"));
    await c.close();
  }
  {
    const { c, p: doors, asked } = await freshDoor(`${APP}/?board=${book.id}`, null, { idle: true });
    await doors.getByRole("button", { name: "Cram", exact: true }).waitFor({ timeout: 10000 });
    const keepsWarm = asked.some(keepsChunk) || await askedFor(doors, keepsChunk);
    const cramWarm = asked.some(cramChunk) || await askedFor(doors, cramChunk);
    check("a board's wire going quiet fetches the keeps' and the cram's chunks, with no pointer or key before it", keepsWarm && cramWarm);
    await c.close();
  }
  // a key that opens a screen cannot start its own chunk in time, so the quiet wire must have fetched it
  for (const [key, chunk, sel, said] of [
    ["r", keepsChunk, ".bench", "the keeps' chunk already fetched, and the keeps draw"],
    ["x", cramChunk, ".cram-choose", "the cram's chunk already fetched, and the cram draws"]]) {
    const { c, p: lib, asked, landed } = await freshDoor(`${APP}/`, null, { idle: true });
    await lib.getByRole("button", { name: /^All boards / }).click();
    const row = lib.getByRole("region", { name: "All boards", exact: true }).getByRole("button", { name: book.title, exact: true });
    await row.waitFor({ timeout: 10000 });
    const rowAt = await lib.evaluate(() => performance.now());
    await row.click();
    await lib.getByRole("button", { name: "Cram", exact: true }).waitFor({ timeout: 10000 });
    const drawnAt = await lib.evaluate(() => performance.now());
    const onTheWay = (await lib.evaluate(() => performance.getEntriesByType("resource")
      .filter((e) => /\/chunks\/(Keeps|Cram)Surface-/.test(e.name)).map((e) => e.startTime)))
      .some((s) => s > rowAt && s < drawnAt);
    const here = landed.some(chunk)
      || await lib.waitForEvent("requestfinished", { predicate: (r) => chunk(r.url()), timeout: 5000 }).then(() => true, () => false);
    await lib.keyboard.press(key);
    check(`on a board reached by clicks from the library, no chunk fetch starts between the click on its row and its page drawing, and once its wire is quiet ${key} pressed first finds ${said}`,
      !onTheWay && here && await drawn(lib, sel));
    await c.close();
  }
  {
    // the library's first pointerdown warms both chunks once the wire is quiet
    const { c, p: lib } = await freshDoor(`${APP}/`, null, { idle: true });
    const both = Promise.all([keepsChunk, cramChunk].map((chunk) =>
      lib.waitForEvent("requestfinished", { predicate: (r) => chunk(r.url()), timeout: 8000 }).then(() => true, () => false)));
    await lib.getByRole("button", { name: /^All boards / }).click();
    const fetched = (await both).every(Boolean);
    await lib.keyboard.press("r");
    check("on the library, a click that opens no board fetches the keeps' and the cram's chunks once the wire is quiet, and r pressed first then draws the keeps from it",
      fetched && await drawn(lib, ".bench-lib"));
    await c.close();
  }
  {
    // Continue must not start either chunk before its page inks: they compete for the board's connections
    await fetch(`${APP}/api/log`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "smoke_touch", props: { board: book.id } }) });
    const { c, p: home } = await freshDoor(`${APP}/`, [`strata.at.${book.id}`, JSON.stringify({ pairId: one.id })], { idle: true });
    const go = home.locator(".home-doors").getByRole("button", { name: /Continue board/ });
    await go.waitFor({ timeout: 10000 });
    const fronted = (await home.locator(".home-doors h1").textContent())?.trim();
    await home.evaluate(() => {
      const look = () => {
        for (const cv of document.querySelectorAll(".slide canvas")) {
          const g = cv.getContext("2d"); if (!g || !cv.width) continue;
          const d = g.getImageData(0, 0, cv.width, cv.height).data;
          for (let i = 0; i < d.length; i += 397 * 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) { window.__inkAt = performance.now(); return; }
        }
        requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    });
    const both = Promise.all([keepsChunk, cramChunk].map((chunk) =>
      home.waitForEvent("requestfinished", { predicate: (r) => chunk(r.url()), timeout: 20000 }).then(() => true, () => false)));
    await go.click();
    const inked = await home.waitForFunction(() => window.__inkAt != null, null, { timeout: 15000 }).then(() => true, () => false);
    const fetchedBoth = (await both).every(Boolean);
    const { inkAt, starts } = await home.evaluate(() => ({ inkAt: window.__inkAt,
      starts: performance.getEntriesByType("resource").filter((e) => /\/chunks\/(Keeps|Cram)Surface-/.test(e.name)).map((e) => Math.round(e.startTime)) }));
    check("the continue journey starts neither chunk before its page inks, and its board's quiet wire fetches both after",
      fronted === book.title && inked && fetchedBoth && starts.length === 2 && starts.every((s) => s >= inkAt),
      `fronted ${fronted === book.title}, inked at ${Math.round(inkAt)} ms, chunks started at ${starts.join(", ")} ms`);
    await c.close();
  }

  check("no page errors", errors.length === 0, errors[0]);
} finally { await browser.close(); }

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
