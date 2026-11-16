// Race scenarios: { name, what, checks, run(t) }; each builds its own board and pins its race with net.hold.
import { createHash } from "node:crypto";
import { pick } from "./network.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// the fake model streams slowly here, so chat-switch's reply outlasts the trip away and back
export const ROOM_ENV = { STRATA_FAKE_STREAM_MS: "70", STRATA_ROUTINE_STUB: "1" };

// where the fix is a retry, a check waits up to this long for it rather than judging after a fixed beat
const GRACE_MS = 10_000;

async function board(t, title) {
  const { board: b } = await t.api("/api/boards", "POST", { title: `${title} · seed ${t.seed} · ${Date.now().toString(36)}` });
  t.later(() => t.api(`/api/boards/${b.id}`, "DELETE"));
  return b;
}
async function prose(t, boardId, filename, text) {
  const r = await t.api(`/api/boards/${boardId}/resources`, "POST", { filename, text, pair: true });
  const pair = r.state.pairs.find((p) => p.resourceId === r.id);
  if (!pair) throw new Error(`no pair was made for ${filename}`);
  return { rid: r.id, pair: pair.id, filename, label: pair.label };
}
async function deck(t, boardId, rid, fronts) {
  const r = await t.api(`/api/boards/${boardId}/resources/${rid}/tree`, "PUT", {
    tree: { title: "Race deck", question: "What does the harness check?",
      nodes: [{ label: "Every save is held to what the server has", kind: "concept", anchor: "§1", questions: ["What is an invariant?"] }] },
    // a card sits on a verbatim quote: every race essay says this once
    cards: fronts.map((front, i) => ({ node: "n1", type: "flashcard", source: 'quote: "The page draws what it was last told"', front, back: `Answer ${i + 1}: what the server holds.` })),
  });
  const pair = r.state.pairs.find((p) => p.resourceId === rid);
  if (!pair?.deck) throw new Error("the deck was built but no pair drills it");
  return pair.deck;
}
const readerUrl = (t, boardId, s) => `${t.base}/?board=${boardId}&resource=${s.rid}&pair=${s.pair}`;
// the reader opens no card by itself: ↵ brings the card in hand up on its words, once the deck has come
async function handUp(page, filter) {
  const q = filter ? page.locator(".q").filter({ hasText: filter }) : page.locator(".q");
  for (let i = 0; i < 80 && !(await q.count()); i++) { await page.keyboard.press("Enter"); await page.waitForTimeout(250); }
}
const essay = (title, unique) => `# ${title}

## 1 What the page shows

${unique} The page draws what it was last told, and what it was last told is only ever as fresh as the answer that told it.

## 2 What the server holds

A save that has not been acknowledged is a save the page must not call done. A refresh that left before a change cannot be allowed to undo it.
`;
async function proseShown(page, sentence) {
  await page.locator(".page-col.prose").filter({ hasText: sentence.slice(0, 40) }).waitFor({ timeout: 60_000 });
}
// picks the words on the page and opens a question under them: the fold's line, ready to type in
async function askAt(page, words) {
  const at = await phraseAt(page, words);
  await page.mouse.move(at.x0, at.y0);
  await page.mouse.down();
  await page.mouse.move(at.x1, at.y1, { steps: 4 });
  await page.mouse.up();
  await page.locator(".selmenu").getByRole("button", { name: "Ask", exact: true }).click();
  const line = page.locator(".fold .fi.asked .fi-q").first();
  await line.waitFor();
  return line;
}
// the fold of the one question on the page, opened from its tick if a reload or a return shut it
async function askFold(page) {
  if (!(await page.locator(".fold .fi.asked").count())) await page.locator(".ftick:has(.fmk.ask)").first().click();
  await page.locator(".fold .fi.asked").first().waitFor({ timeout: 5000 });
}

async function phraseAt(page, words) {
  const at = await page.evaluate((words) => {
    const host = document.querySelector(".page-col.prose");
    const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.nodeValue.indexOf(words);
      if (i < 0) continue;
      n.parentElement.scrollIntoView({ block: "center" });
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + 1);
      const a = r.getBoundingClientRect();
      r.setStart(n, i + words.length - 1); r.setEnd(n, i + words.length);
      const z = r.getBoundingClientRect();
      return { x0: a.left + 1, y0: a.top + a.height / 2, x1: z.right - 1, y1: z.top + z.height / 2 };
    }
    return null;
  }, words);
  if (!at) throw new Error("the passage to highlight is not on the page");
  return at;
}
// press a failed form's save again, up to `tries` times, as a person would; returns presses and outcome
async function pressUntilGone(form, button, error, tries = 3) {
  let presses = 0, outcome = "stuck";
  while (presses < tries) {
    await button.click();
    presses++;
    await error.waitFor({ state: "hidden" }).catch(() => {});
    outcome = await Promise.race([
      form.waitFor({ state: "detached", timeout: GRACE_MS + 20_000 }).then(() => "closed"),
      error.waitFor({ timeout: GRACE_MS + 20_000 }).then(() => "error"),
    ]).catch(() => "stuck");
    if (outcome !== "error") break;
  }
  return { presses, outcome };
}


// hold the board reads that left before the highlight, highlight, then let the stale answers land
const highlightDuringRefresh = {
  name: "highlight-during-refresh",
  what: "highlight a passage while board refreshes (an import landing, the distil poll) are in flight; after they land the highlight is on screen and on the server exactly once",
  checks: {
    once: "the server holds the highlight exactly once",
    painted: "it was painted as it was made",
    kept: "it is still on screen after the refreshes land",
  },
  async run(t) {
    const b = await board(t, "Race highlight");
    const unique = "Every refresh that left before a highlight must not take the highlight away again.";
    const phrase = "must not take the highlight away again";
    const s = await prose(t, b.id, "race-highlight.md", essay("Highlights and refreshes", unique));
    // the one scenario that watches the live imports list: its own drop landing is the refresh
    const page = await t.open({ latency: true, imports: true });
    await page.goto(readerUrl(t, b.id, s));
    await proseShown(page, unique);
    await t.net.idle(400);
    let highlightedAt = Infinity;
    const refresh = t.net.hold((e) => e.method === "GET" && e.path === `/api/boards/${b.id}` && e.id < highlightedAt);
    const transfer = await page.evaluateHandle((name) => {
      const data = new DataTransfer();
      data.items.add(new File([`# Dropped while reading\n\nA second source, added to the board mid-highlight. ${name}`], name, { type: "text/markdown" }));
      return data;
    }, `race-dropped-${t.seed}.md`);
    await page.locator(".panes").dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await refresh.arrived(1, 90_000);
    await sleep(1500);
    const at = await phraseAt(page, phrase);
    const posted = t.net.when((e) => {
      if (e.method !== "POST" || e.path !== `/api/boards/${b.id}/marks`) return false;
      highlightedAt = e.id;
      return true;
    });
    await page.mouse.move(at.x0, at.y0);
    await page.mouse.down();
    await page.mouse.move(at.x1, at.y1, { steps: 8 });
    await page.mouse.up();
    // a highlight is a note left empty
    await page.locator(".selmenu").getByRole("button", { name: "Note", exact: true }).click();
    await page.keyboard.press("Escape");
    const save = await posted;
    await save.done;
    const id = save.body?.id;
    await page.locator(`.page-col.prose .mk[data-mark="${id}"]`).first().waitFor({ timeout: 5000 }).catch(() => {});
    const before = await page.locator(`.page-col.prose .mk[data-mark="${id}"]`).count();
    t.say(`${refresh.caught.length} board read(s) held while the highlight was made`);
    // pinned only if what is held really is stale: read by the server before the highlight was
    for (const read of refresh.caught) {
      const was = read.response ? await read.response.json() : null;
      if (!was || (was.marks || []).some((m) => m.id === id)) throw new Error("a held board read already carries the highlight — the interleaving was not pinned");
    }
    refresh.release();
    await t.net.idle(600);
    await sleep(1500);
    await t.net.idle(400);
    const state = await t.api(`/api/boards/${b.id}`);
    const held = state.marks.filter((m) => m.resourceId === s.rid && squash(m.quote).includes(phrase));
    const shown = await page.evaluate((words) => {
      const ids = new Set();
      for (const el of document.querySelectorAll(".page-col.prose .mk[data-mark]")) {
        const text = el.textContent.trim();
        if (text && (words.includes(text) || text.includes(words))) ids.add(el.dataset.mark);
      }
      return [...ids];
    }, phrase);
    t.check("once", held.length === 1 && held[0].id === id, `${held.length} on the server`);
    t.check("painted", before > 0, before ? "" : "never painted");
    t.check("kept", shown.length === 1 && shown[0] === id,
      shown.length ? `on screen: ${shown.join(", ")}` : `gone from the page (${refresh.caught.length} stale board reads landed after it)`);
  },
};

const planDoubleMove = {
  name: "plan-double-move",
  what: "move one unit down twice, quickly, while plan answers come back out of order; the order on screen is the server's",
  checks: {
    applied: "the server applied both moves",
    order: "the page shows the server's order",
  },
  async run(t) {
    const b = await board(t, "Race plan");
    const names = ["Alpha unit", "Bravo unit", "Charlie unit"];
    for (const name of names) await t.api(`/api/boards/${b.id}/plan/groups`, "POST", { name });
    const page = await t.open({ latency: true, reorder: { writes: true } });
    await page.goto(`${t.base}/?board=${b.id}`);
    const rows = page.locator(".pp-unit");
    await rows.nth(2).waitFor();
    await t.net.idle(400);
    const order = () => page.evaluate(() => [...document.querySelectorAll(".pp-unit .pp-uname")].map((i) => i.textContent));
    const moveLater = async (name) => {
      const i = (await order()).indexOf(name);
      if (i < 0) throw new Error(`${name} is not on the page`);
      await rows.nth(i).locator(".pp-urow").hover();
      await rows.nth(i).getByRole("button", { name: "Move unit down", exact: true }).click();
    };
    // hold the first move's answer across the second gesture, so the interleaving does not depend on load
    const isMove = (e) => e.method === "PATCH" && e.path.startsWith(`/api/boards/${b.id}/plan/groups/`);
    const firstAnswer = t.net.hold((e) => isMove(e) && e === t.net.entries.find(isMove));
    const second = t.net.when((e) => isMove(e) && e.body?.move === 1 && t.net.entries.filter(isMove).length === 2);
    const shownAt = (want, i) => page.waitForFunction(({ want, i }) => [...document.querySelectorAll(".pp-unit .pp-uname")].map((el) => el.textContent)[i] === want, { want, i });
    await moveLater(names[0]);
    await shownAt(names[0], 1);
    await moveLater(names[0]);
    await shownAt(names[0], 2);
    const sentAtOnce = await Promise.race([second.then(() => true), sleep(1000).then(() => false)]);
    if (sentAtOnce) await (await second).done;
    firstAnswer.release();
    if (!sentAtOnce) await (await second).done;
    t.say(sentAtOnce ? "the second move left before the first's answer" : "the second move waited for the first's answer");
    await t.net.idle(600);
    await sleep(800);
    const shown = await order();
    const byOrd = (plan) => plan.groups.slice().sort((x, y) => x.ord - y.ord).map((m) => m.name);
    const held = byOrd((await t.api(`/api/boards/${b.id}`)).plan);
    // pinned only if the answer that landed last is the stale one (the plan after the first move alone)
    const firstMove = t.net.entries.find(isMove);
    const carried = firstMove?.response ? byOrd((await firstMove.response.json()).plan) : null;
    if (carried?.join() !== [names[1], names[0], names[2]].join()) {
      throw new Error(`the first move's answer carried ${carried ? carried.join(" · ") : "nothing"}, not the plan after the first move alone — the interleaving was not pinned`);
    }
    t.check("applied", held.join() === [names[1], names[2], names[0]].join(), held.join(" · "));
    t.check("order", shown.join() === held.join(), `page ${shown.join(" · ")} — server ${held.join(" · ")}`);
  },
};


// a grade is recognised by what it says, not how it travels, so a fixed transport still passes
const GRADES = 6;
const drillGrades = {
  name: "drill-grades",
  what: "grade six cards quickly in the board drill while some grade requests are dropped and some acknowledgments lost; the server holds exactly one grade per graded card",
  checks: {
    asked: "the page asked for one grade per card graded",
    held: "the server holds exactly one grade per graded card",
  },
  async run(t) {
    const b = await board(t, "Race drill");
    const s = await prose(t, b.id, "race-drill.md", essay("Grading in the drill", "A grade is a fact about a card, and a fact the server never received is a fact the schedule never sees."));
    const fronts = Array.from({ length: GRADES + 2 }, (_, i) => `Race card ${i + 1}: what does check number ${i + 1} compare?`);
    const slug = await deck(t, b.id, s.rid, fronts);
    const cards = (await t.api(`/api/decks/${slug}`)).cards;
    const ids = new Set(cards.map((c) => c.id));
    const cardOf = (e) => {
      const card = e.body?.card ?? e.body?.props?.card;
      const grade = e.event === "card_grade" || /\/grade$/.test(e.path.split("?")[0]);
      return e.write && grade && ids.has(card) ? card : null;
    };
    const isGrade = (e) => cardOf(e) !== null;
    const receipt = (e) => e.headers?.["idempotency-key"] ?? e.body?.requestId ?? e.body?.props?.requestId ?? null;
    const dice = t.rng("victims");
    const fated = [...pick(dice, GRADES, 3 + Math.floor(dice() * 2))];
    const dropped = new Set(fated.slice(0, 1 + Math.floor(dice() * 2)));
    const lost = new Set(fated.filter((i) => !dropped.has(i)));
    t.say(`grades dropped: ${[...dropped].sort().join(", ")} · acknowledgments lost: ${[...lost].sort().join(", ")}`);
    // a retry under a receipt the wire already judged goes through: the fault is the first send's
    const page = await t.open({ latency: true, drop: { match: isGrade, pick: dropped, key: receipt },
      lostAck: { match: isGrade, pick: lost, key: receipt } });
    await page.goto(readerUrl(t, b.id, s));
    await handUp(page);
    const q = page.locator(".q").first();
    await q.waitFor();
    await t.net.idle(400);
    const graded = [];
    for (let i = 0; i < GRADES; i++) {
      const was = await q.innerText();
      const card = cards.find((c) => squash(was).includes(squash(c.front)));
      if (!card) throw new Error(`the drill shows a card its deck does not have: ${JSON.stringify(squash(was).slice(0, 60))}`);
      graded.push(card.id);
      await page.keyboard.press("2");
      await page.locator(".a").first().waitFor();
      await page.keyboard.press("2");
      await page.waitForFunction((w) => document.querySelector(".q")?.innerText !== w, was);
    }
    const holding = () => new Map(t.sql(`SELECT json_extract(props,'$.card') card, COUNT(*) n FROM events
      WHERE event = 'card_grade' AND json_extract(props,'$.card') IN (${[...ids].map(() => "?").join(",")}) GROUP BY 1`, ...ids)
      .map((r) => [r.card, Number(r.n)]));
    const until = performance.now() + GRACE_MS;
    let held = holding(), seen = JSON.stringify([...held].sort()), calm = performance.now();
    while (performance.now() < until) {
      await sleep(250);
      held = holding();
      const is = JSON.stringify([...held].sort());
      if (is !== seen || t.net.entries.some((x) => x.deliveredAt === null)) { seen = is; calm = performance.now(); }
      if (graded.every((c) => held.get(c) >= 1) && performance.now() - calm >= 3000) break;
    }
    // one grade per receipt: a retry under the same receipt is the same grade, not a second
    const asked = new Map();
    for (const e of t.net.entries.filter(isGrade)) asked.set(receipt(e) ?? `#${e.id}`, cardOf(e));
    const tally = (list) => list.reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
    const want = tally(graded), meant = tally([...asked.values()]);
    const short = (card) => card.split("/").pop().slice(0, 28);
    const askedWrong = [...ids].filter((c) => (meant.get(c) || 0) !== (want.get(c) || 0));
    t.check("asked", !askedWrong.length, `${asked.size} grades asked for, ${graded.length} cards graded`
      + (askedWrong.length ? ` — ${askedWrong.map((c) => `${short(c)}: asked ${meant.get(c) || 0}, graded ${want.get(c) || 0}`).join("; ")}` : ""));
    const wrong = [...ids].map((card) => ({ card, want: want.get(card) || 0, got: held.get(card) || 0 })).filter((x) => x.want !== x.got);
    t.check("held", !wrong.length, wrong.map((x) => `${short(x.card)}: ${x.got} held, ${x.want} given`).join("; "));
  },
};

