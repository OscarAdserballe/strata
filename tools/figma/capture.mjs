// node tools/figma/capture.mjs [--out <dir>] [--only <surface,...>]: one PNG per state, desktop and phone, for FIGMA.md.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { REPO, serveRoom } from "../race/serve.mjs";
import { snapshot, snapshotPart } from "./snapshot.mjs";

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const out = arg("--out") ?? join(REPO, "data", "figma");
const only = arg("--only")?.split(",") ?? null;
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const room = await serveRoom({ label: "figma" });
const failed = [];
try {
  // the seed keeps and grades cards today; due ones are what review and the phone's door are for, so move both back
  const db = new DatabaseSync(room.db);
  const back = 3 * 864e5;
  db.exec(`UPDATE card_keeps SET created_at = created_at - ${back};
    UPDATE events SET ts = ts - ${back} WHERE event IN ('card_show', 'card_grade', 'card_answer')`);
  db.close();
  const boards = (await (await fetch(`${room.base}/api/boards`)).json()).boards;
  const board = (title) => boards.find((b) => b.title.startsWith(title));
  const pairs = async (b) => (await (await fetch(`${room.base}/api/boards/${b.id}`)).json()).pairs;
  const reader = async (title, label) => {
    const b = board(title), p = (await pairs(b)).find((x) => !label || x.label.startsWith(label));
    return `/?board=${b.id}&resource=${p.resourceId}&pair=${p.id}`;
  };
  const R = {
    book: `/?board=${board("The Discipline").id}`, slides: `/?board=${board("Advanced").id}`, essay: `/?board=${board("Reading").id}`,
    fe: `/?board=${board("Financial").id}`, gap: `/?board=${board("Overcoming").id}`, empty: `/?board=${board("Care").id}`,
    explore: `/?board=${board("Strata").id}`,
    bookReader: await reader("The Discipline"), slidesReader: await reader("Advanced"),
    essayReader: await reader("Reading", "The identification"), transcriptReader: await reader("Reading", "Coordination"),
    liveReader: await reader("Strata"),
  };

  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  try {
    for (const [device, options] of Object.entries(DEVICES)) {
      const dir = join(out, device);
      if (!only) rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const context = await browser.newContext({ ...options, serviceWorkers: "block" });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const open = async (route) => {
        await page.goto(room.base + route, { waitUntil: "networkidle" });
        await page.waitForTimeout(900);
      };
      const shot = async (name, { full = false } = {}) => {
        await page.waitForTimeout(500);
        // screens scroll inside the room, not the document: let every scroller and its ancestors grow to their content
        if (full) await page.evaluate(() => {
          for (const el of document.querySelectorAll("*")) {
            const cs = getComputedStyle(el);
            if (!/(auto|scroll)/.test(cs.overflowY) || el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 1) continue;
            for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
              Object.assign(n.style, { height: "auto", maxHeight: "none", overflow: "visible" });
              if (getComputedStyle(n).position === "fixed") Object.assign(n.style, { position: "absolute", bottom: "auto" });
            }
          }
        });
        await page.screenshot({ path: join(dir, `${name}.png`), fullPage: full });
        const { width, height } = options.viewport;
        writeFileSync(join(dir, `${name}.html`), await snapshot(page, { width, height: full ? null : height }));
        console.log(`${device}/${name}`);
      };
      const phone = device === "phone";
      const surfaces = surfaceSteps({ page, open, shot, phone, R });
      for (const [surface, steps] of Object.entries(surfaces)) {
        if (only && !only.includes(surface)) continue;
        for (const [state, step] of steps) {
          try { await step(); }
          catch (e) {
            failed.push(`${device}/${surface} — ${state}: ${String(e.message).split("\n")[0]}`);
            await page.screenshot({ path: join(dir, `_failed--${surface}--${state.replace(/\W+/g, "-")}.png`) }).catch(() => {});
          }
        }
      }
      await context.close();
    }
    if (!only || only.includes("foundations")) await foundations(browser, R);
  } finally {
    await browser.close();
  }
} finally {
  await room.stop();
}

