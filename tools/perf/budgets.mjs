// npm run perf | node tools/perf/budgets.mjs [--serve [--fresh] | URL]: check budgets.json on the fixture
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/harness.mjs";
import { judge } from "./judge.mjs";
import * as S from "./scenarios.mjs";
import { REPO } from "./pw.mjs";
import { until } from "../settled.mjs";
import { agentReads } from "./agent.mjs";
import { staleDist } from "../dist-fresh.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
// the bundle budgets read dist/ directly, so an old build would be judged instead of this source
const stale = staleDist();
if (stale) { console.error(`${stale} — run node tools/build.mjs`); process.exit(2); }
const base = (argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:8805").replace(/\/$/, "");
// --serve copies the cached fixture so a run never dirties it (--fresh rebuilds it)
if (argv.includes("--serve")) {
  const dir = join(REPO, "data", "perf"), fixture = join(dir, "fixture.db"), run = join(dir, "run.db");
  if (argv.includes("--fresh") || !existsSync(fixture)) {
    const made = spawnSync(process.execPath, [join(REPO, "tools", "perf-fixture.mjs"), fixture], { stdio: "inherit" });
    if (made.status !== 0) process.exit(2);
  }
  for (const f of [run, `${run}-wal`, `${run}-shm`]) rmSync(f, { force: true });
  rmSync(join(dir, "blob-cache"), { recursive: true, force: true });
  copyFileSync(fixture, run);
  const server = spawn(process.execPath, ["server/main.ts"], { cwd: REPO, stdio: "ignore", env: { ...process.env,
    STRATA_DB: run, STRATA_PORT: new URL(base).port, STRATA_OPEN: "1", STRATA_FAKE_MODEL: "1", GEMINI_API_KEY: "",
    TAVILY_API_KEY: "", FIRECRAWL_API_KEY: "", STRATA_COURSES: join(REPO, "test", "fixtures", "courses") } });
  process.on("exit", () => server.kill());
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    up = await fetch(base + "/api/health").then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) { console.error("the fixture server did not come up"); process.exit(2); }
}
const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(HERE, "out", "budgets");
mkdirSync(outDir, { recursive: true });
const budgets = JSON.parse(readFileSync(join(HERE, "budgets.json"), "utf8"));
// a line in a shape judge.mjs does not read is refused now, not after the journeys have run
for (const limits of Object.values(budgets.scenarios)) for (const limit of Object.values(limits)) judge(limit, 0);

const survey = spawnSync(process.execPath, [join(HERE, "survey.mjs"), base], { encoding: "utf8" });
if (survey.status !== 0) { console.error(survey.stderr); process.exit(2); }
const T = JSON.parse(survey.stdout);
const titles = Object.fromEntries((await (await fetch(base + "/api/boards")).json()).boards.map((b) => [b.id, b.title]));

const results = [];
const measured = {};
// the highlight's variant names whichever page the survey picked; the budget names the journey
const record = (r) => { measured[r.scenario === "highlight" ? "highlight/marked" : `${r.scenario}/${r.variant}`] = r; };

for (const [file, limit] of Object.entries(budgets.bundle)) {
  const bytes = readFileSync(join(REPO, file));
  measured[`bundle/${file}`] = { gzipKB: Math.round(gzipSync(bytes).length / 1024) };
  void limit;
}

const kb = async (path) => Math.round((await (await fetch(base + path)).text()).length / 1024);
measured["payload/boards"] = { KB: await kb("/api/boards") };
measured["payload/register"] = { KB: await kb("/api/register") };
measured["payload/biggest-board"] = { KB: await kb(`/api/boards/${T.biggestBoard.id}`) };
// the board state carries every mark on the board, so the most-marked board is the heaviest read
measured["payload/marked-board"] = { KB: await kb(`/api/boards/${T.markedPdf.board}`) };

try { for (const r of await agentReads(base, T)) record(r); }
catch (e) { measured["agent/error"] = { error: e.message.split("\n")[0] }; }