// the control: Review's saves already carry receipts. Only the queue is faked, as a fresh room owes none.
const REVIEWED = 5;
const reviewGrades = {
  name: "review-grades",
  what: "grade five cards in Review while some acknowledgments are lost (retrying as a person would); the server holds exactly one grade per card",
  checks: {
    graded: "every card was graded",
    held: "the server holds exactly one grade per graded card",
    retried: "lost acknowledgments were retried with their receipts",
  },
  async run(t) {
    const b = await board(t, "Race review");
    const s = await prose(t, b.id, "race-review.md", essay("Grading in review", "A receipt is what lets a retry be recognised as the same grade rather than a second one."));
    const slug = await deck(t, b.id, s.rid, Array.from({ length: REVIEWED }, (_, i) => `Review race card ${i + 1}: which receipt is this?`));
    const cards = (await t.api(`/api/decks/${slug}`)).cards.map((c) => ({ ...c, course: slug, courseTitle: "Race review", rung: 0, dueAt: Date.now() - 864e5 }));
    const dice = t.rng("victims");
    const lost = pick(dice, REVIEWED, 2);
    const isGrade = (e) => e.method === "POST" && e.path === "/api/review/grade" && cards.some((c) => c.id === e.body?.card);
    t.say(`acknowledgments lost on grades ${[...lost].sort().join(", ")}`);
    const page = await t.open({ latency: true, lostAck: { match: isGrade, pick: lost, key: (e) => e.body.requestId } });
    let loads = 0;
    await page.route(`${t.base}/api/review`, (route) => {
      loads++;
      return route.fulfill({ json: { cards: loads === 1 ? cards : [], total: loads === 1 ? cards.length : 0, nextDueAt: null, unkeptDue: 0 } });
    });
    await page.goto(`${t.base}/?view=review`);
    const review = page.locator(".reviewv");
    await review.locator(".rv-go").click();
    await review.locator(".q").waitFor();
    const alert = review.getByRole("alert");
    let graded = 0;
    for (let guard = 0; graded < REVIEWED && guard < REVIEWED * 4; guard++) {
      if (await alert.isVisible()) {
        await review.getByRole("button", { name: "Retry saving reviews" }).click();
        await alert.waitFor({ state: "hidden" }).catch(() => {});
        continue;
      }
      const was = await review.locator(".q").innerText();
      await page.keyboard.press("Space");
      await review.locator(".a").waitFor();
      await page.keyboard.press("2");
      await page.waitForFunction((w) => {
        const v = document.querySelector(".reviewv");
        return !v || v.querySelector("[role=alert]") || v.querySelector(".q")?.innerText !== w;
      }, was);
      const now = await page.evaluate(() => document.querySelector(".reviewv .q")?.innerText ?? null);
      if (now !== was) graded++;
    }
    for (let guard = 0; guard < 6; guard++) {
      const done = await review.locator(".smcount").or(alert).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
      if (done && await alert.isVisible()) { await review.getByRole("button", { name: "Retry saving reviews" }).click(); continue; }
      break;
    }
    await t.net.idle(600);
    const sent = t.net.entries.filter(isGrade);
    const receipts = new Map();
    for (const e of sent) receipts.set(e.body.requestId, e.body.card);
    const ids = cards.map((c) => c.id);
    const held = new Map(t.sql(`SELECT json_extract(props,'$.card') card, COUNT(*) n FROM events
      WHERE event = 'card_grade' AND json_extract(props,'$.review') = 1
        AND json_extract(props,'$.card') IN (${ids.map(() => "?").join(",")}) GROUP BY 1`, ...ids).map((r) => [r.card, Number(r.n)]));
    const wrong = ids.map((card) => ({ card, want: [...receipts.values()].filter((c) => c === card).length, got: held.get(card) || 0 }))
      .filter((x) => x.want !== x.got);
    t.check("graded", receipts.size === REVIEWED, `${receipts.size} grades given`);
    t.check("held", !wrong.length,
      wrong.map((x) => `${x.card.split("/").pop().slice(0, 28)}: ${x.got} held, ${x.want} given`).join("; "));
    t.check("retried", sent.length >= REVIEWED + lost.size,
      `${sent.length} requests for ${receipts.size} grades`);
  },
};

// the deleted pair's room must go home, not slide onto the neighbouring source or write its deck memory
function deleteOpenSource({ name, last }) {
  return {
    name,
    what: `open a source (the ${last ? "last" : "first"} of two, each with a deck), raise the project page over it, delete that source there; the room is back on the board's home and shows nothing of it`,
    checks: {
      reader: "the reader no longer shows the deleted source",
      rail: "the project page no longer lists it",
      home: "the room is back on the board's home, not on the source beside it",
      drill: "the card column holds none of the deleted deck's cards",
      memory: "the kept deck's place on this device is untouched",
    },
    async run(t) {
      const b = await board(t, last ? "Race library last" : "Race library");
      const doomedLine = "This source is deleted from the library while it is open on the board.";
      const keptLine = "This source stays on the board.";
      // the library lists every trial's sources: the names are this scenario's and seed's own
      const tag = `${last ? "last-" : ""}${t.seed}`;
      const make = (who) => who === "doomed"
        ? prose(t, b.id, `race-doomed-${tag}.md`, essay("The doomed source", doomedLine))
        : prose(t, b.id, `race-kept-${tag}.md`, essay("The kept source", keptLine));
      const [first, second] = last ? [await make("kept"), await make("doomed")] : [await make("doomed"), await make("kept")];
      const [doomed, kept] = last ? [second, first] : [first, second];
      const doomedFronts = ["Doomed card one: what went?", "Doomed card two: what went?", "Doomed card three: what went?"];
      await deck(t, b.id, doomed.rid, doomedFronts);
      const keptDeck = await deck(t, b.id, kept.rid, ["Kept card one: what stays?", "Kept card two: what stays?", "Kept card three: what stays?"]);
      const keptAt = (await t.api(`/api/decks/${keptDeck}`)).cards[1].id;
      const page = await t.open({ latency: true });
      await page.addInitScript(([key, slug, card]) => {
        try { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ cards: { [slug]: card } })); } catch {}
      }, ["strata.at." + b.id, keptDeck, keptAt]);
      await page.goto(readerUrl(t, b.id, doomed));
      await proseShown(page, doomedLine);
      await handUp(page, "Doomed card");
      await page.locator(".q").filter({ hasText: "Doomed card" }).first().waitFor();
      await t.net.idle(400);
      await page.keyboard.press("h");
      const row = page.locator(".pp-src").filter({ has: page.locator(".pp-sname", { hasText: doomed.filename }) });
      await row.hover();
      await row.locator(".tl-more").click();
      await row.getByRole("button", { name: "delete this source", exact: true }).click();
      await row.getByRole("button", { name: "the source, its pages and its cards — all of it?", exact: true }).click();
      await row.waitFor({ state: "detached" });
      await t.net.idle(500);
      await sleep(500);
      const state = await t.api(`/api/boards/${b.id}`);
      if (state.resources.some((r) => r.id === doomed.rid)) throw new Error("the delete never reached the server");
      const seen = await page.evaluate((key) => {
        const q = new URLSearchParams(location.search);
        let at = null;
        try { at = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
        return { reading: document.querySelector(".page-col.prose")?.innerText ?? "", body: document.body.innerText,
          route: { board: q.get("board"), resource: q.get("resource"), pair: q.get("pair"), view: q.get("view") }, at };
      }, "strata.at." + b.id);
      t.check("reader", !seen.reading.includes(doomedLine.slice(0, 40)), "its text is still on the page");
      const where = seen.route.pair ? (seen.route.pair === kept.pair ? "the kept source" : `pair ${seen.route.pair}`) : null;
      t.check("home", seen.route.board === b.id && !seen.route.pair && !seen.route.resource && !seen.route.view
        && !seen.reading.includes(keptLine.slice(0, 30)),
        `the room stands on ${where ?? JSON.stringify(seen.route)}${seen.reading.includes(keptLine.slice(0, 30)) ? ", with the kept source in the reader" : ""}`);
      const left = doomedFronts.filter((f) => squash(seen.body).includes(squash(f)));
      t.check("drill", !left.length, `still drawn: ${left.join(" · ")}`);
      const remembered = seen.at?.cards?.[keptDeck] ?? null;
      t.check("memory", remembered === keptAt, `the kept deck now resumes on ${remembered}, not ${keptAt}`);
      if (!await page.locator(".pp-title").isVisible()) await page.keyboard.press("h");
      await page.locator(".pp-title").waitFor();
      const rail = await page.locator(".pp-sname").allInnerTexts();
      t.check("rail", !rail.some((x) => x.includes(doomed.filename)), `listed: ${rail.map(squash).join(" · ")}`);
    },
  };
}
const pageDeleteSource = deleteOpenSource({ name: "page-delete-source", last: false });
const pageDeleteLastSource = deleteOpenSource({ name: "page-delete-last-source", last: true });

const chatSwitch = {
  name: "chat-switch",
  what: "ask under words of a source (the fake model streams a reply), go to another source mid-reply and come back; the reply is under the words",
  checks: {
    reply: "the reply is in the fold under the words after coming back",
    question: "the question is in that fold once after coming back",
  },
  async run(t) {
    const b = await board(t, "Race chat");
    const lineA = "The first source is where the question is asked.";
    const lineB = "The second source is where the reader wanders off to.";
    const a = await prose(t, b.id, `race-ask-${t.seed}.md`, essay("Where the question is asked", lineA));
    const other = await prose(t, b.id, `race-away-${t.seed}.md`, essay("Somewhere else", lineB));
    // archived rows keep their idx, so the server's idx for the next question differs from the page's guess
    await t.api(`/api/boards/${b.id}/chat`, "POST", { message: "A turn from before, on the board's own thread." });
    await t.api(`/api/boards/${b.id}/messages`, "DELETE");
    const page = await t.open({ latency: true });
    await page.goto(readerUrl(t, b.id, a));
    await proseShown(page, lineA);
    await t.net.idle(400);
    const passage = Array.from({ length: 22 }, (_, i) => `Clause ${i + 1} of the pasted passage says the page draws what it was last told.`).join(" ");
    const ask = await askAt(page, "where the question is asked");
    await ask.fill(`“${passage}” — why does a refresh that left early undo a later change?`);
    // `missedAt`: when the last look that found no reply was sent; the server saved the reply after it
    const thread = `/api/boards/${b.id}/messages?resource=${encodeURIComponent(a.rid)}`;
    const watch = { missedAt: null, heldAt: null, reply: null, stop: false };
    const sentAt = performance.now();
    const watching = (async () => {
      while (!watch.stop && performance.now() - sentAt < 120_000) {
        const lookedAt = performance.now();
        const { messages } = await t.api(thread);
        const reply = messages.find((m) => m.role !== "user");
        if (reply) { watch.reply = reply; watch.heldAt = performance.now(); return; }
        watch.missedAt = lookedAt;
        await sleep(100);
      }
    })().catch((e) => { watch.error = e; });
    t.later(() => { watch.stop = true; });
    await ask.press("Enter");
    await page.locator(".fold .fi.asked .fi-turn.writing .fi-say").first().waitFor({ timeout: 20_000 });
    t.say(`the reply is streaming after ${Math.round(performance.now() - sentAt)} ms; going to the other source`);
    const open = async (s, line) => {
      await page.keyboard.press("h");
      await page.locator(".pp-sname", { hasText: s.filename }).first().click();
      await proseShown(page, line);
    };
    await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    await open(other, lineB);
    const setOff = t.net.seq;
    await open(a, lineA);
    const backAt = performance.now();
    await watching;
    if (watch.error) throw watch.error;
    if (!watch.reply) throw new Error("the server never finished the reply");
    t.say(`back on the source ${Math.round(backAt - sentAt)} ms after asking; the server held the reply by ${Math.round(watch.heldAt - sentAt)} ms`);
    // the trial counts only if the reader was back before the reply was saved; otherwise it tested nothing
    const carries = (e) => {
      if (e.method !== "GET") return false;
      const u = new URL(e.path, t.base);
      return u.pathname.endsWith(`/api/boards/${b.id}`)
        || (u.pathname.endsWith(`/api/boards/${b.id}/messages`) && u.searchParams.get("resource") === a.rid);
    };
    const way = t.net.entries.filter((e) => e.id > setOff && carries(e));
    const reads = way.filter((e) => e.startedAt <= backAt);
    const firstThread = way.find((e) => e.path.includes("/messages"));
    if (firstThread && !reads.includes(firstThread)) reads.push(firstThread);
    const late = reads.filter((e) => !(e.answeredAt < watch.missedAt));
    if (watch.missedAt === null || !(backAt < watch.missedAt) || late.length) {
      throw new Error(`the reply was saved before the reader was back (back at ${Math.round(backAt - sentAt)} ms, `
        + `last look without it at ${watch.missedAt === null ? "none" : Math.round(watch.missedAt - sentAt)} ms`
        + `${late.length ? `, ${late.map((e) => e.path.split("?")[0]).join(", ")} answered after it` : ""}) — is the room streaming at ROOM_ENV's pace?`);
    }
    await t.net.idle(500);
    await askFold(page);
    await page.locator(".fold .fi.asked .fi-turn.you").first().waitFor({ timeout: 5000 });
    const shown = await page.waitForFunction(() => [...document.querySelectorAll(".fold .fi.asked .fi-turn.claude:not(.writing)")]
      .some((el) => el.innerText.replace(/\s+/g, " ").includes("the short version")), null,
    { timeout: Math.max(1000, watch.heldAt + GRACE_MS - performance.now()), polling: 100 }).then(() => true, () => false);
    const turns = await page.locator(".fold .fi.asked .fi-turn.claude").allInnerTexts();
    t.check("reply", shown,
      `the question is on screen, its reply is not (${turns.length} model turns) — the server holds it`);
    const asked = (await page.locator(".fold .fi.asked .fi-turn.you").allInnerTexts())
      .filter((text) => text.includes("why does a refresh that left early")).length;
    t.check("question", asked === 1, `the question is in the thread ${asked} times`);
  },
};


