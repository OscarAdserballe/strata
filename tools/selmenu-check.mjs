// node tools/selmenu-check.mjs URL [board resource pair]: the selection menu opens and stays up
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { atRest } from "./settled.mjs";

const base = (process.argv[2] || "http://127.0.0.1:8805").replace(/\/$/, "");
// no sleeps: WATCH and MENU_WAIT are the length of the property checked, and end when it breaks
const POSITIONS = Number(process.env.SELMENU_POSITIONS) || 40, TICK = 250, WATCH = 1000, MENU_WAIT = 1000;
// a reader that never rests is check 1's failure, so settle() reports it instead of throwing
const settle = () => atRest(page, ".page", { every: TICK, timeout: 10_000 }).then(() => true, () => false);
let page;

async function target() {
  if (process.argv[5]) return { board: process.argv[3], id: process.argv[4], pair: process.argv[5] };
  const { boards } = await (await fetch(base + "/api/boards")).json();
  let best = null;
  for (const b of boards) {
    const s = await (await fetch(`${base}/api/boards/${b.id}`)).json();
    for (const r of s.resources) {
      if (!(/pdf/.test(r.mime || "") || /\.pdf$/i.test(r.filename || ""))) continue;
      const pair = s.pairs.find((p) => p.resourceId === r.id);
      const marks = s.marks.filter((m) => m.resourceId === r.id).length;
      if (pair && (!best || marks > best.marks)) best = { board: b.id, id: r.id, pair: pair.id, marks };
    }
  }
  assert.ok(best, "no PDF with a pair on this instance");
  return best;
}

