// Today without the day counter, a starred project first on Today and Projects, and a plain Delete on a project's source.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = (process.argv[2] || "http://127.0.0.1:8804").replace(/\/+$/, "");
const api = async (path, method = "GET", body) => {
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
};
const stamp = Date.now();
const board = (await api("/api/boards", "POST", { title: `Starred fixture ${stamp}` })).board;
const add = async (filename, text) => (await api(`/api/boards/${board.id}/resources`, "POST", { filename, text, pair: true })).id;
const doomed = await add(`Doomed ${stamp}.md`, "# Doomed\n\n" + "A source with a note on it. ".repeat(40));
const stays = await add(`Stays ${stamp}.md`, "# Stays\n\n" + "A source that stays. ".repeat(40));
await api(`/api/boards/${board.id}/marks`, "POST", { resourceId: doomed, start: 0, end: 8, quote: "A source", note: "a note" });

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
try {
  const page = await (await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } })).newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.locator(".td-proj, .today.clear").first().waitFor();
  if (await page.locator(".today.clear").count()) await page.getByRole("button", { name: "Keep reading anyway", exact: true }).click();
  const side = page.locator(".td-side");
  await side.locator(".td-proj").filter({ hasText: board.title }).waitFor();
  assert.ok(!/Day \d+/.test(await side.innerText()), "Today's projects column has no day counter");
  assert.ok(!/Day \d+/.test(await page.getByRole("navigation", { name: "Strata" }).innerText()), "nor does the top bar");

  await side.getByRole("button", { name: "Star " + board.title, exact: true }).click();
  await side.getByRole("button", { name: "Unstar " + board.title, exact: true }).waitFor();
  assert.equal(await side.locator(".td-pcell").first().locator(".td-proj-name").innerText(), board.title, "a starred project sorts first on Today");
  await page.waitForLoadState("networkidle");
  assert.equal(typeof (await api(`/api/boards/${board.id}`)).plan.starredAt, "number", "the star is saved on the server");

  await page.getByRole("navigation", { name: "Strata" }).getByRole("button", { name: "Projects", exact: true }).click();
  const first = page.locator(".pj-cell").first();
  await first.locator(".pj-title").filter({ hasText: board.title }).waitFor();
  assert.equal(await first.getByRole("button", { name: "Unstar " + board.title, exact: true }).getAttribute("aria-pressed"), "true");

  await first.locator(".pj-card").click();
  await page.locator(".pp-title").filter({ hasText: board.title }).waitFor();
  const row = page.locator(".pp-src").filter({ has: page.locator(".pp-sname", { hasText: "Doomed" }) });
  await row.locator(".pp-del").click();
  const ask = row.getByRole("alertdialog");
  assert.match(await ask.innerText(), /1 note goes with it/, "the confirm says what goes");
  await ask.getByRole("button", { name: "Cancel", exact: true }).click();
  await ask.waitFor({ state: "detached" });
  await row.locator(".pp-del").click();
  await ask.getByRole("button", { name: "Delete", exact: true }).click();
  await row.waitFor({ state: "detached" });
  await page.waitForLoadState("networkidle");
  const ids = (await api(`/api/boards/${board.id}`)).resources.map((r) => r.id);
  assert.deepEqual([ids.includes(doomed), ids.includes(stays)], [false, true], "only the deleted source goes");
  assert.deepEqual(errors, []);
  console.log("projects smoke: no day counter, a starred project first, a source deleted after its confirm");
} finally {
  await browser.close();
  await fetch(`${base}/api/boards/${board.id}`, { method: "DELETE" }).catch(() => {});
}