const browser = await launch("chromium");
try {
  const env = { browser, engine: "chromium", base, throttle: 1, sw: false, profile: false, targets: T, titles, route: null, saveProfile() {} };
  const run = async (name, fn) => {
    try { for (const r of [].concat(await fn())) record(r); }
    catch (e) { measured[`${name}/error`] = { error: e.message.split("\n")[0] }; }
  };
  await run("home", () => S.home(env));
  await run("sw", () => S.swHome(env));
  await run("board", () => S.board(env));
  await run("pdf-large", () => S.pdfOpen(env, T.largestPdf, "large"));
  await run("pdf-marked", () => S.pdfOpen(env, T.markedPdf, "marked"));
  await run("scroll-marked", () => S.pdfScroll(env, T.markedPdf, "marked"));
  await run("highlight", () => S.highlight(env, T.markedPdf, T.markedPdf.page));
  await run("reader", () => S.readerTools(env, T.markedPdf));
  await run("flip-prose", () => S.flip(env, T.largestProse, "prose"));
  await run("flip-pdf", () => S.flip(env, T.markedPdf, "pdf"));
  await run("cards-only", () => S.cardsOnly(env, T.largestProse));
  await run("chat", () => S.chat(env, T.chat));
  await run("idle", async () => [await S.idle(env, "home"), await S.idle(env, "pdf-chat", T.chat)]);
  await run("reader-cache", () => readerCache(browser, T.markedPdf));
  await run("board-page", () => S.boardPage(env, T.chat));
  await run("reload-reader", () => S.reloadReader(env, T.markedPdf));
  // last: Continue makes the marked board the one home fronts, which the journeys above do not expect
  await run("continue", () => S.continueBoard(env, T.markedPdf));
  await run("deck-open", () => S.deckOpen(env, T.biggestBoard.id));
  await run("review", () => S.reviewOpen(env));
} finally { await browser.close(); }

// a book opened twice is downloaded once: the reopen's copy comes from the worker's reader cache
async function readerCache(b, t) {
  const context = await b.newContext({ serviceWorkers: "allow", viewport: { width: 1440, height: 1000 } });
  const fetches = [];
  context.on("request", (r) => { if (r.serviceWorker() && /\/raw$/.test(new URL(r.url()).pathname)) fetches.push(r.url()); });
  try {
    const page = await context.newPage();
    await page.goto(base + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30_000 });
    // the worker files its copy after answering, so wait until the reader cache lists this book
    const filed = () => page.evaluate(async (id) => {
      const index = await (await caches.open("strata-reader-v1")).match(new URL("__reader-index__", location.href).href);
      return !!index && (await index.json()).some((e) => e.url.endsWith(`/resources/${id}/raw`));
    }, t.id);
    const open = async () => {
      await page.goto(`${base}/?board=${t.board}&resource=${t.id}${t.pair ? `&pair=${t.pair}` : ""}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".slide canvas", { timeout: 90_000 });
      await page.waitForLoadState("networkidle").catch(() => {});
      await until(filed, { what: "the service worker to file the book in its reader cache", timeout: 30_000 });
    };
    await open(); const first = fetches.length;
    await open(); const again = fetches.length - first;
    return { scenario: "reader-cache", variant: "reopen", t: { firstOpenFetches: first, reopenFetches: again }, w: {}, pageErrors: [] };
  } finally { await context.close(); }
}

const get = (obj, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), obj);
for (const [key, limits] of Object.entries(budgets.scenarios)) {
  const r = measured[key];
  for (const [metric, limit] of Object.entries(limits)) {
    const value = r ? get(r, metric) : undefined;
    const { ok, bound } = judge(limit, value);
    results.push({ key, metric, value: value ?? (r ? "missing" : "not measured"), bound, ok });
  }
}
for (const [file, limit] of Object.entries(budgets.bundle)) {
  const v = measured[`bundle/${file}`].gzipKB;
  results.push({ key: `bundle ${file}`, metric: "gzip KB", value: v, bound: `≤ ${limit}`, ok: v <= limit });
}
for (const [name, limit] of Object.entries(budgets.payloadsKB)) {
  const v = measured[`payload/${name}`].KB;
  results.push({ key: `payload ${name}`, metric: "KB", value: v, bound: `≤ ${limit}`, ok: v <= limit });
}
for (const [key, r] of Object.entries(measured)) {
  if (r.error) results.push({ key, metric: "ran", value: r.error, bound: "no error", ok: false });
  const errs = (r.pageErrors || []).length;
  if (errs) results.push({ key, metric: "page errors", value: errs, bound: "= 0", ok: false });
  const decode = Object.keys(r.console || {}).filter((m) => /failed to initialize|Unable to decode image/i.test(m));
  if (decode.length) results.push({ key, metric: "pdf.js decode failures", value: decode.join("; ").slice(0, 120), bound: "none", ok: false });
}

const failed = results.filter((x) => !x.ok);
const line = (x) => `${x.ok ? "  ok " : "FAIL "} ${x.key.padEnd(34)} ${String(x.metric).padEnd(30)} ${String(x.value).padStart(10)}  ${x.bound}`;
const report = [`perf budgets against ${base} (fixture: ${T.boards} boards, ${T.resources} sources)`, ...results.map(line),
  failed.length ? `\n${failed.length} budget(s) exceeded. If the change is worth it, raise the budget in tools/perf/budgets.json and say why in the PR.` : "\nall budgets met"].join("\n");
console.log(report);
writeFileSync(join(outDir, "report.txt"), report + "\n");
writeFileSync(join(outDir, "measured.json"), JSON.stringify({ targets: T, measured }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, "## Performance budgets\n\n```\n" + report + "\n```\n", { flag: "a" });
process.exit(failed.length ? 1 : 0);