const t = await target();
const browser = await chromium.launch();
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures.push(what); };
try {
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/?board=${t.board}&resource=${t.id}&pair=${t.pair}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".slide canvas", { timeout: 60_000 });
  await settle();                               // the opening burst (landing, settle poll, first draws) is over

  const park = async (y) => {
    await page.evaluate((y) => { document.querySelector(".page").scrollTop = y; }, y);
    return settle();
  };
  // one scroll then a quiet WATCH is a late settle; a second scroll is the self-scrolling loop
  const watch = () => page.evaluate((W) => new Promise((resolve) => {
    const sc = document.querySelector(".page"), t0 = performance.now(), at = [];
    let timer;
    const done = () => { clearTimeout(timer); sc.removeEventListener("scroll", on); resolve(at); };
    const on = () => {
      at.push(Math.round(performance.now() - t0));
      if (at.length > 1) return done();
      clearTimeout(timer);
      timer = setTimeout(done, W);
    };
    sc.addEventListener("scroll", on);
    timer = setTimeout(done, W);
  }), WATCH);
  const reader = () => page.evaluate(() => { const R = document.querySelector(".page").getBoundingClientRect(); return { top: R.top, bottom: R.bottom, left: R.left, right: R.right }; });
  const twoLines = async () => {
    await page.waitForFunction(() => {
      const R = document.querySelector(".page").getBoundingClientRect();
      return [...document.querySelectorAll(".tlayer [data-i]")].some((el) => { const r = el.getBoundingClientRect(); return r.top > R.top + 80 && r.bottom < R.bottom - 80; });
    }, null, { timeout: 5000 }).catch(() => {});
    return page.evaluate(() => {
      const R = document.querySelector(".page").getBoundingClientRect();
      const runs = [...document.querySelectorAll(".tlayer [data-i]")].filter((el) => el.textContent.length >= 12)
        .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 60 && r.top > R.top + 80 && r.bottom < R.bottom - 80);
      for (let i = 0; i + 1 < runs.length; i++) {
        const A = runs[i], B = runs[i + 1];
        if (B.top > A.bottom - 2 && B.top - A.bottom < 40)
          return { a: { x: A.left + 3, y: A.top + A.height / 2 }, b: { x: B.left + B.width * 0.7, y: B.top + B.height / 2 } };
      }
      return null;
    });
  };
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
  };
  const menu = async () => {
    const opened = await page.waitForSelector(".selmenu", { timeout: 1000 }).then(() => true, () => false);
    const closed = opened && await page.waitForSelector(".selmenu", { state: "detached", timeout: MENU_WAIT }).then(() => true, () => false);
    return { opened, alive: opened && !closed };
  };
  const putDown = async () => {
    await page.keyboard.press("Shift");         // any key ends the gesture
    await page.evaluate(() => getSelection().removeAllRanges());
  };

  const height = await page.evaluate(() => document.querySelector(".page").scrollHeight);
  const moving = [], late = [], quiet = [], restless = [];
  for (let i = 0; i < POSITIONS; i++) {
    const y = Math.round((height * i) / POSITIONS + ((i * 37) % 300));
    if (!await park(y)) restless.push(y);
    const at = await watch();
    (at.length > 1 ? moving : at.length ? late : quiet).push({ y, at });
  }
  const ms = (m) => `y=${m.y} at ${m.at.join(", ")} ms`;
  check(!moving.length, `the reader keeps still at rest (${moving.length}/${POSITIONS} parked positions kept scrolling on their own`
    + (moving.length ? `: ${moving.slice(0, 4).map(ms).join("; ")})` : ")"));
  // not failures, but said, so a slow runner is seen for what it is
  if (late.length) console.log(`     ${late.length} scrolled once and then kept still for ${WATCH} ms (a late settle, not the loop): ${late.slice(0, 4).map(ms).join("; ")}`);
  if (restless.length) console.log(`     ${restless.length} did not come to rest within 10 s of parking: y=${restless.slice(0, 4).join(", ")}`);
  // positions with no two lines of text in view (a heading page, a figure) are skipped
  let selectable = null;
  for (const [list, want] of [[quiet.filter((q) => q.y > 2000), 1], [moving, 2]]) {
    let done = 0;
    for (const { y } of list) {
      if (done >= want) break;
      await park(y);
      const p = await twoLines();
      if (!p) continue;
      selectable ??= y;
      await drag(p.a, p.b);
      const m = await menu();
      check(m.opened && m.alive, `selecting at y=${y}: the menu opens and is still up ${MENU_WAIT} ms later (opened=${m.opened}, up=${m.alive})`);
      await putDown();
      done++;
    }
  }
  assert.ok(selectable != null, "nowhere in this PDF had two lines of text to select");

  await park(selectable);
  {
    const p = await twoLines(), R = await reader();
    await drag(p.a, { x: R.left - 40, y: p.b.y });
    const m = await menu();
    check(m.opened && m.alive, `a drag let go over the deck still gets the menu (opened=${m.opened}, up=${m.alive})`);
    await putDown();
  }

  {
    const pages = await page.evaluate(() => document.querySelectorAll(".slide").length);
    let pts = null, ends = null;
    for (let n = 2; n < Math.min(pages, 30) && !ends; n++) {
      await page.evaluate((n) => { const sc = document.querySelector(".page"), s = document.querySelector(`#pg-${n}`); sc.scrollTop = s.offsetTop + s.offsetHeight - sc.clientHeight * 0.5; }, n);
      await settle();
      const moved = await page.evaluate((n) => {
        const sc = document.querySelector(".page"), s = document.querySelector(`#pg-${n}`);
        const runs = s.querySelectorAll(".tlayer [data-i]");
        if (!runs.length) return false;
        const z = s.getBoundingClientRect().height / s.offsetHeight;   // the rects are zoomed, scrollTop is not
        sc.scrollTop += (runs[runs.length - 1].getBoundingClientRect().top - sc.getBoundingClientRect().top - 60) / z;
        return true;
      }, n);
      if (!moved) continue;
      await settle();
      pts = { n };
      ends = await page.evaluate((n) => {
        const R = document.querySelector(".page").getBoundingClientRect();
        const inView = (r) => r.width > 20 && r.top > R.top + 20 && r.bottom < R.bottom - 20;
        const mine = [...document.querySelectorAll(`#pg-${n} .tlayer [data-i]`)].map((e) => e.getBoundingClientRect()).filter(inView);
        const next = [...document.querySelectorAll(`#pg-${n + 1} .tlayer [data-i]`)].map((e) => e.getBoundingClientRect()).filter(inView);
        if (!mine.length || !next.length) return null;
        const a = mine[mine.length - 1], b = next[0];
        return { a: { x: a.left + 3, y: a.top + a.height / 2 }, b: { x: b.left + b.width * 0.6, y: b.top + b.height / 2 } };
      }, n);
    }
    assert.ok(ends, "no page whose foot and the next page's head are in view together");
    await drag(ends.a, ends.b);
    const m = await menu();
    check(m.opened && m.alive, `a drag across pages ${pts.n}–${pts.n + 1} gets the menu (opened=${m.opened}, up=${m.alive})`);
    if (m.opened && m.alive) {
      const saved = page.waitForResponse((x) => x.url().endsWith(`/api/boards/${t.board}/marks`) && x.request().method() === "POST");
      await page.locator(".selmenu button", { hasText: "Note" }).click();
      const body = await (await saved).json();
      await page.keyboard.press("Escape");
      const mark = body.mark || {};
      check(mark.page === pts.n && !!String(mark.quote || "").trim() && (mark.rects || []).length > 0,
        `…and Note marks page ${pts.n}, where the drag started (page=${mark.page}, ${String(mark.quote || "").length} chars, ${(mark.rects || []).length} boxes)`);
      if (body.id || mark.id) await fetch(`${base}/api/boards/${t.board}/marks/${body.id || mark.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
  check(!errors.length, `no page errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
} finally {
  await browser.close();
}
if (failures.length) { console.error(`\n${failures.length} selection-menu check(s) failed`); process.exit(1); }
console.log("\nthe selection menu holds");
