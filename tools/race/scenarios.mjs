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

const notesRoundtrip = {
  name: "notes-roundtrip",
  what: "type the board's log in bursts while saves answer late and out of order; leave and reopen — the server has the last text, and \"saved\" was never shown for text it did not have",
  checks: {
    last: "the server holds the last text typed",
    reopened: "the reopened board shows it",
    saved: "\"saved\" was never shown for text the server did not have",
  },
  async run(t) {
    const b = await board(t, "Race notes");
    const page = await t.open({ latency: true, reorder: { writes: true } });
    const isSave = (e) => e.method === "PUT" && e.path === `/api/boards/${b.id}/notes`;
    // each time the log says "saved", compare its box with what the server holds
    const claims = [];
    await page.exposeBinding("__raceSaved", (_src, shown) => {
      const held = t.sql("SELECT text FROM board_notes WHERE board_id = ?", b.id)[0]?.text ?? "";
      claims.push({ shown, held });
    });
    await page.goto(`${t.base}/?board=${b.id}`);
    const log = page.locator("textarea.note-edit");
    await log.waitFor();
    await page.evaluate(() => {
      let was = document.querySelector(".note-head .saved")?.textContent ?? null;
      new MutationObserver(() => {
        const said = document.querySelector(".note-head .saved")?.textContent ?? null;
        const box = document.querySelector("textarea.note-edit");
        if (said === "saved" && was !== "saved" && box) window.__raceSaved(box.value);
        was = said;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const words = ["ledger", "margin", "quorum", "lattice", "harbor", "cipher", "meadow", "anvil", "tundra", "prism"];
    const dice = t.rng("words");
    const burst = (n) => Array.from({ length: n }, () => words[Math.floor(dice() * words.length)]).join(" ") + ". ";
    // the save's answer is pinned to land in a pause shorter than the debounce, not left to the dice
    const holdNextSave = () => {
      const from = t.net.seq;
      return t.net.hold((e) => isSave(e) && e === t.net.entries.find((x) => x.id > from && isSave(x)));
    };
    await log.click();
    let typed = "", out = null;
    for (let i = 0; i < 3; i++) {
      const text = burst(5 + Math.floor(dice() * 4));
      const cut = text.indexOf(" ", Math.floor(text.length / 2)) + 1;
      const hold = i < 2 ? holdNextSave() : null;
      const leaves = i < 2 ? t.net.when(isSave) : null;
      let rest = text.slice(cut);
      await log.pressSequentially(text.slice(0, cut), { delay: 40 });
      if (out) {
        let parked = false;
        out.hold.arrived(1).then(() => { parked = true; }, () => {});
        while (!parked && rest.length > 1) { await log.pressSequentially(rest[0]); rest = rest.slice(1); await sleep(40); }
        await out.hold.arrived(1);
        out.hold.release();
        await out.save.done;
        await sleep(400);
      }
      await log.pressSequentially(rest, { delay: 40 });
      typed += text;
      out = hold ? { hold, save: await leaves } : null;
    }
    await page.getByRole("button", { name: "‹ All boards" }).click();
    const boards = page.getByRole("button", { name: /^All boards(?:\s|$)/ });
    await boards.waitFor();
    await t.net.idle(500);
    if (await boards.getAttribute("aria-expanded") !== "true") await boards.click();
    await page.getByRole("region", { name: "All boards", exact: true }).getByRole("button", { name: b.title, exact: true }).click();
    await page.locator(".note-head").waitFor();
    await t.net.idle(500);
    const held = t.sql("SELECT text FROM board_notes WHERE board_id = ?", b.id)[0]?.text ?? "";
    const shownNow = await page.evaluate(() => (document.querySelector("textarea.note-edit")?.value
      ?? document.querySelector(".note-read")?.innerText ?? ""));
    t.check("last", squash(held) === squash(typed), `server has ${JSON.stringify(squash(held).slice(-60))}`);
    t.check("reopened", squash(shownNow) === squash(typed), `page shows ${JSON.stringify(squash(shownNow).slice(-60))}`);
    const lies = claims.filter((c) => c.shown !== c.held);
    t.check("saved", !lies.length,
      lies.length ? `${lies.length} of ${claims.length} — box ${JSON.stringify(lies[0].shown.slice(-40))}, server ${JSON.stringify(lies[0].held.slice(-40))}` : "");
  },
};

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
  what: "move one milestone down twice, quickly, while plan answers come back out of order; the order on screen is the server's",
  checks: {
    applied: "the server applied both moves",
    order: "the page shows the server's order",
  },
  async run(t) {
    const b = await board(t, "Race plan");
    const names = ["Alpha milestone", "Bravo milestone", "Charlie milestone"];
    for (const name of names) await t.api(`/api/boards/${b.id}/plan/milestones`, "POST", { name });
    const page = await t.open({ latency: true, reorder: { writes: true } });
    await page.goto(`${t.base}/?board=${b.id}`);
    const rows = page.locator("ol.bp-check > li");
    await rows.nth(2).waitFor();
    await t.net.idle(400);
    const order = () => page.evaluate(() => [...document.querySelectorAll("ol.bp-check > li input.bp-mname")].map((i) => i.value));
    const moveLater = async (name) => {
      const i = (await order()).indexOf(name);
      if (i < 0) throw new Error(`${name} is not on the page`);
      await rows.nth(i).getByRole("button", { name: "Move later", exact: true }).click();
    };
    // hold the first move's answer across the second gesture, so the interleaving does not depend on load
    const isMove = (e) => e.method === "PATCH" && e.path.startsWith(`/api/boards/${b.id}/plan/milestones/`);
    const firstAnswer = t.net.hold((e) => isMove(e) && e === t.net.entries.find(isMove));
    const second = t.net.when((e) => isMove(e) && e.body?.move === 1 && t.net.entries.filter(isMove).length === 2);
    const shownAt = (want, i) => page.waitForFunction(({ want, i }) => [...document.querySelectorAll("ol.bp-check > li input.bp-mname")].map((el) => el.value)[i] === want, { want, i });
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
    const byOrd = (plan) => plan.milestones.slice().sort((x, y) => x.ord - y.ord).map((m) => m.name);
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

// several deletes leave at once and answer out of order: no older answer may bring a deleted source back
const selectSeveral = {
  name: "select-several",
  what: "on the board page, select three of four sources and move them into a group, then select two and delete them at once while their answers come back out of order",
  checks: {
    grouped: "the server holds the three in the group, in the order they stand in the list",
    deleted: "the server holds neither deleted source and both kept ones",
    rail: "the rail lists the two kept sources and neither deleted one",
  },
  async run(t) {
    const b = await board(t, "Race select");
    const made = [];
    for (const n of ["one", "two", "three", "four"]) {
      made.push(await prose(t, b.id, `race-pick-${n}-${t.seed}.md`, essay(`Picked source ${n}`, `This is source ${n} of the selection.`)));
    }
    const { id: gid } = await t.api(`/api/boards/${b.id}/plan/groups`, "POST", { name: "Picked group" });
    const page = await t.open({ latency: true, reorder: { writes: true } });
    await page.goto(`${t.base}/?board=${b.id}`);
    const rail = page.locator(".bp-rail");
    const item = (s) => rail.locator(".bp-it", { hasText: s.label }).first();
    for (const s of made) await item(s).waitFor();
    await t.net.idle(400);

    const [one, two, three, four] = made;
    await rail.getByRole("button", { name: "Select several", exact: true }).click();
    await item(one).click();
    await item(three).click({ modifiers: ["Shift"] });
    await page.getByLabel("Move to group").selectOption({ label: "Picked group" });
    await t.net.idle(600);
    const grouped = (plan) => Object.entries(plan.places || {}).filter(([, pl]) => pl.group === gid)
      .sort((x, y) => x[1].ord - y[1].ord).map(([it]) => it);
    const inGroup = grouped((await t.api(`/api/boards/${b.id}`)).plan);
    const want = [one, two, three].map((s) => s.rid);
    t.check("grouped", inGroup.join() === want.join(), `group holds ${inGroup.join(", ") || "nothing"}; wanted ${want.join(", ")}`);

    await item(one).click({ modifiers: ["ControlOrMeta"] });
    await item(three).click({ modifiers: ["ControlOrMeta"] });
    await page.getByRole("button", { name: "Delete 2", exact: true }).click();
    await page.getByRole("button", { name: "Delete 2 and all their cards?", exact: true }).click();
    await t.net.idle(800);
    await sleep(800);

    const state = await t.api(`/api/boards/${b.id}`);
    const held = state.resources.map((r) => r.id);
    t.check("deleted", !held.includes(one.rid) && !held.includes(three.rid) && held.includes(two.rid) && held.includes(four.rid),
      `server holds ${made.filter((s) => held.includes(s.rid)).map((s) => s.label).join(" · ")}`);
    const listed = (await rail.locator(".bp-it").allInnerTexts()).map(squash);
    const has = (s) => listed.some((x) => x.includes(s.label));
    t.check("rail", has(two) && has(four) && !has(one) && !has(three), `rail: ${listed.join(" · ")}`);
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
    what: `open a source (the ${last ? "last" : "first"} of two, each with a deck), open the library over it, delete that source there, close the library; the room is back on the board's home and shows nothing of it`,
    checks: {
      reader: "the reader no longer shows the deleted source",
      rail: "the board page no longer lists it",
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
      await page.getByRole("button", { name: "boards", exact: true }).click();
      const library = page.getByRole("region", { name: "Your library" });
      const row = library.locator(".rg-row").filter({ has: page.getByRole("link", { name: doomed.filename, exact: true }) });
      await row.getByRole("button", { name: `Actions for ${doomed.filename}`, exact: true }).click();
      await row.getByRole("menuitem", { name: "delete", exact: true }).click();
      await row.getByRole("menuitem", { name: "delete this source?", exact: true }).click();
      await row.waitFor({ state: "detached" });
      await t.net.idle(500);
      await page.getByRole("button", { name: "Close library", exact: true }).click();
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
      if (!await page.locator(".bp-rail").isVisible()) await page.keyboard.press("h");
      await page.locator(".bp-rail").waitFor();
      const rail = await page.locator(".bp-rail .bp-it").allInnerTexts();
      t.check("rail", !rail.some((x) => x.includes(doomed.label)), `rail: ${rail.map(squash).join(" · ")}`);
    },
  };
}
const launcherDeleteSource = deleteOpenSource({ name: "launcher-delete-source", last: false });
const launcherDeleteLastSource = deleteOpenSource({ name: "launcher-delete-last-source", last: true });

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
      await page.locator(".bp-rail .bp-it", { hasText: s.label }).first().click();
      await page.locator(".bp-cover button.bp-btn.primary").click();
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

const notesLostSave = {
  name: "notes-lost-save",
  what: "type into the board's log and leave at once; the save made on leaving is dropped by the wire — the server still ends up with what was typed",
  checks: {
    held: "the server holds everything typed",
  },
  async run(t) {
    const b = await board(t, "Race lost save");
    const state = { leaving: false };
    const isLeavingSave = (e) => e.method === "PUT" && e.path === `/api/boards/${b.id}/notes` && state.leaving;
    const page = await t.open({ latency: true, drop: { match: isLeavingSave, pick: new Set([1]) } });
    await page.goto(`${t.base}/?board=${b.id}`);
    const log = page.locator("textarea.note-edit");
    await log.waitFor();
    await log.click();
    const first = "The first line of the log reaches the server. ";
    const saved = t.net.when((e) => e.method === "PUT" && e.path === `/api/boards/${b.id}/notes`);
    await log.pressSequentially(first, { delay: 20 });
    await (await saved).done;
    await page.locator(".note-head .saved", { hasText: "saved" }).waitFor();
    const second = "The second is typed and the board left straight after.";
    // leave inside the 700 ms debounce with a raw click, so the blur's save is the only save of the last words
    const away = await page.getByRole("button", { name: "‹ All boards" }).boundingBox();
    await log.pressSequentially(second.slice(0, -1), { delay: 20 });
    state.leaving = true;
    const leavingSeq = t.net.seq;
    const typedAt = performance.now();
    await page.keyboard.type(second.slice(-1));
    const clickSeq = t.net.seq;
    await page.mouse.click(away.x + away.width / 2, away.y + away.height / 2);
    const clickedAt = performance.now();
    await page.getByRole("button", { name: /^All boards(?:\s|$)/ }).waitFor();
    await t.net.idle(500);
    // the text cannot tell the two saves apart; timing can: the click must land well inside the debounce
    const saves = t.net.entries.filter((e) => e.method === "PUT" && e.path === `/api/boards/${b.id}/notes` && e.id > leavingSeq);
    const lost = saves[0];
    const why = clickedAt - typedAt >= 600 ? `the click landed ${Math.round(clickedAt - typedAt)} ms after the last key, inside reach of the 700 ms debounce`
      : !lost || lost.outcome !== "dropped" ? "the wire dropped no save made on leaving"
      : lost.id <= clickSeq ? "a save left before the click — the debounce's, not the blur's"
      : squash(lost.body?.text) !== squash(first + second) ? "the dropped save did not carry everything typed" : null;
    if (why) throw new Error(`the leave came too late: ${why}`);
    const until = performance.now() + GRACE_MS;
    let held = "";
    for (;;) {
      held = t.sql("SELECT text FROM board_notes WHERE board_id = ?", b.id)[0]?.text ?? "";
      if (squash(held) === squash(first + second) || performance.now() > until) break;
      await sleep(250);
    }
    t.check("held", squash(held) === squash(first + second), `server has ${JSON.stringify(squash(held).slice(-50))}`);
  },
};

const sourceRename503 = {
  name: "source-rename-503",
  what: "rename a source from the library while the server answers the first try 503; the source and its page are renamed together, exactly once",
  checks: {
    together: "the source and its one page carry the new name on the server",
    once: "the server renamed it exactly once, in one request",
    shown: "the library row shows the new name",
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
    await page.goto(`${t.base}/`);
    const library = page.getByRole("region", { name: "Your library" });
    const row = (name) => library.locator(".rg-row").filter({ has: page.getByRole("link", { name, exact: true }) });
    await row(src.filename).getByRole("button", { name: `Actions for ${src.filename}`, exact: true }).click();
    await row(src.filename).getByRole("menuitem", { name: "rename", exact: true }).click();
    const name = `Renamed under load ${t.seed}`;
    await library.locator(".rg-rename").fill(name);
    await library.locator(".rg-rename").press("Enter");
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
    const shown = await row(name).waitFor({ timeout: 5000 }).then(() => true, () => false);
    t.check("shown", shown, "no library row carries the new name");
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

// the shim comes off before the close: Playwright's paused interception would make teardown decide the save
const notesTabClose = {
  name: "notes-tab-close",
  what: "type into the board's log and close the tab inside the save's 700 ms debounce; the pagehide flush (keepalive) still saves everything typed",
  checks: {
    held: "the server holds everything typed after the tab closed",
  },
  async run(t) {
    const b = await board(t, "Race tab close");
    const isSave = (e) => e.method === "PUT" && e.path === `/api/boards/${b.id}/notes`;
    const page = await t.open({ latency: true });
    await page.goto(`${t.base}/?board=${b.id}`);
    const log = page.locator("textarea.note-edit");
    await log.waitFor();
    await t.net.idle(400);
    await log.click();
    const first = "The log was saved once before the tab went. ";
    const saved = t.net.when(isSave);
    await log.pressSequentially(first, { delay: 20 });
    await (await saved).done;
    await page.locator(".note-head .saved", { hasText: "saved" }).waitFor();
    const words = ["ledger", "margin", "quorum", "lattice", "harbor", "cipher"];
    const dice = t.rng("words");
    const second = `Then ${Array.from({ length: 3 }, () => words[Math.floor(dice() * words.length)]).join(" ")}, and the tab closed.`;
    const before = t.net.seq;
    const typingFrom = Date.now();
    await page.keyboard.type(second);
    const typedAt = performance.now();
    const leftEarly = t.net.entries.some((e) => e.id > before && isSave(e));
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close({ runBeforeUnload: false });
    const closedAt = performance.now();
    // pinned only if no save of the last words left before the close
    if (leftEarly || closedAt - typedAt >= 600) {
      throw new Error(`the tab closed too late: ${leftEarly ? "a save left before the close" : `${Math.round(closedAt - typedAt)} ms after the last key`}`);
    }
    const until = performance.now() + GRACE_MS;
    let held = "";
    for (;;) {
      held = t.sql("SELECT text FROM board_notes WHERE board_id = ?", b.id)[0]?.text ?? "";
      if (squash(held) === squash(first + second) || performance.now() > until) break;
      await sleep(200);
    }
    // what reached the server as the tab closed; a request is logged a beat after its commit
    const logged = () => t.sql("SELECT status FROM request_log WHERE method = 'PUT' AND path = ? AND ts >= ?", `/api/boards/${b.id}/notes`, typingFrom).map((r) => r.status);
    let flushes = logged();
    if (!flushes.length) { await sleep(300); flushes = logged(); }
    t.say(`closed ${Math.round(closedAt - typedAt)} ms after the last key; the server got ${flushes.length} save(s) of the log after it: ${flushes.join(", ") || "none"}`);
    t.check("held", squash(held) === squash(first + second),
      `server has ${JSON.stringify(squash(held).slice(-50))}; it got ${flushes.length ? `save(s) answered ${flushes.join(", ")}` : "no save"} after the close`);
  },
};

// the second tab saves over a gone revision: it must be refused and keep its words, never overwrite
const notesTwoTabs = {
  name: "notes-two-tabs",
  what: "edit the board's log in two tabs; the second to save gets the conflict and keeps its words; Use theirs and Keep mine each leave the server and the box agreeing",
  checks: {
    refused: "the second tab's save is refused and the server keeps the first tab's text",
    kept: "the refused tab says so and still holds its own words",
    theirs: "Use theirs puts the server's text in the box, and the next edit saves over it",
    mine: "Keep mine saves the box over the newer text",
  },
  async run(t) {
    const b = await board(t, "Race two tabs");
    const base = "The log as both tabs opened it.";
    await t.api(`/api/boards/${b.id}/notes`, "PUT", { text: base });
    const held = () => t.sql("SELECT text FROM board_notes WHERE board_id = ?", b.id)[0]?.text ?? "";
    const isSave = (e) => e.method === "PUT" && e.path === `/api/boards/${b.id}/notes`;
    const isRead = (e) => e.method === "GET" && e.path.split("?")[0].startsWith(`/api/boards/${b.id}`);
    const pageA = await t.open({ latency: true });
    const netA = t.net;
    const { page: pageB, net: netB } = await t.tab({ latency: true });
    const boxOf = (page) => page.evaluate(() => document.querySelector("textarea.note-edit")?.value
      ?? document.querySelector(".note-read")?.innerText ?? "");
    const edit = async (page) => {
      const box = page.locator("textarea.note-edit");
      if (!(await box.isVisible())) await page.locator(".note-read").click();
      await box.waitFor();
      await box.press("Control+End");
      return box;
    };
    for (const [page, net] of [[pageA, netA], [pageB, netB]]) {
      await page.goto(`${t.base}/?board=${b.id}`);
      await page.locator(".note-read, textarea.note-edit").filter({ hasText: base.slice(0, 20) }).or(page.locator("textarea.note-edit")).first().waitFor();
      await page.waitForFunction((want) => (document.querySelector("textarea.note-edit")?.value ?? document.querySelector(".note-read")?.innerText ?? "").includes(want), base);
      await net.idle(400);
    }
    const dice = t.rng("words");
    const word = () => ["ledger", "margin", "quorum", "lattice", "harbor", "cipher"][Math.floor(dice() * 6)];
    const savedOn = (page) => page.locator(".note-head .saved", { hasText: /^saved$/ }).waitFor();
    // tab 2 hears nothing from the server about this board until its own save has been refused
    const quiet = netB.hold(isRead);
    const aText = ` First tab: ${word()} ${word()}.`;
    const logA = await edit(pageA);
    const aSave = netA.when(isSave);
    await logA.pressSequentially(aText, { delay: 20 });
    await (await aSave).done;
    await savedOn(pageA);
    const bText = ` Second tab: ${word()} ${word()}.`;
    const logB = await edit(pageB);
    const bSave = netB.when(isSave);
    await logB.pressSequentially(bText, { delay: 20 });
    const refusal = await bSave;
    await refusal.done;
    const alert = pageB.locator(".note-head [role=alert]");
    const said = await alert.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    quiet.release();
    await netB.idle(400);
    t.check("refused", refusal.status === 409 && squash(held()) === squash(base + aText),
      `the save answered ${refusal.status}; server has ${JSON.stringify(squash(held()).slice(-60))}`);
    const boxB = await boxOf(pageB);
    t.check("kept", said && squash(boxB) === squash(base + bText),
      `${said ? "conflict shown" : "no conflict shown"}; box ${JSON.stringify(squash(boxB).slice(-60))}`);
    if (!said) { t.check("theirs", false, "no conflict to choose in"); t.check("mine", false, "not reached"); return; }
    await alert.getByRole("button", { name: "Use theirs", exact: true }).click();
    const tookTheirs = squash(await boxOf(pageB)) === squash(base + aText);
    const more = ` After theirs: ${word()}.`;
    await edit(pageB);
    const bAgain = netB.when(isSave);
    await logB.pressSequentially(more, { delay: 20 });
    const again = await bAgain;
    await again.done;
    await savedOn(pageB).catch(() => {});
    t.check("theirs", tookTheirs && again.status === 200 && squash(held()) === squash(base + aText + more),
      `box took theirs: ${tookTheirs}; next save ${again.status}; server has ${JSON.stringify(squash(held()).slice(-60))}`);
    const mine = ` First tab again: ${word()}.`;
    const quietA = netA.hold(isRead);
    const aSave2 = netA.when(isSave);
    await edit(pageA);
    await logA.pressSequentially(mine, { delay: 20 });
    await (await aSave2).done;
    const alertA = pageA.locator(".note-head [role=alert]");
    const saidA = await alertA.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    quietA.release();
    if (saidA) {
      const kept = netA.when(isSave);
      await alertA.getByRole("button", { name: "Keep mine", exact: true }).click();
      await (await kept).done;
      await savedOn(pageA).catch(() => {});
    }
    await netA.idle(400);
    const boxA = await boxOf(pageA);
    t.check("mine", saidA && squash(held()) === squash(base + aText + mine) && squash(boxA) === squash(held()),
      `${saidA ? "conflict shown" : "no conflict shown"}; server has ${JSON.stringify(squash(held()).slice(-60))}, box ${JSON.stringify(squash(boxA).slice(-60))}`);
  },
};

// three moves faster than the wire: the server must end with the plan the last gesture showed
const planThreeMoves = {
  name: "plan-three-moves",
  what: "three quick moves in the plan (Alpha later, Alpha later, Delta earlier) with the first answer held; the final order is the last gesture's, on the server and on screen",
  checks: {
    last: "the server's order is the one the last gesture showed",
    shown: "the page shows the server's order",
  },
  async run(t) {
    const b = await board(t, "Race plan three");
    const names = ["Alpha milestone", "Bravo milestone", "Charlie milestone", "Delta milestone"];
    for (const name of names) await t.api(`/api/boards/${b.id}/plan/milestones`, "POST", { name });
    const page = await t.open({ latency: true, reorder: { writes: true } });
    await page.goto(`${t.base}/?board=${b.id}`);
    const rows = page.locator("ol.bp-check > li");
    await rows.nth(3).waitFor();
    await t.net.idle(400);
    const order = () => page.evaluate(() => [...document.querySelectorAll("ol.bp-check > li input.bp-mname")].map((i) => i.value));
    const isMove = (e) => e.method === "PATCH" && e.path.startsWith(`/api/boards/${b.id}/plan/milestones/`);
    const firstAnswer = t.net.hold((e) => isMove(e) && e === t.net.entries.find(isMove));
    const move = async (name, label, want) => {
      const i = (await order()).indexOf(name);
      if (i < 0) throw new Error(`${name} is not on the page`);
      await rows.nth(i).getByRole("button", { name: label, exact: true }).click();
      await page.waitForFunction((w) => [...document.querySelectorAll("ol.bp-check > li input.bp-mname")].map((el) => el.value).join("|") === w, want.join("|"));
    };
    const [A, B, C, D] = names;
    await move(A, "Move later", [B, A, C, D]);
    await move(A, "Move later", [B, C, A, D]);
    const last = [B, C, D, A];
    await move(D, "Move earlier", last);
    await firstAnswer.arrived(1);
    firstAnswer.release();
    await page.evaluate(() => window.__strataSettled?.());
    await t.net.idle(600);
    await sleep(500);
    const shown = await order();
    const held = (await t.api(`/api/boards/${b.id}`)).plan.milestones.slice().sort((x, y) => x.ord - y.ord).map((m) => m.name);
    t.say(`${t.net.entries.filter(isMove).length} moves sent`);
    t.check("last", held.join() === last.join(), `server ${held.join(" · ")}`);
    t.check("shown", shown.join() === held.join(), `page ${shown.join(" · ")} — server ${held.join(" · ")}`);
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
    await page.getByRole("button", { name: "+ Add from a link", exact: true }).click();
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
    const label = (await t.api(`/api/boards/${b.id}`)).pairs[0]?.label ?? "";
    const listed = outcome === "closed" && !!label && await page.locator(".bp-it", { hasText: label }).first()
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
    await page.locator(".note-head, .bp-rail").first().waitFor();
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

// a newer board snapshot lands mid-typing: the draft's If-Match must not be taken from the store
const notesRefreshTyping = {
  name: "notes-refresh-typing",
  what: "the first tab saves the log; a board snapshot carrying that save (another write's answer) lands in the second tab while it types over the log it read; its save is refused and it is asked, the first tab's text kept",
  checks: {
    kept: "the first tab's saved text is not written over without a choice (the log and its edit history)",
    asked: "the typing tab is told the log changed elsewhere and still holds its own words",
  },
  async run(t) {
    const b = await board(t, "Race refresh typing");
    const src = await prose(t, b.id, `race-refresh-${t.seed}-${Date.now().toString(36)}.md`, essay("A source renamed mid-log", "This source is renamed while the log is written in."));
    const base = "The log as both tabs opened it.";
    await t.api(`/api/boards/${b.id}/notes`, "PUT", { text: base });
    const held = () => t.sql("SELECT text FROM board_notes WHERE board_id = ?", b.id)[0]?.text ?? "";
    const writes = () => Number(t.sql("SELECT COUNT(*) n FROM events WHERE event = 'notes_write' AND json_extract(props,'$.board') = ?", b.id)[0]?.n ?? 0);
    const isSave = (e) => e.method === "PUT" && e.path === `/api/boards/${b.id}/notes`;
    const renamePath = `/api/boards/${b.id}/resources/${src.rid}`;
    const isRename = (e) => e.method === "PATCH" && e.path === renamePath;
    const pageA = await t.open({ latency: true });
    const netA = t.net;
    const { page: pageB, net: netB } = await t.tab({ latency: true });
    const boxOf = (page) => page.evaluate(() => document.querySelector("textarea.note-edit")?.value
      ?? document.querySelector(".note-read")?.innerText ?? "");
    const edit = async (page) => {
      const box = page.locator("textarea.note-edit");
      if (!(await box.isVisible())) await page.locator(".note-read").click();
      await box.waitFor();
      await box.press("Control+End");
      return box;
    };
    for (const [page, net] of [[pageA, netA], [pageB, netB]]) {
      await page.goto(`${t.base}/?board=${b.id}`);
      await page.waitForFunction((want) => (document.querySelector("textarea.note-edit")?.value ?? document.querySelector(".note-read")?.innerText ?? "").includes(want), base);
      await net.idle(400);
    }
    const dice = t.rng("words");
    const word = () => ["ledger", "margin", "quorum", "lattice", "harbor", "cipher"][Math.floor(dice() * 6)];
    const aText = ` First tab: ${word()} ${word()}.`;
    const logA = await edit(pageA);
    const aSave = netA.when(isSave);
    await logA.pressSequentially(aText, { delay: 20 });
    await (await aSave).done;
    await pageA.locator(".note-head .saved", { hasText: /^saved$/ }).waitFor();
    await netA.idle(300);
    if (squash(held()) !== squash(base + aText)) throw new Error("the first tab's save did not land: nothing to keep");
    const writesAfterA = writes();
    // tab 2 renames the source; the answer carries the board at the first tab's revision, and is held
    const rename = netB.hold(isRename);
    await pageB.getByRole("button", { name: "boards", exact: true }).click();
    const library = pageB.getByRole("region", { name: "Your library" });
    const row = (name) => library.locator(".rg-row").filter({ has: pageB.getByRole("link", { name, exact: true }) });
    await row(src.filename).getByRole("button", { name: `Actions for ${src.filename}`, exact: true }).click();
    await row(src.filename).getByRole("menuitem", { name: "rename", exact: true }).click();
    await library.locator(".rg-rename").fill(`Renamed mid-log ${t.seed}`);
    await library.locator(".rg-rename").press("Enter");
    await rename.arrived(1);
    const snapshot = await rename.caught[0].response.json().catch(() => null);
    if (squash(snapshot?.state?.notes) !== squash(base + aText)) throw new Error("the held answer does not carry the first tab's log — the interleaving was not pinned");
    await pageB.getByRole("button", { name: "Close library", exact: true }).click();
    const bText = ` Second tab: ${word()} ${word()} ${word()}.`;
    const cut = bText.indexOf(" ", Math.floor(bText.length / 2)) + 1;
    const logB = await edit(pageB);
    const bSave = netB.when(isSave);
    const typingFrom = netB.seq;
    await logB.pressSequentially(bText.slice(0, cut), { delay: 20 });
    rename.release();
    let rest = bText.slice(cut), landed = false;
    rename.caught[0].done.then(() => { landed = true; });
    while (!landed && rest.length > 1) { await logB.pressSequentially(rest[0]); rest = rest.slice(1); await sleep(20); }
    await rename.caught[0].done;
    await logB.pressSequentially(rest, { delay: 20 });
    const save = await bSave;
    await save.done;
    const refresh = rename.caught[0];
    const early = netB.entries.find((e) => e.id > typingFrom && isSave(e) && e.startedAt < refresh.deliveredAt);
    if (early) throw new Error("the second tab's save left before the snapshot landed — the interleaving was not pinned");
    const alert = pageB.locator(".note-head [role=alert]");
    const said = await alert.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await netB.idle(400);
    await netA.idle(400);
    const now = held(), lost = writes() - writesAfterA;
    t.say(`the second tab's save went out with If-Match ${save.headers["if-match"] ?? "(none)"} and was answered ${save.status}`);
    t.check("kept", squash(now) === squash(base + aText) && lost === 0,
      `server has ${JSON.stringify(squash(now).slice(-60))}; ${lost} save(s) taken over the first tab's after it landed (the save answered ${save.status})`);
    const boxB = await boxOf(pageB);
    t.check("asked", said && squash(boxB) === squash(base + bText),
      `${said ? "conflict shown" : "no conflict shown"}; box ${JSON.stringify(squash(boxB).slice(-60))}`);
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
    await page.getByRole("button", { name: "+ Add from a link", exact: true }).click();
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
  const label = (await t.api(`/api/boards/${b.id}`)).pairs[0]?.label ?? "";
  const listed = closed && !!label && await page.locator(".bp-it", { hasText: label }).first()
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
    const box = page.getByRole("textbox", { name: "Board purpose", exact: true });
    await box.waitFor();
    await page.waitForFunction(() => document.querySelector("textarea.bp-purpose")?.value === "The purpose as first read");
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
    await page.getByRole("button", { name: "‹ All boards" }).click();
    const boards = page.getByRole("button", { name: /^All boards(?:\s|$)/ });
    await boards.waitFor();
    if (await boards.getAttribute("aria-expanded") !== "true") await boards.click();
    await page.getByRole("region", { name: "All boards", exact: true }).getByRole("button", { name: b.title, exact: true }).click();
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
    await page.locator(".note-head, .bp-rail").first().waitFor();
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
    shown: "the editor closes and the board says the book has two sections",
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
    await page.locator(".bp-rail .bp-it", { hasText: name }).first().click();
    const cover = page.locator(".bp-cover");
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
    const length = await cover.locator(".bp-facts dd").first().innerText().catch(() => "");
    t.check("shown", closed && /^2 sections$/.test(squash(length)), `editor ${closed ? "closed" : "still open"}; length says ${JSON.stringify(squash(length))}`);
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
      await page.locator(".tr-card.in", { hasText: name }).getByRole("button", { name: "Keep in backlog" }).click();
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

    await page.getByRole("tab", { name: /^Backlog/ }).click();
    const row = page.locator(".r", { hasText: `Race task ${tag}` });
    await row.waitFor();
    await row.locator(".t").click();
    await page.locator(".tr-card.open").getByRole("button", { name: "Move…" }).click();
    await page.getByRole("menuitem", { name: "To-do", exact: true }).click();
    const until2 = performance.now() + GRACE_MS;
    let stage = "";
    for (;;) {
      stage = t.sql("SELECT stage FROM dashboard_tasks WHERE title = ?", `Race task ${tag}`)[0]?.stage ?? "";
      if (stage === "todo" || performance.now() > until2) break;
      await sleep(250);
    }
    t.check("moved", stage === "todo", `the task is "${stage}" on the server`);
  },
};

const dashboardWrites = {
  name: "dashboard-writes",
  what: "on a lossy wire you pick a task for tomorrow morning, then open its doc and type a title and notes with the first answers lost; each write lands once",
  checks: {
    picked: "the picked task is in to-do with a morning pick on the server",
    title: "the title typed in the doc, closed before its save, is the title on the server",
    notes: "the notes typed in the doc are on the server, once",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    const id = `t_pin${t.seed}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_]/g, "");
    await t.api("/api/dashboard/tasks", "POST", { id, title: `Race pin ${tag}`, body: "Picked under loss.", area: "work" });
    const lost = (e) => e.write && /\/api\/dashboard\/tasks\/[^/]+$/.test(e.path) && e.method !== "POST";
    const page = await t.open({ latency: true, lostAck: { match: lost, pick: new Set([1, 2, 3]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/dashboard?view=triage&sub=backlog`);
    await page.getByRole("tab", { name: /^Work/ }).click();
    await page.getByRole("tab", { name: /^Backlog/ }).click();
    const row = page.locator(".r", { hasText: `Race pin ${tag}` });
    await row.waitFor();
    await row.locator(".t").click();
    await page.locator(".tr-card.open").getByRole("button", { name: "Move…" }).click();
    await page.getByRole("menuitem", { name: "Tomorrow morning" }).click();

    await page.getByRole("tab", { name: /^To-do/ }).click();
    const moved = page.locator(".r", { hasText: `Race pin ${tag}` });
    await moved.waitFor();
    await moved.locator(".t").click();
    const title = page.locator(".tr-card.open .dtitle");
    await title.focus();
    await page.keyboard.press("Control+End");
    await title.pressSequentially(" edited", { delay: 15 });
    const notes = page.locator(".tr-card.open .dbody");
    await notes.focus();
    await page.keyboard.press("Control+End");
    await notes.pressSequentially(`\nNotes ${tag}`, { delay: 15 });
    await page.keyboard.press("Escape");

    const until = performance.now() + GRACE_MS * 2;
    let rowDb = null;
    for (;;) {
      rowDb = t.sql("SELECT stage, morning_at, title, body FROM dashboard_tasks WHERE id = ?", id)[0] ?? null;
      if ((rowDb && rowDb.stage === "todo" && rowDb.morning_at && rowDb.title === `Race pin ${tag} edited` && rowDb.body === `Picked under loss.\nNotes ${tag}`) || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    t.check("picked", !!rowDb?.morning_at && rowDb.stage === "todo", `stage ${rowDb?.stage}, morning_at ${rowDb?.morning_at}`);
    t.check("title", rowDb?.title === `Race pin ${tag} edited`, `the title is ${JSON.stringify(rowDb?.title)}`);
    t.check("notes", rowDb?.body === `Picked under loss.\nNotes ${tag}`, `the notes are ${JSON.stringify(rowDb?.body?.slice(0, 120))}`);
  },
};

const dashboardAdd = {
  name: "dashboard-add",
  what: "you add two threads to the backlog on a lossy wire, the first add's answer lost, then pick the second for tomorrow morning; each thread is on the server once and the pick lands",
  checks: {
    added: "each thread added from the backlog is on the server once",
    picked: "the second thread, picked while its add was still settling, is in to-do for tomorrow morning",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    const titles = [`Race add ${tag} one`, `Race add ${tag} two`];
    const adds = (e) => e.write && /\/api\/dashboard\/tasks(\/[^/]+)?$/.test(e.path);
    const page = await t.open({ latency: true, lostAck: { match: adds, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/dashboard?view=triage&sub=backlog`);
    await page.getByRole("tab", { name: /^Backlog/ }).click();
    for (const title of titles) {
      await page.locator("#addIn").fill(title);
      await page.getByRole("button", { name: "Add", exact: true }).click();
    }
    // a thread you add opens, ready for its prompt; the second is the one open now
    await page.locator(".tr-card.open").getByRole("button", { name: "Move…" }).click();
    await page.getByRole("menuitem", { name: "Tomorrow morning" }).click();
    const until = performance.now() + GRACE_MS * 2;
    let rows = [];
    for (;;) {
      rows = titles.map((title) => t.sql("SELECT stage, morning_at FROM dashboard_tasks WHERE title = ?", title));
      if ((rows.every((r) => r.length === 1) && rows[1][0].morning_at) || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    rows = titles.map((title) => t.sql("SELECT stage, morning_at FROM dashboard_tasks WHERE title = ?", title));
    t.check("added", rows.every((r) => r.length === 1), rows.map((r, i) => `${titles[i]}: ${r.length} row(s) ${r.map((x) => x.stage).join(",")}`).join("; "));
    t.check("picked", rows[1][0]?.stage === "todo" && !!rows[1][0]?.morning_at, `stage ${rows[1][0]?.stage}, morning_at ${rows[1][0]?.morning_at}`);
  },
};

const dispatchPress = {
  name: "dispatch-press",
  what: "in Dispatch you press Send back on one thread's page and Go on another's, on a lossy wire with the first press's answer lost; each press is stored once and both threads wait in Implementing",
  checks: {
    once: "each press is on the server exactly once",
    moved: "both threads are in implementing on the server",
    shown: "the pane no longer lists either thread under Decide",
  },
  async run(t) {
    const tag = `${t.seed}-${Date.now().toString(36)}`;
    const { token } = await t.api("/api/agent/tokens", "POST", { name: `race dispatch ${t.seed}`, write: true });
    let n = 0;
    const post = async (id, html) => {
      const r = await fetch(`${t.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: "dashboard_post", arguments: { key: `race-post-${tag}-${n}`, id, page: html } } }) });
      const body = await r.json();
      if (!body.result || body.result.isError) throw new Error(`dashboard_post: ${JSON.stringify(body).slice(0, 200)}`);
    };
    const ids = [0, 1].map((i) => `t_dsp${i}${t.seed}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_]/g, ""));
    const titles = [`Race back ${tag}`, `Race go ${tag}`];
    for (const [i, id] of ids.entries()) {
      await t.api("/api/dashboard/tasks", "POST", { id, title: titles[i], body: "Under loss.", area: "work" });
      await t.api(`/api/dashboard/tasks/${id}/send`, "POST", {});
      await post(id, `<!doctype html><html><body><h1>${titles[i]}</h1><p>A page to decide on.</p></body></html>`);
    }
    const presses = (e) => e.write && /\/api\/dashboard\/tasks\/[^/]+\/press$/.test(e.path);
    const page = await t.open({ latency: true, lostAck: { match: presses, pick: new Set([1]), key: (e) => e.headers["idempotency-key"] ?? null } });
    await page.goto(`${t.base}/dispatch`);
    for (const [i, button] of [[0, "Send back"], [1, "Go →"]]) {
      const card = page.locator(".ws-card", { hasText: titles[i] });
      await card.first().waitFor();
      if (!(await card.first().evaluate((el) => el.classList.contains("open")))) await card.first().click();
      await page.locator(".ws-card.open", { hasText: titles[i] }).getByRole("button", { name: button, exact: true }).click();
    }
    const until = performance.now() + GRACE_MS * 2;
    let rows = [];
    for (;;) {
      rows = ids.map((id) => t.sql("SELECT kind FROM dashboard_presses WHERE task_id = ? AND kind != 'send'", id));
      if (rows.every((r) => r.length >= 1) || performance.now() > until) break;
      await sleep(250);
    }
    await t.net.idle(500);
    rows = ids.map((id) => t.sql("SELECT kind FROM dashboard_presses WHERE task_id = ? AND kind != 'send'", id));
    const stages = ids.map((id) => t.sql("SELECT stage FROM dashboard_tasks WHERE id = ?", id)[0]?.stage);
    t.check("once", rows[0].length === 1 && rows[0][0].kind === "back" && rows[1].length === 1 && rows[1][0].kind === "go", rows.map((r, i) => `${titles[i]}: ${r.map((x) => x.kind).join(",") || "none"}`).join("; "));
    t.check("moved", stages.every((s) => s === "implementing"), stages.join(", "));
    const listed = await page.locator(".ws-list").textContent();
    t.check("shown", !titles.some((x) => listed.includes(x)), `the Decide list reads ${JSON.stringify(listed.slice(0, 160))}`);
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

export const scenarios = [notesRoundtrip, highlightDuringRefresh, planDoubleMove, drillGrades, reviewGrades, launcherDeleteSource, launcherDeleteLastSource, chatSwitch, notesLostSave, sourceRename503, keepsToggle,
  notesTabClose, notesTwoTabs, planThreeMoves, markNoteDelete, captureLostAnswer, captureCancelAgain, captureCancelLost, captureCancelLanded, captureTitleDrift, chatStreamCut, cardEditLost, authoredTwice, notesRefreshTyping, planPurposeLate409, imageUploadLate, agentResend, agentRevise, selectSeveral, pageStateSaves, liveNotes, liveNoteRemove, noteReplies, selectionCard, resplitRaces, dashboardTriage, dashboardWrites, dashboardAdd, dispatchPress];