const sourceRename503 = {
  name: "source-rename-503",
  what: "rename a source on its project page while the server answers the first try 503; the source and its page are renamed together, exactly once",
  checks: {
    together: "the source and its one page carry the new name on the server",
    once: "the server renamed it exactly once, in one request",
    shown: "the project page shows the new name",
  },
  async run(t) {
    const b = await board(t, "Race rename");
    const src = await prose(t, b.id, `race-rename-${t.seed}.md`, essay("A source to rename", "This source is renamed while the server is busy."));
    const page = await t.open({ latency: true });
    // the first try is refused before it reaches the server, by a route registered after the shim
    const renamePath = `/api/boards/${b.id}/resources/${src.rid}`;
    let refused = 0;
    await page.route((url) => url.pathname.endsWith(renamePath), async (route, request) => {
      if (request.method() === "PATCH" && refused === 0) {
        refused++;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "busy — try again" }) });
        return;
      }
      await route.fallback();
    });
    await page.goto(`${t.base}/?board=${b.id}`);
    const row = page.locator(".pp-src").filter({ has: page.locator(".pp-sname", { hasText: src.filename }) });
    await row.hover();
    await row.locator(".tl-more").click();
    await row.getByRole("button", { name: "rename", exact: true }).click();
    const name = `Renamed under load ${t.seed}`;
    await page.getByRole("textbox", { name: "Source name", exact: true }).fill(name);
    await page.getByRole("textbox", { name: "Source name", exact: true }).press("Enter");
    const until = performance.now() + GRACE_MS;
    let state = null;
    for (;;) {
      state = await t.api(`/api/boards/${b.id}`);
      const done = state.resources.find((r) => r.id === src.rid)?.filename === name && state.pairs.find((p) => p.id === src.pair)?.label === name;
      if (done || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    if (refused !== 1) throw new Error("the rename was never refused: the 503 this scenario is about did not happen");
    const filename = state.resources.find((r) => r.id === src.rid)?.filename;
    const label = state.pairs.find((p) => p.id === src.pair)?.label;
    t.check("together", filename === name && label === name, `source "${filename}", its page "${label}"`);
    const renames = Number(t.sql(`SELECT COUNT(*) n FROM events WHERE event = 'resource_rename' AND json_extract(props,'$.board') = ?`, b.id)[0]?.n ?? 0);
    const sent = t.net.entries.filter((e) => e.write && (e.path.startsWith(renamePath) || e.path.startsWith(`/api/boards/${b.id}/pairs/`)));
    t.check("once", renames === 1 && sent.length === 1, `${renames} renames on the server; ${sent.length} requests reached it (${sent.map((e) => e.key).join(", ")})`);
    const shown = await page.locator(".pp-sname", { hasText: name }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
    t.check("shown", shown, "the project page does not carry the new name");
  },
};

// each toggle is one op in the deck's lane; the server must end with the last click's set
const keepsToggle = {
  name: "keeps-toggle",
  what: "keep and let go of one card five times in the workbench while the first keep's answer is held; the kept set is the last toggle's, on the server and on the page",
  checks: {
    held: "the server's kept set is what the last toggle said",
    shown: "the bench shows the server's kept set",
  },
  async run(t) {
    const b = await board(t, "Race keeps");
    const s = await prose(t, b.id, "race-keeps.md", essay("Keeping in the workbench", "A keep is one card's fate, and the last word on it is the last click."));
    const slug = await deck(t, b.id, s.rid, ["Race keep 1: which click is the last word?", "Race keep 2: what does the bench show?", "Race keep 3: what does the server hold?"]);
    const cards = (await t.api(`/api/decks/${slug}`)).cards;
    const target = cards[0];
    const page = await t.open({ latency: true });
    await page.goto(readerUrl(t, b.id, s));
    await handUp(page);
    await page.locator(".q").first().waitFor();
    await t.net.idle(400);
    await page.keyboard.press("r");
    const row = page.locator(`.bench-deck [data-row="${target.id}"]`);
    await row.waitFor();
    await t.net.idle(400);
    const isKeep = (e) => e.method === "POST" && /\/api\/decks\/[^/]+\/keeps$/.test(e.path.split("?")[0]);
    const firstAnswer = t.net.hold((e) => isKeep(e) && e === t.net.entries.find(isKeep));
    const pin = row.locator(".kppin");
    const TOGGLES = 5;
    for (let i = 0; i < TOGGLES; i++) {
      const want = i % 2 === 0 ? "●" : "○";
      await pin.click();
      await page.waitForFunction(({ sel, want }) => document.querySelector(sel)?.textContent === want,
        { sel: `.bench-deck [data-row="${target.id}"] .kppin`, want });
    }
    await firstAnswer.arrived(1);
    firstAnswer.release();
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    const last = TOGGLES % 2 === 1;
    const ids = (await t.api(`/api/decks/${slug}/keeps`)).ids || [];
    const sent = t.net.entries.filter(isKeep).length;
    t.check("held", ids.includes(target.id) === last && ids.length === (last ? 1 : 0),
      `server keeps [${ids.map((x) => x.split("/").pop()).join(", ")}] after ${TOGGLES} toggles (${sent} requests); the last said ${last ? "keep" : "let go"}`);
    const shownPin = await pin.textContent();
    const shownLeft = await page.locator(".bench-keep .kpcard").filter({ hasText: target.front.slice(0, 30) }).count();
    t.check("shown", (shownPin === "●") === ids.includes(target.id) && (shownLeft > 0) === ids.includes(target.id),
      `pin ${shownPin}, ${shownLeft} kept row(s) on the left; the server ${ids.includes(target.id) ? "keeps" : "does not keep"} it`);
  },
};



// three moves faster than the wire: the server must end with the plan the last gesture showed
const planThreeMoves = {
  name: "plan-three-moves",
  what: "three quick moves of the project's units (Alpha down, Alpha down, Delta up) with the first answer held; the final order is the last gesture's, on the server and on screen",
  checks: {
    last: "the server's order is the one the last gesture showed",
    shown: "the page shows the server's order",
  },
  async run(t) {
    const b = await board(t, "Race plan three");
    const names = ["Alpha unit", "Bravo unit", "Charlie unit", "Delta unit"];
    for (const name of names) await t.api(`/api/boards/${b.id}/plan/groups`, "POST", { name });
    const page = await t.open({ latency: true, reorder: { writes: true } });
    await page.goto(`${t.base}/?board=${b.id}`);
    const rows = page.locator(".pp-unit");
    await rows.nth(3).waitFor();
    await t.net.idle(400);
    const order = () => page.evaluate(() => [...document.querySelectorAll(".pp-unit .pp-uname")].map((i) => i.textContent));
    const isMove = (e) => e.method === "PATCH" && e.path.startsWith(`/api/boards/${b.id}/plan/groups/`);
    const firstAnswer = t.net.hold((e) => isMove(e) && e === t.net.entries.find(isMove));
    const move = async (name, label, want) => {
      const i = (await order()).indexOf(name);
      if (i < 0) throw new Error(`${name} is not on the page`);
      await rows.nth(i).locator(".pp-urow").hover();
      await rows.nth(i).getByRole("button", { name: label, exact: true }).click();
      await page.waitForFunction((w) => [...document.querySelectorAll(".pp-unit .pp-uname")].map((el) => el.textContent).join("|") === w, want.join("|"));
    };
    const [A, B, C, D] = names;
    await move(A, "Move unit down", [B, A, C, D]);
    await move(A, "Move unit down", [B, C, A, D]);
    const last = [B, C, D, A];
    await move(D, "Move unit up", last);
    await firstAnswer.arrived(1);
    firstAnswer.release();
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(600);
    await sleep(500);
    const shown = await order();
    const held = (await t.api(`/api/boards/${b.id}`)).plan.groups.slice().sort((x, y) => x.ord - y.ord).map((m) => m.name);
    t.say(`${t.net.entries.filter(isMove).length} moves sent`);
    t.check("last", held.join() === last.join(), `server ${held.join(" · ")}`);
    t.check("shown", shown.join() === held.join(), `page ${shown.join(" · ")} — server ${held.join(" · ")}`);
  },
};

// a project's dates are field patches in the plan's lane: two quick changes end with the last one, wherever answers land
const unitDateTwice = {
  name: "unit-date-twice",
  what: "change a unit's date twice and the project's end twice, quickly, with the first answer held and the rest out of order; the server holds the last of each and the page shows it",
  checks: {
    unit: "the server holds the unit's last date",
    end: "the server holds the project's last end",
    shown: "the page shows the server's dates",
  },
  async run(t) {
    const b = await board(t, "Race dates");
    const { id: gid } = await t.api(`/api/boards/${b.id}/plan/groups`, "POST", { name: "Dated unit" });
    const page = await t.open({ latency: true, reorder: { writes: true } });
    await page.goto(`${t.base}/?board=${b.id}`);
    const unitDate = page.getByLabel("Unit 1 date", { exact: true });
    await unitDate.waitFor({ state: "attached" });
    await t.net.idle(400);
    const isDate = (e) => e.method === "PATCH" && e.path === `/api/boards/${b.id}/plan/groups/${gid}`;
    const firstAnswer = t.net.hold((e) => isDate(e) && e === t.net.entries.find(isDate));
    await unitDate.fill("2026-12-01");
    await unitDate.fill("2026-12-08");
    await firstAnswer.arrived(1);
    firstAnswer.release();
    await page.getByRole("button", { name: "Project menu", exact: true }).click();
    const ends = page.locator(".pp-mrow input[type=date]");
    await ends.fill("2027-01-10");
    await ends.fill("2027-01-17");
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(600);
    await sleep(600);
    const plan = (await t.api(`/api/boards/${b.id}`)).plan;
    const unit = plan.groups.find((g) => g.id === gid)?.byDate;
    t.say(`${t.net.entries.filter(isDate).length} unit date writes; ${t.net.entries.filter((e) => e.method === "PATCH" && e.path.endsWith("/plan/project")).length} end writes`);
    t.check("unit", unit === "2026-12-08", `server ${unit}`);
    t.check("end", plan.endsAt === "2027-01-17", `server ${plan.endsAt}`);
    const shown = [await unitDate.inputValue(), await ends.inputValue()];
    t.check("shown", shown[0] === unit && shown[1] === plan.endsAt, `page ${shown.join(" · ")} — server ${unit} · ${plan.endsAt}`);
  },
};

// a note and removal wait behind the unanswered create, so the server sees create, note, delete in order
const markNoteDelete = {
  name: "mark-note-delete",
  what: "highlight a passage with a note, then remove it, all while the highlight's save is unanswered on a 40 ms wire; the server applies create, note, delete in order — one row, then none",
  checks: {
    order: "the server received create, note and delete in that order, each accepted",
    rows: "the server held one row while the highlight was out, and none at the end",
    shown: "the page shows neither the highlight nor its note",
  },
  async run(t) {
    const b = await board(t, "Race mark burst");
    const unique = "A note written before the highlight is saved still lands after it.";
    const phrase = "still lands after it";
    const s = await prose(t, b.id, "race-burst.md", essay("Highlight, note, delete", unique));
    const page = await t.open({ latency: 40 });
    await page.goto(readerUrl(t, b.id, s));
    await proseShown(page, unique);
    await t.net.idle(400);
    const marksPath = `/api/boards/${b.id}/marks`;
    const isMarkWrite = (e) => e.write && e.path.split("?")[0].startsWith(marksPath);
    const created = t.net.hold((e) => e.method === "POST" && e.path === marksPath);
    const at = await phraseAt(page, phrase);
    const startedAt = performance.now();
    await page.mouse.move(at.x0, at.y0);
    await page.mouse.down();
    await page.mouse.move(at.x1, at.y1, { steps: 4 });
    await page.mouse.up();
    await page.locator(".selmenu").getByRole("button", { name: "Note", exact: true }).click();
    const editor = page.locator(".fold .fi-edit");
    await editor.waitFor();
    const note = `Why it matters, seed ${t.seed}.`;
    await page.keyboard.type(note);
    await page.keyboard.press("Escape");
    const id = await page.evaluate(() => document.querySelector(".page-col.prose .mk[data-mark]")?.dataset.mark ?? null);
    if (!id) throw new Error("the highlight was never painted");
    await page.locator(`.page-col.prose .mk[data-mark="${id}"]`).first().click();
    await page.locator(".fold .fi-rm").dispatchEvent("mousedown");
    const actedIn = Math.round(performance.now() - startedAt);
    await created.arrived(1);
    const during = Number(t.sql("SELECT COUNT(*) n FROM marks WHERE id = ?", id)[0]?.n ?? 0);
    const sentWhileHeld = t.net.entries.filter((e) => isMarkWrite(e) && e.method !== "POST").length;
    t.say(`highlight, note and remove made in ${actedIn} ms; ${sentWhileHeld} later act(s) on the wire while the create was held`);
    created.release();
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    const sent = t.net.entries.filter(isMarkWrite);
    const kinds = sent.map((e) => `${e.method} ${e.status}`);
    t.check("order", /^POST 20\d,PATCH 200,DELETE 200$/.test(kinds.join())
      && sent[1].startedAt >= sent[0].deliveredAt && sent[2].startedAt >= sent[1].deliveredAt,
    `wire: ${kinds.join(", ")}`);
    const after = Number(t.sql("SELECT COUNT(*) n FROM marks WHERE id = ?", id)[0]?.n ?? 0);
    t.check("rows", during === 1 && after === 0, `${during} row(s) while held, ${after} at the end`);
    const left = await page.locator(`[data-mark="${id}"]`).count();
    t.check("shown", left === 0, `${left} element(s) still name it`);
  },
};

// captions are the one capture this room can write; the link step is faked, the save's answer lost
const captureLostAnswer = {
  name: "capture-lost-answer",
  what: "add a talk's captions from the capture dialog while the answer to the save is lost (pressing again if the dialog says it failed); the board holds one source",
  checks: {
    one: "the server holds exactly one source from the capture",
    landed: "the dialog closes and the board lists the source",
  },
  async run(t) {
    const b = await board(t, "Race capture");
    const url = `https://www.youtube.com/watch?v=race-${t.seed}`;
    const title = `Race talk ${t.seed}`;
    const isFinish = (e) => e.method === "POST" && e.path === `/api/boards/${b.id}/capture/finish`;
    const page = await t.open({ latency: true, lostAck: { match: isFinish, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.route((u) => u.pathname === `/api/boards/${b.id}/capture`, (route) => route.fulfill({ json: {
      kind: "youtube", url, title, author: "The race harness",
      ytDlpCommand: "yt-dlp --race", ytDlpCommands: { macos: "yt-dlp --race", windows: "yt-dlp --race" } } }));
    await page.goto(`${t.base}/?board=${b.id}`);
    await page.getByRole("navigation", { name: "Strata" }).getByRole("button", { name: "+ Add", exact: true }).click();
    await page.locator(".addmenu").getByRole("button", { name: "from a link youtube / article", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator("input").fill(url);
    await dialog.locator("input").press("Enter");
    const captions = dialog.locator("textarea");
    await captions.waitFor();
    await captions.fill(`WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nA capture whose answer is lost is still one source.\n\n00:00:04.000 --> 00:00:08.000\nThe receipt tells a retry from a second talk, seed ${t.seed}.\n`);
    await t.net.idle(300);
    const add = dialog.getByRole("button", { name: "add the transcript", exact: true });
    const { presses, outcome } = await pressUntilGone(dialog, add, dialog.locator(".err"));
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    const sent = t.net.entries.filter(isFinish);
    if (!sent.some((e) => e.outcome === "lost-ack")) throw new Error("no capture answer was lost: the race this scenario is about did not happen");
    t.say(`${presses} press(es), ${sent.length} request(s): ${sent.map((e) => e.outcome).join(", ")}`);
    const rows = t.sql("SELECT id, filename FROM resources WHERE board_id = ?", b.id);
    t.check("one", rows.length === 1, `${rows.length} source(s) on the server after ${presses} press(es) and ${sent.length} request(s)`);
    const label = (await t.api(`/api/boards/${b.id}`)).resources[0]?.filename ?? "";
    const listed = outcome === "closed" && !!label && await page.locator(".pp-sname", { hasText: label }).first()
      .waitFor({ timeout: 5000 }).then(() => true, () => false);
    t.check("landed", listed, `the dialog ${outcome === "closed" ? "closed" : `is ${outcome}`}; ${label ? `the board ${listed ? "lists" : "does not list"} "${label}"` : "no page on the server"}`);
  },
};

const COUNTER_PAGE =`<!doctype html><html><body><h1>Counter</h1><button id="add">add one</button> <output id="n">…</output>
<script>
let n = 0;
const out = document.getElementById("n");
document.addEventListener("DOMContentLoaded", async () => {
  const kept = await window.strata.load().catch(() => null);
  n = kept && typeof kept.n === "number" ? kept.n : 0;
  out.textContent = String(n);
  document.body.dataset.loaded = String(n);
  document.getElementById("add").onclick = () => {
    n++; out.textContent = String(n);
    const mine = n;
    window.strata.save({ n: mine }).then(() => { document.body.dataset.saved = String(Math.max(mine, Number(document.body.dataset.saved || 0))); },
      (e) => { document.body.dataset.failed = String(e && e.message); });
  };
});
</script></body></html>`;

const pageStateSaves = {
  name: "page-state-saves",
  what: "click a live page's counter quickly while its saves answer late, out of order, and the first answer is lost; the server holds the last count, and the reopened page shows it",
  checks: {
    last: "the server holds the page's last saved value",
    said: "every save the page was told landed is at or below what the server holds",
    reopened: "the reopened page loads the last value",
  },
  async run(t) {
    const b = await board(t, "Race page state");
    const up = await t.api(`/api/boards/${b.id}/resources`, "POST", { filename: "counter.html", base64: Buffer.from(COUNTER_PAGE).toString("base64"), pair: true });
    const pair = up.state.pairs.find((p) => p.resourceId === up.id);
    if (!pair) throw new Error("no pair was made for the live page");
    const isSave = (e) => e.method === "PUT" && e.path === `/api/boards/${b.id}/resources/${up.id}/state`;
    const page = await t.open({ latency: true, reorder: { writes: true }, lostAck: { match: isSave, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    const url = readerUrl(t, b.id, { rid: up.id, pair: pair.id });
    await page.goto(url);
    const frame = page.frameLocator("iframe.html-frame");
    await frame.locator("body[data-loaded]").waitFor({ timeout: 30_000 });
    const clicks = 6 + Math.floor(t.rng("clicks")() * 4);
    const gap = t.rng("gap");
    for (let i = 0; i < clicks; i++) { await frame.locator("#add").click(); await sleep(60 + Math.floor(gap() * 200)); }
    const until = performance.now() + GRACE_MS;
    let held = null;
    for (;;) {
      const row = t.sql("SELECT value FROM page_states WHERE resource_id = ?", up.id)[0];
      held = row ? JSON.parse(row.value).n : null;
      if (held === clicks || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    if (!t.net.entries.filter(isSave).some((e) => e.outcome === "lost-ack")) throw new Error("no save answer was lost: the race this scenario is about did not happen");
    const said = Number(await frame.locator("body").getAttribute("data-saved") ?? 0);
    const failed = await frame.locator("body").getAttribute("data-failed");
    t.check("last", held === clicks, `server holds ${held} after ${clicks} clicks${failed ? ` (a save failed: ${failed})` : ""}`);
    t.check("said", said <= (held ?? 0), `the page was told ${said} landed, the server holds ${held}`);
    await page.goto(url);
    await frame.locator("body[data-loaded]").waitFor({ timeout: 30_000 });
    const loaded = Number(await frame.locator("body").getAttribute("data-loaded"));
    t.check("reopened", loaded === clicks, `the reopened page loaded ${loaded}`);
  },
};

const DECISION_PAGE = `<!doctype html><html><body><h1>Decisions</h1>
<section data-strata-id="S3"><h2>Tree granularity</h2><p id="lean">One sample per top-level window, tagged with a window id.</p></section>
<p id="cost">Holding the whole recording in RAM costs about 2.2 GB per hour.</p>
<script>document.body.dataset.ready = "1"</script></body></html>`;

const liveNotes = {
  name: "live-notes",
  what: "write a note on words and one on a labelled box inside a live page, while the writes answer late, out of order, and the first note's answer is lost; each note is held once, on its words or its box, and both show in the page",
  checks: {
    notes: "the server holds the two notes, each once, one on words and one on box S3",
    said: "each holds the words that were written",
    shown: "the page shows both notes, each once, in their sheets",
  },
  async run(t) {
    const b = await board(t, "Race live notes");
    const up = await t.api(`/api/boards/${b.id}/resources`, "POST", { filename: "decisions.html", base64: Buffer.from(DECISION_PAGE).toString("base64"), pair: true });
    const pair = up.state.pairs.find((p) => p.resourceId === up.id);
    if (!pair) throw new Error("no pair was made for the live page");
    const isCreate = (e) => e.method === "POST" && e.path === `/api/boards/${b.id}/marks`;
    const page = await t.open({ latency: true, reorder: { writes: true }, lostAck: { match: isCreate, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(readerUrl(t, b.id, { rid: up.id, pair: pair.id }));
    const frame = page.frameLocator("iframe.html-frame");
    await frame.locator("body[data-ready]").waitFor({ timeout: 30_000 });
    const said = ["Show the arithmetic.", "The unit should be the top-level window."];

    await frame.locator("#cost").selectText();
    await frame.locator("#cost").dispatchEvent("mouseup");
    await page.locator(".selmenu button", { hasText: "Note" }).click({ timeout: 10_000 });
    await frame.locator(".fi-edit").fill(said[0], { timeout: 10_000 });
    await frame.locator(".fi-edit").press("Escape");

    await frame.locator("#lean").click();
    await page.locator(".selmenu button", { hasText: "Note" }).click({ timeout: 10_000 });
    await frame.locator(".fi-edit").fill(said[1], { timeout: 10_000 });
    await sleep(Math.floor(t.rng("pause")() * 300));
    await frame.locator(".fi-edit").press("Escape");

    const until = performance.now() + GRACE_MS;
    let rows = [];
    for (;;) {
      rows = t.sql("SELECT note, box FROM marks WHERE resource_id = ? ORDER BY created_at", up.id);
      if ((rows.length === 2 && rows.every((r) => r.note)) || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    if (!t.net.entries.filter(isCreate).some((e) => e.outcome === "lost-ack")) throw new Error("no note's answer was lost: the race this scenario is about did not happen");
    const where = rows.map((r) => (r.box ? `box ${r.box}` : "words")).sort().join(", ");
    t.check("notes", rows.length === 2 && where === "box S3, words", `${rows.length} note(s): ${where}`);
    t.check("said", rows.map((r) => r.note).sort().join("|") === [...said].sort().join("|"), rows.map((r) => r.note).join(" · "));
    // a note written from a selection shuts to its tick when saved: each is opened to be read
    const ticks = frame.locator(".ftick:has(.fmk.note)");
    for (let i = 0; i < 4 && await ticks.count(); i++) { await ticks.first().click(); await sleep(200); }
    const shown = await frame.locator(".fi-note").allTextContents();
    t.check("shown", shown.length === 2 && said.every((s) => shown.includes(s)), `page: ${shown.join(" · ")}`);
  },
};

const liveNoteRemove = {
  name: "live-note-remove",
  what: "remove one of two notes on a live page from its fold, and lose the delete's answer; the server holds only the other note, and the page shows only it",
  checks: {
    server: "the server holds only the note that was kept",
    shown: "the page shows the one note left",
  },
  async run(t) {
    const b = await board(t, "Race live note remove");
    const up = await t.api(`/api/boards/${b.id}/resources`, "POST", { filename: "decisions.html", base64: Buffer.from(DECISION_PAGE).toString("base64"), pair: true });
    const pair = up.state.pairs.find((p) => p.resourceId === up.id);
    if (!pair) throw new Error("no pair was made for the live page");
    const gone = await t.api(`/api/boards/${b.id}/marks`, "POST", { resourceId: up.id, start: 0, end: 0, quote: "Holding the whole recording in RAM", note: "Remove me." });
    await t.api(`/api/boards/${b.id}/marks`, "POST", { resourceId: up.id, start: 0, end: 0, quote: "Tree granularity", box: "S3", note: "Keep me." });
    const isDelete = (e) => e.method === "DELETE" && e.path.split("?")[0] === `/api/boards/${b.id}/marks/${gone.id}`;
    const page = await t.open({ latency: true, lostAck: { match: isDelete, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(readerUrl(t, b.id, { rid: up.id, pair: pair.id }));
    const frame = page.frameLocator("iframe.html-frame");
    await frame.locator("body[data-ready]").waitFor({ timeout: 30_000 });
    await frame.locator("#cost").click({ position: { x: 6, y: 8 } });
    await frame.locator(".fi-rm").dispatchEvent("mousedown", {}, { timeout: 10_000 });
    const until = performance.now() + GRACE_MS;
    let rows = [];
    for (;;) {
      rows = t.sql("SELECT note FROM marks WHERE resource_id = ?", up.id);
      if (rows.length === 1 || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    t.check("server", rows.length === 1 && rows[0].note === "Keep me.", rows.map((r) => r.note).join(" · ") || "none");
    await frame.locator(".ftick").first().click({ timeout: 10_000 });
    const shown = await frame.locator(".fi-note").allTextContents();
    t.check("shown", shown.join("|") === "Keep me.", `page: ${shown.join(" · ") || "none"}`);
  },
};

// the SSE stream bypasses the shim, so the harness carries the first turn itself and cuts it mid-reply
const chatStreamCut = {
  name: "chat-stream-cut",
  what: "ask under words of a source and have the reply's stream cut mid-way; asking again (the question is back in the fold's line) leaves one question and one reply, on the server and on screen",
  checks: {
    question: "the server holds the question once",
    reply: "the server holds one reply to it",
    shown: "the thread on screen shows the question once and its reply once",
  },
  async run(t) {
    const b = await board(t, "Race chat cut");
    const line = "A reply cut off on the wire is resumed, not asked twice.";
    const a = await prose(t, b.id, `race-cut-${t.seed}.md`, essay("Where the stream is cut", line));
    const page = await t.open({ latency: true });
    const chatPath = `/api/boards/${b.id}/chat`;
    const turns = [];
    let cut = null;
    await page.route((u) => u.pathname === chatPath, async (route, request) => {
      if (request.method() !== "POST") return route.fallback();
      const h = request.headers();
      turns.push(h["idempotency-key"] ?? null);
      if (cut) return route.fallback();
      cut = { frames: 0, deltas: 2 + Math.floor(t.rng("cut")() * 4) };
      const stop = new AbortController();
      const res = await fetch(t.base + chatPath, { method: "POST", signal: stop.signal, body: request.postData(),
        headers: Object.fromEntries(Object.entries(h).filter(([k]) => ["content-type", "accept", "idempotency-key"].includes(k) || k.startsWith("x-strata"))) });
      let text = "";
      if (res.ok && res.body) {
        const reader = res.body.getReader(), dec = new TextDecoder();
        try {
          while ((text.match(/^event: delta$/gm) || []).length < cut.deltas) {
            const { value, done } = await reader.read();
            if (done) break;
            text += dec.decode(value, { stream: true });
          }
        } catch { }
      }
      stop.abort();
      text = text.slice(0, text.lastIndexOf("\n\n") + 2);
      cut.frames = (text.match(/^event: /gm) || []).length;
      cut.status = res.status;
      await route.fulfill({ status: res.status, headers: { "content-type": "text/event-stream" }, body: text });
    });
    await page.goto(readerUrl(t, b.id, a));
    await proseShown(page, line);
    await t.net.idle(400);
    const question = `Seed ${t.seed}: why does a stream cut short not ask the question twice?`;
    const ask = await askAt(page, "is resumed, not asked twice");
    await ask.fill(question);
    await ask.press("Enter");
    await page.waitForFunction((q) => document.querySelector(".fold .fi.asked .fi-q")?.value === q, question, { timeout: 30_000 });
    if (!cut || cut.status !== 200 || !cut.frames) throw new Error(`the stream was not cut mid-reply (${cut ? `${cut.status}, ${cut.frames} frames` : "no turn"})`);
    t.say(`the stream was cut after ${cut.frames} frame(s); asking again`);
    await ask.focus();
    await ask.press("Enter");
    const thread = `/api/boards/${b.id}/messages?resource=${encodeURIComponent(a.rid)}`;
    const until = performance.now() + GRACE_MS + 20_000;
    let messages = [];
    for (;;) {
      ({ messages } = await t.api(thread));
      const q = messages.filter((m) => m.role === "user" && squash(m.text) === squash(question));
      if ((q.length && messages.some((m) => m.role !== "user" && m.idx > q[0].idx)) || performance.now() > until) break;
      await sleep(250);
    }
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    ({ messages } = await t.api(thread));
    const asked = messages.filter((m) => m.role === "user" && squash(m.text) === squash(question));
    const replies = asked.length ? messages.filter((m) => m.role !== "user" && m.idx > asked[0].idx) : [];
    t.say(`${turns.length} turn request(s), ${new Set(turns).size} key(s)`);
    t.check("question", asked.length === 1, `${asked.length} on the server`);
    t.check("reply", replies.length === 1, `${replies.length} replies on the server`);
    // the fake model's reply always says "the short version", which reads the same raw and rendered
    const said = "the short version";
    const shownOnce = await page.waitForFunction(({ q, r }) => {
      const me = [...document.querySelectorAll(".fold .fi.asked .fi-turn.you")].filter((el) => el.innerText.replace(/\s+/g, " ").includes(q)).length;
      const it = [...document.querySelectorAll(".fold .fi.asked .fi-turn.claude:not(.writing)")].filter((el) => el.innerText.replace(/\s+/g, " ").includes(r)).length;
      return me === 1 && it === 1;
    }, { q: question.slice(0, 40), r: said }, { timeout: GRACE_MS }).then(() => true, () => false);
    const me = (await page.locator(".fold .fi.asked .fi-turn.you").allInnerTexts()).filter((x) => squash(x).includes(question.slice(0, 40))).length;
    const its = await page.locator(".fold .fi.asked .fi-turn.claude").allInnerTexts();
    const it = its.filter((x) => squash(x).includes(said)).length;
    t.check("shown", shownOnce, `the question ${me} time(s), its reply ${it} time(s) on screen (${its.length} model turns${its.length ? `: ${JSON.stringify(squash(its.at(-1)).slice(0, 60))}` : ""})`);
  },
};

// the edit's answer is lost after the server applied it: the save path must retry under the same key
const cardEditLost = {
  name: "card-edit-lost",
  what: "rewrite a card's question in the drill's editor while the save's answer is lost; the server applies one edit, and the editor ends saved with the new question on the card",
  checks: {
    once: "the server applied the edit once and holds the new question",
    saved: "the editor closed without an error and the card shows the new question",
  },
  async run(t) {
    const b = await board(t, "Race card edit");
    const s = await prose(t, b.id, "race-card-edit.md", essay("Rewriting a card", "A card rewritten on a lossy wire is rewritten once."));
    const slug = await deck(t, b.id, s.rid, ["Race edit 1: what is rewritten?", "Race edit 2: what stays?", "Race edit 3: what does the server hold?"]);
    const cards = (await t.api(`/api/decks/${slug}`)).cards;
    const ids = new Set(cards.map((c) => c.id));
    const isEdit = (e) => e.method === "PATCH" && e.path.split("?")[0].startsWith(`/api/decks/${slug}/cards/`);
    const page = await t.open({ latency: true, lostAck: { match: isEdit, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(readerUrl(t, b.id, s));
    await handUp(page);
    const q = page.locator(".q").first();
    await q.waitFor();
    await t.net.idle(400);
    const shown = squash(await q.innerText());
    const card = cards.find((c) => shown.includes(squash(c.front)));
    if (!card || !ids.has(card.id)) throw new Error(`the drill shows a card its deck does not have: ${JSON.stringify(shown.slice(0, 60))}`);
    const front = `Race edit, seed ${t.seed}: which answer was lost?`;
    await page.keyboard.press("e");
    const editor = page.locator(".ced");
    await editor.waitFor();
    const face = editor.locator("textarea").first();
    await face.fill(front);
    await editor.getByRole("button", { name: "Format & Preview", exact: true }).click();
    const confirm = editor.getByRole("button", { name: "Confirm save", exact: true });
    await confirm.waitFor();
    await t.net.idle(300);
    const { presses, outcome } = await pressUntilGone(editor, confirm, editor.locator(".ced-err"));
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    const sent = t.net.entries.filter(isEdit);
    if (!sent.some((e) => e.outcome === "lost-ack")) throw new Error("no edit's answer was lost: the race this scenario is about did not happen");
    t.say(`${presses} press(es); ${sent.length} PATCH(es): ${sent.map((e) => `${e.outcome} ${e.status}`).join(", ")}; ${new Set(sent.map((e) => e.headers["idempotency-key"])).size} key(s)`);
    // the route's own event (it carries `ignored`), not the drill's log line of the same name
    const edits = Number(t.sql("SELECT COUNT(*) n FROM events WHERE event = 'card_edit' AND json_extract(props,'$.card') = ? AND json_type(props,'$.ignored') IS NOT NULL", card.id)[0]?.n ?? 0);
    const held = (await t.api(`/api/decks/${slug}`)).cards.find((c) => c.id === card.id);
    t.check("once", edits === 1 && squash(held?.front) === squash(front), `${edits} edit(s) applied; the server's question ${JSON.stringify(squash(held?.front).slice(0, 50))}`);
    const onCard = await page.waitForFunction((want) => [...document.querySelectorAll(".q")].some((el) => el.innerText.replace(/\s+/g, " ").includes(want)),
      front.slice(0, 30), { timeout: 5000 }).then(() => true, () => false);
    t.check("saved", outcome === "closed" && presses === 1 && onCard,
      `the editor ${outcome === "closed" ? "closed" : `is ${outcome}`} after ${presses} press(es); the card ${onCard ? "shows" : "does not show"} the new question`);
  },
};

// a 400 is not retried, so the person presses again: only the draft's key keeps that from a second card
const authoredTwice = {
  name: "authored-twice",
  what: "write a card of your own; the first save is made but answered 400, so you press Confirm save again on the same draft; the board holds one card, and the second press replayed the first",
  checks: {
    one: "the server holds one card from the draft",
    replayed: "the second press sent the first press's key",
    closed: "the composer closed without an error",
  },
  async run(t) {
    const b = await board(t, "Race your card");
    const isCreate = (e) => e.method === "POST" && e.path === `/api/boards/${b.id}/minted`;
    const page = await t.open({ latency: true, lostAck: { match: isCreate, pick: new Set([1]), status: 400, key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/?board=${b.id}`);
    await page.locator(".pp-title").first().waitFor();
    await t.net.idle(400);
    await page.locator("button.newcard").click();
    const form = page.locator(".comp");
    await form.waitFor();
    const front = `Race card of my own, seed ${t.seed}: is it saved once?`;
    await form.locator("textarea.front").fill(front);
    await form.locator("textarea.back").fill("Once: the draft's key makes the second save the first one again.");
    await form.getByRole("button", { name: "Format & Preview", exact: true }).click();
    const confirm = form.getByRole("button", { name: "Confirm save", exact: true });
    await confirm.waitFor();
    await t.net.idle(300);
    const { presses, outcome } = await pressUntilGone(form, confirm, form.getByRole("alert"));
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    const sent = t.net.entries.filter(isCreate);
    const keys = new Set(sent.map((e) => e.headers["idempotency-key"]));
    t.say(`${presses} press(es); ${sent.length} POST(s): ${sent.map((e) => `${e.outcome} ${e.status}`).join(", ")}; ${keys.size} key(s)`);
    if (!(sent[0]?.outcome === "lost-ack" && sent[0].status >= 200 && sent[0].status < 300)) throw new Error("the first create was not made and then refused: the race this scenario is about did not happen");
    if (presses < 2 || sent.length < 2) throw new Error(`the composer closed after ${presses} press(es) and ${sent.length} POST(s): the second press this scenario is about never happened`);
    const rows = t.sql("SELECT id, front FROM minted WHERE board_id = ?", b.id);
    t.check("one", rows.length === 1 && squash(rows[0].front).includes(squash(front).slice(0, 30)), `${rows.length} card(s) on the server after ${presses} presses`);
    t.check("replayed", keys.size === 1 && !keys.has(undefined), `${keys.size} Idempotency-Key(s) across ${sent.length} POSTs`);
    t.check("closed", outcome === "closed", `the composer ${outcome === "closed" ? "closed" : `is ${outcome}`} after ${presses} press(es)`);
  },
};


// shared by the cancel scenarios: two capture dialogs of the same captions, each save held on its own
async function cancelAndCaptureAgain(t, title, { lostAck = null, beforeSecondPress = null, fallback = false } = {}) {
  const b = await board(t, title);
  const url = `https://www.youtube.com/watch?v=again-${t.seed}`;
  const talk = `${title} talk ${t.seed}`;
  const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nA capture cancelled and made again is still one source.\n\n00:00:04.000 --> 00:00:08.000\nThe key belongs to the captions, seed ${t.seed}.\n`;
  const isFinish = (e) => e.method === "POST" && e.path === `/api/boards/${b.id}/capture/finish`;
  const page = await t.open({ latency: true, ...(lostAck ? { lostAck: { match: isFinish, ...lostAck } } : {}) });
  let fetched = 0;
  await page.route((u) => u.pathname === `/api/boards/${b.id}/capture`, (route) => {
    const fell = ++fetched > 1 && fallback;
    return route.fulfill({ json: {
      kind: "youtube", url, title: fell ? url : talk, author: fell ? null : "The race harness",
      ytDlpCommand: "yt-dlp --race", ytDlpCommands: { macos: "yt-dlp --race", windows: "yt-dlp --race" } } });
  });
  await page.goto(`${t.base}/?board=${b.id}`);
  const dialog = page.getByRole("dialog");
  const captureIt = async (beforePress = null) => {
    await page.getByRole("navigation", { name: "Strata" }).getByRole("button", { name: "+ Add", exact: true }).click();
    await page.locator(".addmenu").getByRole("button", { name: "from a link youtube / article", exact: true }).click();
    await dialog.locator("input").fill(url);
    await dialog.locator("input").press("Enter");
    await dialog.locator("textarea").fill(vtt);
    if (beforePress) await beforePress();
    await dialog.getByRole("button", { name: "add the transcript", exact: true }).click();
  };
  const first = t.net.hold((e) => isFinish(e) && e.n === 1);
  const second = t.net.hold((e) => isFinish(e) && e.n === 2);
  await captureIt();
  await first.arrived(1);
  // the three ways out, one per seed of the gate's three (dice could deal one way three times)
  const how = ["esc", "cancel", "veil"][(t.seed - 1) % 3];
  if (how === "esc") await page.keyboard.press("Escape");
  else if (how === "cancel") await dialog.getByRole("button", { name: "cancel", exact: true }).click();
  else await page.locator(".capture-veil").click({ position: { x: 4, y: 4 } });
  await dialog.waitFor({ state: "detached" });
  await captureIt(beforeSecondPress && (() => beforeSecondPress({ page, dialog, first, url })));
  await second.arrived(1);
  return { b, page, dialog, vtt, isFinish, first, second, how };
}
async function oneListed(t, page, b, closed) {
  const rows = t.sql("SELECT id FROM resources WHERE board_id = ?", b.id);
  const label = (await t.api(`/api/boards/${b.id}`)).resources[0]?.filename ?? "";
  const listed = closed && !!label && await page.locator(".pp-sname", { hasText: label }).first()
    .waitFor({ timeout: 5000 }).then(() => true, () => false);
  return { rows, label, listed };
}

// the second press must reuse the first's key (it belongs to the bytes), and the late answer not touch it
const captureCancelAgain = {
  name: "capture-cancel-again",
  what: "add a talk's captions, cancel the dialog while the save's answer is held, capture the same captions again, then let the answers land in turn; the board holds one source and the second dialog closes on its own answer",
  checks: {
    one: "the server holds exactly one source from the two dialogs",
    kept: "the first answer, landing after its dialog was cancelled, leaves the second dialog open with its captions while its own save is out",
    landed: "the second dialog closes on its own answer and the board lists the source",
  },
  async run(t) {
    const { b, page, dialog, vtt, isFinish, first, second, how } = await cancelAndCaptureAgain(t, "Race capture again");
    first.release();
    await first.caught[0].done;
    const told = await page.locator(".import-receipt").waitFor({ timeout: 10_000 }).then(() => true, () => false);
    const open = await dialog.count() === 1;
    const box = open ? await dialog.locator("textarea").inputValue().catch(() => null) : null;
    const waiting = open && await dialog.getByRole("button", { name: "working…", exact: true }).count() === 1;
    t.check("kept", open && box === vtt && waiting,
      `${told ? "the first capture landed" : "no receipt for the first capture"}; the second dialog ${!open ? "was closed by it" : box !== vtt ? `holds ${JSON.stringify(squash(box).slice(0, 60))}` : waiting ? "is open, its save still out" : "is open but no longer waiting on its save"}`);
    second.release();
    await second.caught[0].done;
    const closed = await dialog.waitFor({ state: "detached", timeout: 10_000 }).then(() => true, () => false);
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    const sent = t.net.entries.filter(isFinish);
    const keys = new Set(sent.map((e) => e.headers["idempotency-key"] ?? "(none)")).size;
    t.say(`cancelled by ${how}; ${sent.length} save(s) under ${keys} key(s), answered ${sent.map((e) => e.status).join(", ")}`);
    const { rows, label, listed } = await oneListed(t, page, b, closed);
    t.check("one", rows.length === 1, `${rows.length} source(s) on the server after two dialogs sent the same captions under ${keys} key(s)`);
    t.check("landed", listed, `the dialog ${closed ? "closed" : "is still open"}; ${label ? `the board ${listed ? "lists" : "does not list"} "${label}"` : "no page on the server"}`);
  },
};

// the first landing must not release the captions' key while the second press is out
const captureCancelLost = {
  name: "capture-cancel-lost",
  what: "add a talk's captions, cancel the dialog while the save's answer is held, capture the same captions again, let the first answer land and lose the second, then press again in the second dialog; the board holds one source",
  checks: {
    one: "the server holds exactly one source after two dialogs and a press again sent the same captions",
    landed: "the second dialog, pressed again after its answer was lost, closes and the board lists the source",
  },
  async run(t) {
    const { b, page, dialog, isFinish, first, second, how } = await cancelAndCaptureAgain(t, "Race capture lost", { lostAck: { pick: new Set([2]) } });
    first.release();
    await first.caught[0].done;
    await page.locator(".import-receipt").waitFor({ timeout: 10_000 }).catch(() => {});
    second.release();
    await second.caught[0].done;
    const said = await dialog.locator(".err").waitFor({ timeout: 10_000 }).then(() => true, () => false);
    const add = dialog.getByRole("button", { name: "add the transcript", exact: true });
    const { presses, outcome } = said ? await pressUntilGone(dialog, add, dialog.locator(".err")) : { presses: 0, outcome: "gone before it said the answer was lost" };
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    const sent = t.net.entries.filter(isFinish);
    if (!sent.some((e) => e.outcome === "lost-ack")) throw new Error("no capture answer was lost: the race this scenario is about did not happen");
    const keys = new Set(sent.map((e) => e.headers["idempotency-key"] ?? "(none)")).size;
    t.say(`cancelled by ${how}; ${presses} press(es) again; ${sent.length} save(s) under ${keys} key(s): ${sent.map((e) => e.outcome === "ok" ? e.status : e.outcome).join(", ")}`);
    const closed = outcome === "closed";
    const { rows, label, listed } = await oneListed(t, page, b, closed);
    t.check("one", rows.length === 1, `${rows.length} source(s) on the server after ${sent.length} save(s) of the same captions under ${keys} key(s)`);
    t.check("landed", listed, `the dialog ${closed ? "closed" : `is ${outcome}`}; ${label ? `the board ${listed ? "lists" : "does not list"} "${label}"` : "no page on the server"}`);
  },
};

// the cancelled dialog's landing must not release the key before the next press of the same captions
const captureCancelLanded = {
  name: "capture-cancel-landed",
  what: "add a talk's captions, cancel the dialog while the save's answer is held, open it again and paste the same captions, let the first answer land, then press; the board holds one source",
  checks: {
    one: "the server holds exactly one source after the cancelled dialog's save landed and the next dialog pressed the same captions",
    landed: "the next dialog closes on its own answer and the board lists the source",
  },
  run: (t) => landedThenPressed(t, "Race capture landed"),
};
async function landedThenPressed(t, title, fallback = false) {
  let told = false, shown = null;
  const { b, page, dialog, isFinish, second, how } = await cancelAndCaptureAgain(t, title, { fallback, beforeSecondPress: async ({ page, dialog, first, url }) => {
    shown = await dialog.locator(".title").textContent();
    if (fallback && shown !== url) throw new Error(`the next dialog shows ${JSON.stringify(shown)}, not the fallback title: the race this scenario is about did not happen`);
    first.release();
    await first.caught[0].done;
    told = await page.locator(".import-receipt").waitFor({ timeout: 10_000 }).then(() => true, () => false);
  } });
  second.release();
  await second.caught[0].done;
  const closed = await dialog.waitFor({ state: "detached", timeout: 10_000 }).then(() => true, () => false);
  await page.evaluate(() => window.__strataSettled?.());
  await t.net.idle(500);
  const sent = t.net.entries.filter(isFinish);
  const keys = new Set(sent.map((e) => e.headers["idempotency-key"] ?? "(none)")).size;
  t.say(`cancelled by ${how}; ${fallback ? `the next dialog titled ${JSON.stringify(shown)}; ` : ""}${told ? "the first capture landed before the press" : "no receipt for the first capture"}; ${sent.length} save(s) under ${keys} key(s), answered ${sent.map((e) => e.status).join(", ")}`);
  const { rows, label, listed } = await oneListed(t, page, b, closed);
  t.check("one", rows.length === 1, `${rows.length} source(s) on the server after ${sent.length} save(s) of the same captions under ${keys} key(s)`);
  t.check("landed", listed, `the dialog ${closed ? "closed" : "is still open"}; ${label ? `the board ${listed ? "lists" : "does not list"} "${label}"` : "no page on the server"}`);
}

// a re-fetched title (oEmbed fallback or rename) must not change the key: same captions, same capture
const captureTitleDrift = {
  name: "capture-title-drift",
  what: "capture-cancel-landed with the next dialog's link answered by the oEmbed fallback (the link as the title, no author): the same captions under another title; the board holds one source",
  checks: {
    one: "the server holds exactly one source after the next dialog, titled by the oEmbed fallback, pressed the same captions",
    landed: "the next dialog closes on its own answer (not refused 422) and the board lists the source",
  },
  run: (t) => landedThenPressed(t, "Race capture drift", true),
};

// a slow If-Match refusal landing after a newer read must retry over that read, not step the plan back
const planPurposeLate409 = {
  name: "plan-purpose-late-409",
  what: "set the board's purpose over a plan another device changed, its refusal held until the board was read again after that device changed the purpose once more; the server holds the purpose typed and the page shows the server's",
  checks: {
    saved: "the server holds the purpose typed",
    shown: "the page shows the server's purpose",
  },
  async run(t) {
    const b = await board(t, "Race purpose");
    const purposePath = `/api/boards/${b.id}/plan/purpose`;
    const purposeHeld = async () => (await t.api(`/api/boards/${b.id}`)).plan?.purpose ?? "";
    await t.api(purposePath, "PUT", { purpose: "The purpose as first read" });
    const page = await t.open({ latency: true });
    await page.goto(`${t.base}/?board=${b.id}`);
    const box = page.getByRole("textbox", { name: "What is it for?", exact: true });
    await box.waitFor();
    await page.waitForFunction(() => document.querySelector("input.pp-goal")?.value === "The purpose as first read");
    await t.net.idle(400);
    await t.api(purposePath, "PUT", { purpose: "The other device's first purpose" });
    const isPurpose = (e) => e.method === "PUT" && e.path === purposePath;
    const refusal = t.net.hold((e) => isPurpose(e) && e === t.net.entries.find(isPurpose));
    const typed = `The purpose typed here, seed ${t.seed}`;
    await box.fill(typed);
    await box.blur();
    await refusal.arrived(1);
    await t.api(purposePath, "PUT", { purpose: "The other device's second purpose" });
    const boardPath = `/api/boards/${b.id}`;
    const isRead = (e) => e.method === "GET" && (e.path === boardPath || e.path.startsWith(`${boardPath}?`));
    const read = t.net.when(isRead);
    await page.getByRole("navigation", { name: "Strata" }).getByRole("button", { name: "Projects", exact: true }).click();
    await page.locator(".pj-card").filter({ hasText: b.title }).first().click();
    const reread = await read;
    await reread.done;
    const carried = reread.response ? (await reread.response.json()).plan?.purpose : null;
    if (carried !== "The other device's second purpose") throw new Error(`the board read again carried ${JSON.stringify(carried)}, not the other device's second purpose: the interleaving was not pinned`);
    await box.waitFor();
    await sleep(200);
    refusal.release();
    await t.net.idle(600);
    await sleep(800);
    const writes = t.net.entries.filter(isPurpose);
    if (writes[0]?.status !== 409) throw new Error(`the purpose's first write was answered ${writes[0]?.status ?? "never"}, not refused: the plan it was made over was not behind, and the race was not pinned`);
    t.say(`${writes.length} purpose write(s), answered ${writes.map((e) => e.status).join(", ")}`);
    const held = await purposeHeld();
    const shown = await box.inputValue();
    t.check("saved", held === typed, `the server holds ${JSON.stringify(held)}`);
    t.check("shown", shown === held, `the page shows ${JSON.stringify(shown)}, the server ${JSON.stringify(held)}`);
  },
};

// the upload is refused once and its retry held past Enter: the question goes once, with its picture
const imageUploadLate = {
  name: "image-upload-late",
  what: "paste a screenshot into the board's Ask while its upload is refused once (503) and the retry's answer is held; press Enter before it lands",
  checks: {
    carried: "the server holds the question once, with the image it was asked about",
    stored: "the server holds the picture once, under the id the question names",
    shown: "the thread on screen shows the question once, with its picture",
  },
  async run(t) {
    const b = await board(t, "Race image");
    const page = await t.open({ latency: true });
    const upload = "/api/images";
    let refused = 0;
    await page.route((u) => u.pathname.endsWith(upload), async (route, request) => {
      if (request.method() === "POST" && refused === 0) {
        refused++;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "busy — try again" }) });
        return;
      }
      await route.fallback();
    });
    const isUpload = (e) => e.method === "POST" && e.path === upload;
    const held = t.net.hold(isUpload);
    // a source asks under its words; the board's own thread is where a picture is pasted
    await page.goto(`${t.base}/?board=${b.id}`);
    await page.locator(".pp-title").first().waitFor();
    await t.net.idle(400);
    await page.keyboard.press("/");
    const ask = page.locator(".ask .line input");
    // a picture of its own per seed, so the id is new to the room
    await ask.evaluate(async (input, seed) => {
      const c = document.createElement("canvas"); c.width = 640; c.height = 400;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 640, 400);
      g.fillStyle = "#123"; g.font = "28px sans-serif"; g.fillText(`race seed ${seed}`, 30, 60);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const dt = new DataTransfer(); dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, t.seed);
    await page.locator(".ask .att-thumb").waitFor();
    await held.arrived(1);
    const question = `Seed ${t.seed}: what does this picture show?`;
    await ask.fill(question);
    await ask.press("Enter");
    await sleep(300 + Math.floor(t.rng("release")() * 900));
    held.release();
    if (refused !== 1) throw new Error("the upload was never refused: the 503 this scenario is about did not happen");
    const thread = `/api/boards/${b.id}/messages`;
    const until = performance.now() + GRACE_MS + 20_000;      // the slow fake stream's whole reply
    let messages = [];
    for (;;) {
      ({ messages } = await t.api(thread));
      // the board's thread opens with a greeting: wait for the reply to this question
      const q = messages.find((m) => m.role === "user" && m.text.includes(question));
      if ((q && messages.some((m) => m.role !== "user" && m.idx > q.idx)) || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    const asked = messages.filter((m) => m.role === "user" && m.text.includes(question));
    const ids = asked.flatMap((m) => [...m.text.matchAll(/\]\(img:([0-9a-f]{16})\)/g)].map((x) => x[1]));
    t.check("carried", asked.length === 1 && ids.length === 1, `${asked.length} question(s) on the server, naming ${ids.length} image(s)`);
    const rows = ids.length ? Number(t.sql("SELECT COUNT(*) n FROM images WHERE id = ?", ids[0])[0]?.n ?? 0) : 0;
    const reached = t.net.entries.filter(isUpload).length;
    t.check("stored", rows === 1, `${rows} image row(s) under that id; ${reached} upload(s) reached the server`);
    await page.keyboard.press("/");
    const mine = page.locator(".ask .turns .turn.me", { hasText: question });
    const shown = await mine.first().waitFor({ timeout: 5000 }).then(() => true, () => false);
    const count = await mine.count();
    const pictured = shown && await mine.first().locator("img.strata-img").count() === 1;
    t.check("shown", shown && count === 1 && pictured, `the question is on screen ${count} time(s)${shown && !pictured ? ", without its picture" : ""}`);
  },
};

const agentResend = {
  name: "agent-resend",
  what: "an agent's MCP writes whose answers are lost are sent again, some at the same moment, and its upload is cut mid-file and sent again; each lands exactly once",
  checks: {
    once: "a batch sent four times under one key wrote one log line and one question",
    upload: "a file cut mid-upload and sent again became exactly one source",
    duplicate: "asking to upload the same file again names that source instead of making another",
  },
  async run(t) {
    const b = await board(t, "Race agent");
    const { token } = await t.api("/api/agent/tokens", "POST", { name: `race ${t.seed}` });
    let n = 0;
    const call = async (name, args, signal) => {
      const r = await fetch(`${t.base}/mcp`, { method: "POST", signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
      const body = await r.json();
      if (!body.result || body.result.isError) throw new Error(`${name}: ${JSON.stringify(body).slice(0, 200)}`);
      return body.result.content[0].text;
    };
    const lose = (name, args, ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return call(name, args, c.signal).catch(() => null); };
    const line = `Agent race line, seed ${t.seed}.`;
    const batch = { board: b.id, key: `race-apply-${t.seed}-${Date.now().toString(36)}`, ops: [{ op: "append_log", text: line }, { op: "add_question", front: `Race question ${t.seed}?` }] };
    await Promise.all([lose("apply", batch, (t.seed * 7) % 20), lose("apply", batch, 0), call("apply", batch), call("apply", batch)]);
    const log = t.sql("SELECT text FROM board_notes WHERE board_id = ?", b.id)[0]?.text ?? "";
    const asked = t.sql("SELECT COUNT(*) n FROM minted WHERE board_id = ? AND front = ?", b.id, `Race question ${t.seed}?`)[0].n;
    t.check("once", log.split(line).length - 1 === 1 && asked === 1, `${log.split(line).length - 1} log line(s), ${asked} question(s)`);

    const bytes = Buffer.from(`# Race lecture ${t.seed}\n\n${"A cut upload is sent again and lands once. ".repeat(4000)}\n`);
    const file = { name: `race-${t.seed}.md`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const asked1 = await call("request_upload", { board: b.id, key: `race-up-${t.seed}-${Date.now().toString(36)}`, files: [file] });
    const url = /upload_url: (\S+)/.exec(asked1)[1];
    const cut = new AbortController();
    const half = new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, bytes.length >> 1)); setTimeout(() => cut.abort(), 30); } });
    await fetch(url, { method: "PUT", body: half, duplex: "half", signal: cut.signal }).catch(() => null);
    const put = await fetch(url, { method: "PUT", body: bytes });
    if (put.status !== 200) throw new Error(`the resent upload answered ${put.status}: ${(await put.text()).slice(0, 160)}`);
    const until = performance.now() + GRACE_MS * 3;
    let made = [];
    while (performance.now() < until) {
      made = t.sql("SELECT id FROM resources WHERE board_id = ? AND filename = ?", b.id, file.name);
      if (made.length) break;
      await sleep(200);
    }
    await sleep(300);
    made = t.sql("SELECT id FROM resources WHERE board_id = ? AND filename = ?", b.id, file.name);
    t.check("upload", made.length === 1, `${made.length} source(s) named ${file.name}`);
    const again = await call("request_upload", { board: b.id, key: `race-up2-${t.seed}-${Date.now().toString(36)}`, files: [file] });
    t.check("duplicate", made.length === 1 && again.includes(`src_${made[0].id}`) && !again.includes("upload_url"), again.slice(0, 160));
  },
};

const agentRevise = {
  name: "agent-revise",
  what: "an agent revises a page twice under one ref and the bytes land in the wrong order, one PUT cut and resent; the page is revised in place and the later revision wins",
  checks: {
    inplace: "every revision kept the one source and its id",
    latest: "the revision asked for last is the text the source holds",
    highlight: "the reader's highlight on the first version is still there",
    unstudied: "an agent's page arrived without cards and stayed so",
  },
  async run(t) {
    const b = await board(t, "Race revise");
    const { token } = await t.api("/api/agent/tokens", "POST", { name: `race revise ${t.seed}` });
    let n = 0;
    const call = async (name, args) => {
      const r = await fetch(`${t.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
      const body = await r.json();
      if (!body.result || body.result.isError) throw new Error(`${name}: ${JSON.stringify(body).slice(0, 200)}`);
      return body.result.content[0].text;
    };
    const ref = `race-page-${t.seed}`;
    const page = (v) => Buffer.from(`<!doctype html><html><head><script>window.v=${v}</script></head><body><h1>Map</h1><p>Rare names, version ${v} of seed ${t.seed}.</p></body></html>`);
    const ask = async (v) => {
      const bytes = page(v);
      const said = await call("request_upload", { board: b.id, key: `race-rev-${t.seed}-${v}-${Date.now().toString(36)}`, origin: { from: "race", ref },
        files: [{ name: `${ref}.html`, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] });
      return { bytes, url: /upload_url: (\S+)/.exec(said)[1] };
    };
    const landed = async (pred) => {
      const until = performance.now() + GRACE_MS * 3;
      while (performance.now() < until) { if (pred()) return true; await sleep(200); }
      return pred();
    };
    const sources = () => t.sql("SELECT id, text FROM resources WHERE board_id = ?", b.id);
    const first = await ask(1);
    if ((await fetch(first.url, { method: "PUT", body: first.bytes })).status !== 200) throw new Error("the first page did not upload");
    await landed(() => sources().length === 1);
    const rid = sources()[0]?.id;
    if (!rid) throw new Error("the first page never landed");
    await t.api(`/api/boards/${b.id}/marks`, "POST", { resourceId: rid, quote: "Rare names" });

    const second = await ask(2), third = await ask(3);
    const cut = new AbortController();
    const half = new ReadableStream({ start(c) { c.enqueue(third.bytes.subarray(0, third.bytes.length >> 1)); setTimeout(() => cut.abort(), 20); } });
    await fetch(third.url, { method: "PUT", body: half, duplex: "half", signal: cut.signal }).catch(() => null);
    const order = t.seed % 2 ? [third, second] : [second, third];
    for (const r of order) {
      const put = await fetch(r.url, { method: "PUT", body: r.bytes });
      if (put.status !== 200) throw new Error(`a revision answered ${put.status}: ${(await put.text()).slice(0, 160)}`);
    }
    await landed(() => t.sql("SELECT COUNT(*) n FROM imports WHERE board_id = ? AND stage NOT IN ('imported','cancelled','error')", b.id)[0].n === 0);
    const now = sources();
    t.check("inplace", now.length === 1 && now[0].id === rid, `${now.length} source(s); ${now.map((r) => r.id).join(", ")} (was ${rid})`);
    t.check("latest", /version 3 /.test(now[0]?.text ?? ""), (now[0]?.text ?? "").slice(0, 120));
    const marks = t.sql("SELECT COUNT(*) n FROM marks WHERE resource_id = ? AND quote = ?", rid, "Rare names")[0].n;
    t.check("highlight", marks === 1, `${marks} highlight(s)`);
    const trees = t.sql("SELECT status FROM trees WHERE resource_id = ?", rid).map((r) => r.status);
    t.check("unstudied", trees.length > 0 && trees.every((s) => s === "unstudied"), trees.join(", "));
  },
};

// a few pages of real PDF, so the board draws the book; the text the split is chosen over is sent beside it
function tinyPdf(pages) {
  const font = 3 + pages.length * 2;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const at = objs.map((o, i) => { const n = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return n; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  return Buffer.from(`${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, "latin1");
}

// the split's answer is lost and resent under its key, while a keep and a grade race it to the server
const resplitRaces = {
  name: "resplit-races",
  what: "join two sections of a book in the section editor while its answer is lost and resent, as a keep in the section being joined away and a grade race it; the split lands once and no acknowledged keep or grade is lost",
  checks: {
    once: "the server holds the chosen split exactly once: two sections, two pairs, one re-sectioning",
    kept: "every keep the server acknowledged is of a live card, filed where its card is",
    graded: "the grade made during the split is held once, on a card that still exists",
    shown: "the editor closes and the project page lists the book once",
  },
  async run(t) {
    const b = await board(t, "Race resplit");
    const pageText = ["One opens the book. ".repeat(20), "Two is the short middle. ".repeat(10), "Three is the long end. ".repeat(40)];
    const outline = ["One", "Two", "Three"].map((label, id) => ({ id, label, page: id + 1, offset: 0, depth: 0, parent: null }));
    const filename = `race-book-${t.seed}.pdf`;
    const made = await t.api(`/api/boards/${b.id}/resources`, "POST", {
      filename, base64: tinyPdf(["One", "Two", "Three"]).toString("base64"), pageText, importPlan: { outline, starts: [1, 2], excluded: [] },
    });
    const rid = made.id;
    const sections = made.state.sections.filter((s) => s.resourceId === rid);
    const decks = [];
    for (const [i, s] of sections.entries()) {
      await t.api(`/api/boards/${b.id}/resources/${rid}/tree?section=${s.id}`, "PUT", {
        tree: { title: s.label, question: "?", nodes: [{ label: "the part", kind: "concept", anchor: "p. 1", questions: ["What is it?"] }] },
        cards: [1, 2].map((k) => ({ node: "n1", type: "flashcard", source: "p. 1", front: `Race resplit ${i + 1}.${k}: what does part ${i + 1} hold?`, back: "Its own pages." })),
      });
      decks.push((await t.api(`/api/boards/${b.id}/resources/${rid}/tree?section=${s.id}`)).deck);
    }
    const [twoA, twoB] = (await t.api(`/api/decks/${decks[1]}`)).cards;
    await t.api(`/api/decks/${decks[1]}/keeps`, "POST", { add: [twoA.id] });

    const isResplit = (e) => e.method === "PUT" && /\/resources\/[^/]+\/sections$/.test(e.path.split("?")[0]);
    const page = await t.open({ latency: true, lostAck: { match: isResplit, pick: new Set([1]), key: (e) => e.headers?.["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/?board=${b.id}`);
    const name = filename.replace(/\.pdf$/, "");
    const cover = page.locator(".pp-src").filter({ has: page.locator(".pp-sname", { hasText: name }) });
    await cover.hover();
    await cover.locator(".tl-more").click();
    await cover.getByRole("button", { name: "re-distil…", exact: true }).click();
    const editor = page.getByRole("dialog", { name });
    await editor.getByRole("button", { name: "Join unit 3 with previous", exact: true }).click();
    await t.net.idle(300);

    const acked = [twoA.id];
    const keepB = t.api(`/api/decks/${decks[1]}/keeps`, "POST", { add: [twoB.id] }).then(() => acked.push(twoB.id), (e) => t.say(`the racing keep was refused: ${e.message.slice(0, 80)}`));
    const grade = t.api("/api/review/grade", "POST", { requestId: `race-resplit-${t.seed}-${Date.now().toString(36)}`, course: decks[1], card: twoA.id, got: true })
      .then(() => true, (e) => { t.say(`the racing grade was refused: ${e.message.slice(0, 80)}`); return false; });
    await Promise.all([editor.getByRole("button", { name: "Re-distil", exact: true }).click(), keepB, grade]);
    const closed = await editor.waitFor({ state: "detached", timeout: GRACE_MS * 3 }).then(() => true, () => false);
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);

    const secs = t.sql("SELECT id FROM sections WHERE resource_id = ? ORDER BY ord", rid);
    const pairs = t.sql("SELECT COUNT(*) n FROM pairs WHERE board_id = ? AND resource_id = ?", b.id, rid)[0].n;
    const resplits = t.sql("SELECT COUNT(*) n FROM events WHERE event = 'sections_resplit' AND json_extract(props,'$.board') = ?", b.id)[0].n;
    t.check("once", secs.length === 2 && pairs === 2 && resplits === 1 && secs[0].id === sections[0].id && secs[1].id === sections[2].id,
      `${secs.length} sections, ${pairs} pairs, ${resplits} re-sectionings; ids ${secs.map((s) => s.id).join(", ")}`);
    const live = acked.map((id) => t.sql("SELECT k.course kc, c.course cc FROM card_keeps k LEFT JOIN cards c ON c.id = k.id WHERE k.id = ?", id)[0]);
    t.check("kept", live.every((r) => r && r.cc && r.kc === r.cc),
      acked.map((id, i) => `${id.split("/").pop().slice(0, 24)}: ${live[i] ? `kept in ${live[i].kc}, card ${live[i].cc ?? "gone"}` : "not kept"}`).join("; "));
    const graded = await grade;
    const grades = t.sql("SELECT COUNT(*) n FROM events WHERE event = 'card_grade' AND json_extract(props,'$.card') = ?", twoA.id)[0].n;
    const alive = t.sql("SELECT COUNT(*) n FROM cards WHERE id = ?", twoA.id)[0].n;
    t.check("graded", (graded ? grades === 1 : grades === 0) && alive === 1, `${grades} grade(s) held (acknowledged: ${graded}); card ${alive ? "live" : "gone"}`);
    const listed = await page.locator(".pp-sname", { hasText: name }).count();
    t.check("shown", closed && listed === 1, `editor ${closed ? "closed" : "still open"}; the page lists the book ${listed} time(s)`);
  },
};

const dashboardTriage = {
  name: "dashboard-triage",
  what: "an agent's inbox batch is sent four times with answers lost; you send each item on while the first two keeps lose their answers, then move a task to to-do from its row; each lands exactly once",
  checks: {
    agent: "the batch sent four times under one key made three inbox items",
    kept: "each item was kept once as a thread, and nothing is left in the inbox",
    moved: "the moved task is in to-do on the server",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    const { token } = await t.api("/api/agent/tokens", "POST", { name: `race ${t.seed}`, write: true });
    let n = 0;
    const call = async (args, signal) => {
      const r = await fetch(`${t.base}/mcp`, { method: "POST", signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: "dashboard_add_items", arguments: args } }) });
      const body = await r.json();
      if (!body.result || body.result.isError) throw new Error(`dashboard_add_items: ${JSON.stringify(body).slice(0, 200)}`);
      return body.result.content[0].text;
    };
    const lose = (args, ms) => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return call(args, c.signal).catch(() => null); };
    const from = { source: `Slack · race transcript ${tag}` };
    const titles = [`Race task ${tag}`, `Race second ${tag}`, `Race third ${tag}`];
    const batch = { key: `race-dash-${tag}`, items: titles.map((title) => ({ title, context: "Under loss.", from })) };
    await Promise.all([lose(batch, (t.seed * 7) % 20), lose(batch, 0), call(batch), call(batch)]);
    const items = t.sql("SELECT COUNT(*) n FROM dashboard_inbox WHERE json_extract(item,'$.from.source') = ?", from.source)[0].n;
    t.check("agent", items === 3, `${items} inbox items from one batch`);

    const keeps = (e) => e.method === "POST" && /\/api\/dashboard\/inbox\/[^/]+\/keep$/.test(e.path);
    const page = await t.open({ latency: true, lostAck: { match: keeps, pick: new Set([1, 2]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/dashboard?view=triage&sub=inbox`);
    await page.getByRole("tab", { name: /^Work/ }).click();
    for (const name of titles) {
      await page.locator(".tr-row, .tr-card.in", { hasText: name }).first().click();
      await page.locator(".tr-card.in", { hasText: name }).getByRole("button", { name: "Keep in to-do" }).click();
    }
    const until = performance.now() + GRACE_MS * 2;
    let open = 3;
    for (;;) {
      open = t.sql("SELECT COUNT(*) n FROM dashboard_inbox WHERE handled_at IS NULL AND json_extract(item,'$.from.source') = ?", from.source)[0].n;
      if (open === 0 || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    const counts = titles.map((title) => t.sql("SELECT COUNT(*) n FROM dashboard_tasks WHERE title = ?", title)[0].n);
    t.check("kept", open === 0 && counts.every((n) => n === 1), `${open} still open; threads: ${counts.join(", ")}`);

    await page.locator("header.dh").getByRole("button", { name: /^To-do/ }).click();
    const row = page.locator(".r", { hasText: `Race task ${tag}` });
    await row.waitFor();
    await row.locator(".t").click();
    await page.locator(".tr-card.open").getByRole("button", { name: "Think it through" }).click();
    const until2 = performance.now() + GRACE_MS;
    let stage = "";
    for (;;) {
      stage = t.sql("SELECT stage FROM dashboard_tasks WHERE title = ?", `Race task ${tag}`)[0]?.stage ?? "";
      if (stage === "thinking" || performance.now() > until2) break;
      await sleep(250);
    }
    t.check("moved", stage === "thinking", `the task is "${stage}" on the server`);
  },
};

const dashboardWrites = {
  name: "dashboard-writes",
  what: "on a lossy wire you open a to-do thread, type a title and notes, then take it to Thinking, with the first answers lost; each write lands once",
  checks: {
    moved: "the thread is in thinking on the server",
    title: "the title typed in the doc, closed before its save, is the title on the server",
    notes: "the notes typed in the doc are on the server, once",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    const id = `t_pin${t.seed}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_]/g, "");
    await t.api("/api/dashboard/tasks", "POST", { id, title: `Race pin ${tag}`, body: "Picked under loss.", area: "work" });
    const lost = (e) => e.write && /\/api\/dashboard\/tasks\/[^/]+$/.test(e.path) && e.method !== "POST";
    const page = await t.open({ latency: true, lostAck: { match: lost, pick: new Set([1, 2, 3]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/dashboard?view=triage&sub=todo`);
    await page.getByRole("tab", { name: /^Work/ }).click();
    await page.locator("header.dh").getByRole("button", { name: /^To-do/ }).click();
    const moved = page.locator(".r", { hasText: `Race pin ${tag}` });
    await moved.waitFor();
    await moved.locator(".t").click();
    const title = page.locator(".tr-card.open .dtitle");
    await title.focus();
    await page.keyboard.press("Control+End");
    await title.pressSequentially(" edited", { delay: 15 });
    const notes = page.locator(".tr-card.open .dbody[contenteditable=true]");
    await notes.focus();
    await page.keyboard.press("Control+End");
    // the editor reads a caret the browser moved on the next selectionchange, a frame after the key
    await sleep(100);
    await page.keyboard.type(`\nNotes ${tag}`, { delay: 15 });
    await page.locator(".tr-card.open").getByRole("button", { name: "Think it through" }).click();

    const until = performance.now() + GRACE_MS * 2;
    let rowDb = null;
    for (;;) {
      rowDb = t.sql("SELECT stage, title, body FROM dashboard_tasks WHERE id = ?", id)[0] ?? null;
      if ((rowDb && rowDb.stage === "thinking" && rowDb.title === `Race pin ${tag} edited` && rowDb.body === `Picked under loss.\n\nNotes ${tag}`) || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    t.check("moved", rowDb?.stage === "thinking", `stage ${rowDb?.stage}`);
    t.check("title", rowDb?.title === `Race pin ${tag} edited`, `the title is ${JSON.stringify(rowDb?.title)}`);
    t.check("notes", rowDb?.body === `Picked under loss.\n\nNotes ${tag}`, `the notes are ${JSON.stringify(rowDb?.body?.slice(0, 120))}`);
  },
};

const dashboardAdd = {
  name: "dashboard-add",
  what: "you add two threads to to-do on a lossy wire, the first add's answer lost, then take the second to Thinking; each thread is on the server once and the move lands",
  checks: {
    added: "each thread added from to-do is on the server once",
    moved: "the second thread, moved while its add was still settling, is in thinking",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    const titles = [`Race add ${tag} one`, `Race add ${tag} two`];
    const adds = (e) => e.write && /\/api\/dashboard\/tasks(\/[^/]+)?$/.test(e.path);
    const page = await t.open({ latency: true, lostAck: { match: adds, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/dashboard?view=triage&sub=todo`);
    await page.locator("header.dh").getByRole("button", { name: /^To-do/ }).click();
    for (const title of titles) {
      await page.locator("#addIn").fill(title);
      await page.getByRole("button", { name: "Add", exact: true }).click();
    }
    // a thread you add opens, ready for its prompt; the second is the one open now
    await page.locator(".tr-card.open").getByRole("button", { name: "Think it through" }).click();
    const until = performance.now() + GRACE_MS * 2;
    let rows = [];
    for (;;) {
      rows = titles.map((title) => t.sql("SELECT stage FROM dashboard_tasks WHERE title = ?", title));
      if ((rows.every((r) => r.length === 1) && rows[1][0].stage === "thinking") || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    rows = titles.map((title) => t.sql("SELECT stage FROM dashboard_tasks WHERE title = ?", title));
    t.check("added", rows.every((r) => r.length === 1), rows.map((r, i) => `${titles[i]}: ${r.length} row(s) ${r.map((x) => x.stage).join(",")}`).join("; "));
    t.check("moved", rows[1][0]?.stage === "thinking", `stage ${rows[1][0]?.stage}`);
  },
};

const dispatchPress = {
  name: "dispatch-press",
  what: "in Dispatch you press Send on one thread's page in Decide and Reopen then Send on another's in Finish, on a lossy wire with the first press's answer lost; each press is stored once, and Claude's next page lands once, where its post says",
  checks: {
    once: "each press is on the server exactly once",
    moved: "both threads were with Claude once pressed",
    shown: "the pane no longer lists either thread where it was pressed",
    landed: "the next post lands each thread once, in the stage its lands names",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    const { token } = await t.api("/api/agent/tokens", "POST", { name: `race dispatch ${t.seed}`, write: true });
    let n = 0;
    const post = async (id, html, lands) => {
      const r = await fetch(`${t.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: "dashboard_post", arguments: { key: `race-post-${tag}-${n}`, id, page: html, ...(lands ? { lands } : {}) } } }) });
      const body = await r.json();
      if (!body.result || body.result.isError) throw new Error(`dashboard_post: ${JSON.stringify(body).slice(0, 200)}`);
    };
    const ids = [0, 1].map((i) => `t_dsp${i}${t.seed}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_]/g, ""));
    const titles = [`Race send ${tag}`, `Race reopen ${tag}`];
    const first = ["decide", "finish"], next = ["review", "decide"];
    for (const [i, id] of ids.entries()) {
      await t.api("/api/dashboard/tasks", "POST", { id, title: titles[i], body: "Under loss.", area: "work" });
      await t.api(`/api/dashboard/tasks/${id}/send`, "POST", {});
      await post(id, `<!doctype html><html><body><h1>${titles[i]}</h1><p>A page to answer.</p></body></html>`, first[i]);
    }
    const presses = (e) => e.write && /\/api\/dashboard\/tasks\/[^/]+\/press$/.test(e.path);
    const page = await t.open({ latency: true, lostAck: { match: presses, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    const pressOn = async (view, title, reopen) => {
      await page.goto(`${t.base}/dispatch?view=${view}`);
      const card = page.locator(".ws-card", { hasText: title });
      await card.first().waitFor();
      if (!(await card.first().evaluate((el) => el.classList.contains("open")))) await card.first().click();
      const open = page.locator(".ws-card.open", { hasText: title });
      if (reopen) await open.getByRole("button", { name: "Reopen", exact: true }).click();
      await open.getByRole("button", { name: "Send", exact: true }).click();
      await page.evaluate(() => window.__strataSettled?.());
      return (await page.locator(".ws-list").textContent()) ?? "";
    };
    const listed = [await pressOn("decide", titles[0], false), await pressOn("finish", titles[1], true)];
    const pressed = (id) => t.sql("SELECT kind, stage FROM dashboard_presses WHERE task_id = ? AND version IS NOT NULL", id);
    const until = performance.now() + GRACE_MS * 2;
    let rows = [];
    for (;;) {
      rows = ids.map(pressed);
      if (rows.every((r) => r.length >= 1) || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    rows = ids.map(pressed);
    const stages = ids.map((id) => t.sql("SELECT stage FROM dashboard_tasks WHERE id = ?", id)[0]?.stage);
    t.check("once", rows.every((r, i) => r.length === 1 && r[0].kind === "send" && r[0].stage === first[i]), rows.map((r, i) => `${titles[i]}: ${r.map((x) => `${x.kind}@${x.stage}`).join(",") || "none"}`).join("; "));
    t.check("moved", stages.every((s) => s === "implementing"), stages.join(", "));
    t.check("shown", listed.every((l, i) => !l.includes(titles[i])), listed.map((l) => JSON.stringify(l.slice(0, 120))).join(" · "));
    for (const [i, id] of ids.entries()) await post(id, `<!doctype html><html><body><h1>${titles[i]} v2</h1></body></html>`, next[i]);
    const after = ids.map((id) => ({ stage: t.sql("SELECT stage FROM dashboard_tasks WHERE id = ?", id)[0]?.stage, landed: t.sql("SELECT landed FROM dashboard_versions WHERE task_id = ? ORDER BY n", id).map((r) => r.landed) }));
    t.check("landed", after.every((a, i) => a.stage === next[i] && a.landed.length === 2 && a.landed[1] === next[i]), after.map((a) => `${a.stage} [${a.landed.join(",")}]`).join("; "));
  },
};

// two replies under a note, the first one's answer lost: each lands once, in the order written
const noteReplies = {
  name: "note-replies",
  what: "open a note's fold and send two replies back to back on a slow wire, losing the first reply's answer; the server holds each reply once, in order, and the fold shows the same",
  checks: {
    once: "the server holds exactly the two replies, each once",
    order: "they are in the order they were written",
    shown: "the fold shows the two replies in that order",
  },
  async run(t) {
    const b = await board(t, "Race note replies");
    const unique = "A reply sent twice over a lossy wire is still one reply.";
    const s = await prose(t, b.id, "race-replies.md", essay("Replies under a note", unique));
    const start = essay("Replies under a note", unique).indexOf("still one reply");
    await t.api(`/api/boards/${b.id}/marks`, "POST", { resourceId: s.rid, start, end: start + "still one reply".length, quote: "still one reply", note: `Why it matters, seed ${t.seed}.` });
    const isReply = (e) => e.method === "POST" && /\/marks\/[^/]+\/replies$/.test(e.path.split("?")[0]);
    const page = await t.open({ latency: true, lostAck: { match: isReply, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(readerUrl(t, b.id, s));
    await proseShown(page, unique);
    await page.locator(".ftick").first().click();
    const field = page.locator(".fold .fi-field").first();
    const said = [`first, seed ${t.seed}`, `second, seed ${t.seed}`];
    for (const line of said) { await field.fill(line); await field.press("Enter"); }
    await page.evaluate(() => window.__strataSettled?.());
    const until = performance.now() + GRACE_MS;
    let rows = [];
    for (;;) {
      rows = t.sql("SELECT text FROM mark_replies WHERE board_id = ? ORDER BY created_at, id", b.id);
      if (rows.length >= 2 || performance.now() > until) break;
      await sleep(200);
    }
    await t.net.idle(500);
    rows = t.sql("SELECT text FROM mark_replies WHERE board_id = ? ORDER BY created_at, id", b.id).map((r) => r.text);
    t.check("once", rows.length === 2 && new Set(rows).size === 2, `server: ${rows.join(" · ")}`);
    t.check("order", rows.join("|") === said.join("|"), `server: ${rows.join(" · ")}`);
    const shown = await page.locator(".fold .fi-say").allTextContents();
    t.check("shown", shown.join("|") === said.join("|"), `fold: ${shown.join(" · ")}`);
  },
};

// a card written under a selection is saved by the same draft key however often the wire loses its answer
const selectionCard = {
  name: "selection-card",
  what: "pick words in a source, choose Card, write it in the fold under them and keep it; the create's answer is lost, so it is sent again; the board holds one card, anchored to those words",
  checks: {
    one: "the server holds one card from the draft",
    anchored: "its source is the picked words, as a quote",
    gone: "the draft left the fold once it was kept",
  },
  async run(t) {
    const b = await board(t, "Race selection card");
    const unique = "A card written under the words it asks about stays anchored to them.";
    const phrase = "stays anchored to them";
    const s = await prose(t, b.id, "race-selection-card.md", essay("Cards from a selection", unique));
    const isCreate = (e) => e.method === "POST" && e.path === `/api/boards/${b.id}/minted`;
    const page = await t.open({ latency: true, lostAck: { match: isCreate, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(readerUrl(t, b.id, s));
    await proseShown(page, unique);
    await t.net.idle(400);
    const at = await phraseAt(page, phrase);
    await page.mouse.move(at.x0, at.y0);
    await page.mouse.down();
    await page.mouse.move(at.x1, at.y1, { steps: 4 });
    await page.mouse.up();
    await page.locator(".selmenu").getByRole("button", { name: "Card", exact: true }).click();
    const draft = page.locator(".fold .fi.draft");
    await draft.waitFor();
    const front = `Race card from words, seed ${t.seed}: where is it asked?`;
    await draft.locator(".fi-front").fill(front);
    await draft.locator(".fi-back").fill("Under the words it was written from.");
    await draft.locator(".fi-keep").click();
    const gone = await draft.waitFor({ state: "detached", timeout: GRACE_MS }).then(() => true, () => false);
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(500);
    const sent = t.net.entries.filter(isCreate);
    t.say(`${sent.length} POST(s): ${sent.map((e) => `${e.outcome} ${e.status}`).join(", ")}`);
    if (!sent.some((e) => e.outcome === "lost-ack")) throw new Error("no create's answer was lost: the race this scenario is about did not happen");
    const rows = t.sql("SELECT front, source FROM minted WHERE board_id = ?", b.id);
    t.check("one", rows.length === 1 && squash(rows[0].front) === squash(front), `${rows.length} card(s) on the server`);
    const quote = (() => { try { return JSON.parse(String(rows[0]?.source ?? "").replace(/^.*?quote:\s*/, "")); } catch { return ""; } })();
    t.check("anchored", squash(quote) === squash(phrase), `source ${JSON.stringify(rows[0]?.source ?? null)}`);
    t.check("gone", gone, gone ? undefined : "the draft is still in the fold");
  },
};

const dashboardTyping = {
  name: "dashboard-typing",
  what: "type a list into a Thinking doc with pauses that each save, while the saves answer late and out of order and one answer is lost; the field never loses a key, and the server ends with exactly what was typed",
  checks: {
    field: "after every pause the field holds exactly what was typed so far",
    focus: "the notes keep focus through every save",
    server: "the server holds exactly what was typed, spaces and newlines included",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    const id = `t_typ${t.seed}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_]/g, "");
    await t.api("/api/dashboard/tasks", "POST", { id, title: `Race typing ${tag}`, body: "", area: "work", stage: "thinking" });
    const isSave = (e) => e.write && e.method === "PATCH" && e.path === `/api/dashboard/tasks/${id}`;
    const page = await t.open({ latency: true, reorder: { writes: true }, lostAck: { match: isSave, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/dashboard?view=thinking`);
    await page.locator(".ws-list").getByText(`Race typing ${tag}`).click();
    await page.locator(".dbody[contenteditable=true]").waitFor();
    await page.getByRole("textbox", { name: "Notes" }).click();
    // what the Writer shows, items as "- " and blocks a blank line apart; an Enter opens the next item before it is typed
    const shown = () => page.evaluate(() => {
      const walk = (x) => x.type === "text" ? x.text : x.type === "bulletList" ? x.content.map((li) => "- " + walk(li)).join("\n") : (x.content ?? []).map(walk).join(x.type === "doc" ? "\n\n" : "");
      return walk(document.querySelector(".dbody").editor.getJSON());
    }).catch(() => null);
    const parts = [["- buy tape", "- buy tape"], ["\n", "- buy tape\n- "], ["- fetch poster ", "- buy tape\n- fetch poster "], ["\n", "- buy tape\n- fetch poster \n- "],
      ["- ", "- buy tape\n- fetch poster \n- "], ["glue", "- buy tape\n- fetch poster \n- glue"], ["\n\n", "- buy tape\n- fetch poster \n- glue\n\n"],
      ["Then ", "- buy tape\n- fetch poster \n- glue\n\nThen "], ["hang it.", "- buy tape\n- fetch poster \n- glue\n\nThen hang it."]];
    const typed = parts.at(-1)[1];
    const pause = t.rng("pause");
    let fieldOk = true, focusOk = true, at = "";
    for (const [part, want] of parts) {
      await page.keyboard.type(part, { delay: 10 });
      await sleep(750 + Math.floor(pause() * 900));
      const now = await shown();
      if (fieldOk && now !== want) { fieldOk = false; at = JSON.stringify(now); }
      if (focusOk && !(await page.evaluate(() => document.activeElement?.classList.contains("dbody")))) focusOk = false;
    }
    await page.keyboard.press("Tab");
    const until = performance.now() + GRACE_MS * 2;
    let body = null;
    for (;;) {
      body = t.sql("SELECT body FROM dashboard_tasks WHERE id = ?", id)[0]?.body ?? null;
      if (body === typed || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    if (!t.net.entries.filter(isSave).some((e) => e.outcome === "lost-ack")) throw new Error("no save answer was lost: the race this scenario is about did not happen");
    t.check("field", fieldOk, fieldOk ? undefined : `the field held ${at}`);
    t.check("focus", focusOk);
    t.check("server", body === typed, `the server holds ${JSON.stringify(body)}`);
  },
};

// Two tabs write the notepad at once, one on the dashboard and one in the room: the second save is a 409, and
// the merge it sends instead must keep both lines, each once.
const padTwoTabs = {
  name: "pad-two-tabs",
  checks: {
    both: "the notepad keeps the line each tab wrote",
    once: "no line is saved twice",
    shown: "opened again, each tab shows every line",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    await t.api("/api/dashboard/pad", "PUT", { text: `- seeded ${tag}\n` });
    const isPad = (e) => e.write && e.path === "/api/dashboard/pad";
    const page = await t.open({ latency: true, reorder: { writes: true } });
    const { page: other, net: otherNet } = await t.tab({ latency: true });
    const openPad = async (p) => {
      await p.getByRole("button", { name: "Notepad", exact: true }).click();
      const ed = p.locator(".pad-text[contenteditable=true]");
      await ed.waitFor();
      await p.waitForFunction(() => document.activeElement?.classList.contains("pad-text"));
      return ed;
    };
    await page.goto(`${t.base}/dashboard`);
    await other.goto(`${t.base}/`);
    await openPad(page);
    await openPad(other);
    await page.keyboard.press("Enter");
    await page.keyboard.type(`from the dashboard ${tag}`, { delay: 10 });
    await other.keyboard.press("Enter");
    await other.keyboard.type(`from the room ${tag}`, { delay: 10 });
    await page.keyboard.press("Escape");
    await other.locator(".pad-x").click();
    const lines = [`seeded ${tag}`, `from the dashboard ${tag}`, `from the room ${tag}`];
    const until = performance.now() + GRACE_MS * 2;
    let text = "";
    for (;;) {
      text = t.sql("SELECT text FROM dashboard_pad WHERE id = 1")[0]?.text ?? "";
      if (lines.every((l) => text.includes(l)) || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    const writes = [...t.net.entries, ...otherNet.entries].filter(isPad);
    t.say(`pad writes: ${writes.map((e) => e.status ?? e.outcome).join(", ")}`);
    if (!writes.some((e) => e.status === 409)) throw new Error("no notepad write was refused: the race this scenario is about did not happen");
    const count = (l) => text.split(l).length - 1;
    t.check("both", lines.every((l) => count(l) >= 1), `the notepad holds ${JSON.stringify(text.slice(0, 200))}`);
    t.check("once", lines.every((l) => count(l) <= 1), `the notepad holds ${JSON.stringify(text.slice(0, 200))}`);
    const seen = [];
    for (const p of [page, other]) {
      await p.getByRole("button", { name: "Notepad", exact: true }).click();
      const ed = p.locator(".pad-text[contenteditable=true]");
      await ed.waitFor();
      const by = performance.now() + GRACE_MS;
      let now = "";
      while (!lines.every((l) => now.includes(l)) && performance.now() < by) { now = await ed.innerText(); await sleep(200); }
      seen.push(now);
    }
    t.check("shown", seen.every((now) => lines.every((l) => now.includes(l))), `the tabs show ${JSON.stringify(seen)}`);
  },
};

export const scenarios = [highlightDuringRefresh, planDoubleMove, drillGrades, reviewGrades, pageDeleteSource, pageDeleteLastSource, chatSwitch, sourceRename503, keepsToggle,
  planThreeMoves, unitDateTwice, markNoteDelete, captureLostAnswer, captureCancelAgain, captureCancelLost, captureCancelLanded, captureTitleDrift, chatStreamCut, cardEditLost, authoredTwice, planPurposeLate409, imageUploadLate, agentResend, agentRevise, pageStateSaves, liveNotes, liveNoteRemove, noteReplies, selectionCard, resplitRaces, dashboardTriage, dashboardWrites, dashboardAdd, dashboardTyping, dispatchPress, padTwoTabs];