/** foundations.html (one .component per shared piece, for Figma's importer) and tokens.json (each colour token as hex). */
async function foundations(browser, R) {
  const context = await browser.newContext({ ...DEVICES.desktop, serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const open = async (route) => { await page.goto(room.base + route, { waitUntil: "networkidle" }); await page.waitForTimeout(900); };
  const button = (name) => page.getByRole("button", { name, exact: true });
  const PARTS = [
    ["/", [
      ["Button / primary", () => page.getByRole("button", { name: /^Continue board/ })],
      ["Button / outline", () => page.getByRole("button", { name: /^Review \d+ cards/ })],
      ["Button / quiet", () => button("New card")],
      ["Button / suggest", () => page.locator(".lhead .suggest-button")],
      ["Ask bar", () => page.locator(".askwrap").first()],
      ["Kept chart", () => page.locator(".kc").first()],
    ]],
    [R.slides, [
      ["Top bar", () => page.locator(".status").first()],
      ["Board rail", () => page.locator(".bp-rail")],
      ["Board / open button", () => page.locator(".bp-btn").first()],
      ["Milestone / reached", () => page.locator(".bp-check > li.done").first()],
      ["Milestone / open", () => page.locator(".bp-check > li:not(.done)").first()],
    ]],
    ["/?view=review", [
      ["Card / prompt", () => page.locator(".reviewv .rcard").first()],
    ]],
    [`${R.slides}&view=cram`, [
      ["Toggle / kept · every card", () => button("every card").locator("xpath=..")],
    ]],
    ["/dashboard", [
      ["Dashboard / tabs", () => page.locator(".tabs").first()],
      ["Dashboard / task row", () => page.locator(".trow").first()],
    ]],
  ];
  const parts = [];
  let fonts = "";
  for (const [route, list] of PARTS) {
    await open(route);
    for (const [name, find] of list) {
      try {
        await find().first().evaluate((el) => el.setAttribute("data-figma-part", ""));
        const got = await snapshotPart(page, "[data-figma-part]");
        await page.locator("[data-figma-part]").evaluate((el) => el.removeAttribute("data-figma-part"));
        fonts ||= got.fonts;
        parts.push(`<div class="component" data-name="${name}" style="display:inline-block;vertical-align:top;margin:24px;padding:24px;background:#fbf8f2">${got.html}</div>`);
        console.log(`foundations/${name}`);
      } catch (e) { failed.push(`foundations — ${name}: ${String(e.message).split("\n")[0]}`); }
    }
  }
  await open("/");
  const tokens = await page.evaluate(() => {
    const names = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
      .filter((r) => r.selectorText === ":root").flatMap((r) => [...r.style]).filter((n) => n.startsWith("--") && !/serif|sans|mono|shadow|^--layer/.test(n));
    const g = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
    return Object.fromEntries([...new Set(names)].map((n) => {
      const value = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      g.clearRect(0, 0, 1, 1); g.fillStyle = value; g.fillRect(0, 0, 1, 1);
      const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
      return [n.slice(2), { value, hex: `#${[r, gg, b].map((x) => x.toString(16).padStart(2, "0")).join("")}` }];
    }));
  });
  writeFileSync(join(out, "foundations.html"), `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}</style></head><body style="margin:0;background:#fff;width:1600px">${parts.join("\n")}</body></html>`);
  writeFileSync(join(out, "tokens.json"), JSON.stringify(tokens, null, 2));
  await context.close();
}
console.log(`\nWrote screenshots to ${out}`);
if (failed.length) { console.error(`\n${failed.length} state(s) not captured:\n  ${failed.join("\n  ")}`); process.exit(1); }

/** Each surface's states, in order; a step opens its route, acts, and shoots. Phone takes only the screens built for it. */
function surfaceSteps({ page, open, shot, phone, R }) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  const both = (steps) => steps;
  const desk = (steps) => (phone ? [] : steps);
  // drags across the start of a paragraph of the open text, so the selection menu shows
  const pick = async () => {
    const box = await page.locator(".page-col p[data-b]").nth(3).boundingBox();
    await page.mouse.move(box.x + 4, box.y + 8); await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 8, { steps: 6 }); await page.mouse.up();
    await page.locator(".selmenu").waitFor();
  };
  return {
    library: both([
      ["home", async () => { await open("/"); await shot("library--home", { full: true }); }],
      ...desk([
        ["all boards", async () => { await open("/"); await page.getByRole("button", { name: /^All boards/ }).click(); await shot("library--all-boards", { full: true }); }],
        ["connect an agent", async () => { await open("/"); await button("Connect an agent").click(); await shot("library--connect-agent"); }],
        ["new card", async () => { await open("/"); await button("New card").click(); await shot("library--new-card"); }],
        ["suggest improvement", async () => { await open("/"); await page.locator(".lhead .suggest-button").click(); await shot("library--suggest"); }],
      ]),
    ]),
    board: both([
      ["finished book", async () => { await open(R.book); await shot("board--book", { full: true }); }],
      ["plan with milestones", async () => { await open(R.slides); await shot("board--plan", { full: true }); }],
      ["text and transcript", async () => { await open(R.essay); await shot("board--essay"); }],
      ["card-only pairs", async () => { await open(R.fe); await shot("board--decks"); }],
      ["a bare question", async () => { await open(R.gap); await shot("board--question"); }],
      ["empty", async () => { await open(R.empty); await shot("board--empty"); }],
      ["live page", async () => { await open(R.explore); await shot("board--explorations"); }],
    ]),
    reader: desk([
      ["pdf book", async () => { await open(R.bookReader); await page.waitForSelector("canvas"); await shot("reader--pdf"); }],
      ["pdf slides", async () => { await open(R.slidesReader); await page.waitForSelector("canvas"); await shot("reader--slides"); }],
      ["text with marks", async () => { await open(R.essayReader); await shot("reader--text"); }],
      ["a note's fold open", async () => { await open(R.essayReader); await page.locator(".ftick:has(.fmk.note)").first().click(); await shot("reader--note-fold"); }],
      ["selection menu", async () => { await open(R.essayReader); await pick(); await shot("reader--selection-menu"); }],
      ["a card written under words", async () => { await button("Card").click(); await page.locator(".fold .fi.draft").waitFor(); await shot("reader--card-draft"); }],
      ["a question under words", async () => {
        await open(R.essayReader); await pick(); await button("Ask").click();
        const line = page.locator(".fold .fi.asked .fi-q");
        await line.fill("Why is this suggestive and not proof?"); await line.press("Enter");
        await page.locator(".fold .fi.asked .fi-turn.claude:not(.writing)").waitFor({ timeout: 30000 });
        await shot("reader--ask");
      }],
      ["transcript", async () => { await open(R.transcriptReader); await shot("reader--transcript"); }],
      ["live page with notes", async () => { await open(R.liveReader); await shot("reader--live"); }],
    ]),
    review: both([
      ["a due card", async () => { await open("/?view=review"); await page.locator(".reviewv .q").waitFor(); await shot("review--card"); }],
      ["revealed", async () => { await page.locator(".reviewv").getByRole("button", { name: /reveal/ }).click(); await shot("review--revealed"); }],
      ["the day's map", async () => {
        await page.getByRole("button", { name: /got it/ }).first().click();
        await page.getByRole("button", { name: "end here — see the day" }).click();
        await page.locator(".smcount").waitFor({ timeout: 30_000 });
        await shot("review--session-map", { full: true });
      }],
    ]),
    cram: both([
      ["a round", async () => { await open(`${R.slides}&view=cram`); await shot("cram--start"); }],
      ["every card", async () => { await button("every card").click(); await shot("cram--every-card"); }],
      ["a card", async () => { await page.getByRole("button", { name: /^Start/ }).click(); await page.waitForTimeout(600); await shot("cram--card"); }],
      ["revealed", async () => {
        if (phone) await page.getByRole("button", { name: /reveal/ }).first().click(); else await page.keyboard.press("Space");
        await shot("cram--revealed");
      }],
    ]),
    keeps: desk([
      ["every board", async () => { await open("/?view=keeps"); await shot("keeps--library"); }],
      ["one board", async () => { await open(`${R.slides}&view=keeps`); await shot("keeps--board"); }],
    ]),
    dashboard: both([
      ["board", async () => { await open("/dashboard"); await shot("dashboard--board", { full: true }); }],
      ["personal", async () => { await page.getByRole("tab", { name: /^Personal/ }).click(); await shot("dashboard--personal"); }],
      ["inbox", async () => { await page.getByRole("tab", { name: /^Inbox/ }).click(); await shot("dashboard--inbox", { full: true }); }],
      ["archive", async () => { await page.getByRole("tab", { name: /^Archive/ }).click(); await shot("dashboard--archive"); }],
      ["task", async () => {
        await page.getByRole("tab", { name: /^Board/ }).click(); await page.getByRole("tab", { name: /^Work/ }).click();
        await page.getByText("Show the review ladder on the strip").first().click(); await shot("dashboard--task");
      }],
      ["scratch pad", async () => { await open("/dashboard"); await button("Open the scratch pad").click(); await shot("dashboard--pad"); }],
    ]),
  };
}
