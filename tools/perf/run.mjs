// node tools/perf/run.mjs [--base URL] [--scenarios a,b] [--runs N] [--latency MS] [--profile]: time journeys
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/harness.mjs";
import { loadMaps, analyzeProfile } from "./lib/sourcemap.mjs";
import { REPO } from "./pw.mjs";
import * as S from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf("--" + k); return i < 0 ? d : argv[i + 1]; };
const flag = (k) => argv.includes("--" + k);
const base = opt("base", "http://127.0.0.1:8899").replace(/\/$/, "");
const engine = opt("engine", "chromium");
const runs = Number(opt("runs", 5));
const throttles = opt("throttle", engine === "chromium" ? "1,4" : "1").split(",").map(Number);
const scen = opt("scenarios", "home,board,pdf-large,pdf-marked,scroll-large,scroll-marked,highlight,prose,chat").split(",");
const out = opt("out", join(HERE, "out", `${engine}-${new Date().toISOString().replace(/[:.]/g, "-")}`));
const targets = JSON.parse(readFileSync(opt("targets", join(HERE, "targets.json")), "utf8"));
const reactProf = opt("react-profiling", null);
const latency = argv.includes("--latency") ? Number(opt("latency", 0)) : undefined;
mkdirSync(join(out, "profiles"), { recursive: true });
const maps = loadMaps(reactProf || join(REPO, "dist"), REPO);

// titles stay in memory and never reach the output
const titles = Object.fromEntries((await (await fetch(base + "/api/boards")).json()).boards.map((b) => [b.id, b.title]));

const route = reactProf ? async (context) => {
  await context.route(/\/dist\/.*\.js(\?.*)?$/, async (r) => {
    const p = new URL(r.request().url()).pathname.replace(/^.*\/dist\//, "");
    const file = join(reactProf, p);
    if (existsSync(file)) return r.fulfill({ status: 200, contentType: "text/javascript", body: readFileSync(file) });
    return r.continue();
  });
} : null;

const T = targets;
const table = {
  home: (env) => S.home(env),
  board: (env) => S.board(env),
  "pdf-large": (env) => S.pdfOpen(env, T.largestPdf, "large"),
  "pdf-marked": (env) => S.pdfOpen(env, T.markedPdf, "marked"),
  "scroll-large": (env) => S.pdfScroll(env, T.largestPdf, "large"),
  "scroll-marked": (env) => S.pdfScroll(env, T.markedPdf, "marked"),
  highlight: (env) => S.highlight(env, T.markedPdf, T.markedPdf.page),
  prose: (env) => S.prose(env, T.largestProse),
  chat: (env) => S.chat(env, T.chat),
  "flip-prose": (env) => S.flip(env, T.largestProse, "prose"),
  "flip-pdf": (env) => S.flip(env, T.markedPdf, "pdf"),
  "cards-only": (env) => S.cardsOnly(env, T.largestProse),
  idle: async (env) => [await S.idle(env, "home"), await S.idle(env, "pdf", T.markedPdf), await S.idle(env, "pdf-chat", T.chat)],
  sw: async (env) => [...await S.swHome(env), ...await S.swPdf(env, T.markedPdf)],
  continue: (env) => S.continueBoard(env, T.markedPdf),
  "deck-open": (env) => S.deckOpen(env, T.biggestBoard.id),
  review: (env) => S.reviewOpen(env),
  "reload-reader": (env) => S.reloadReader(env, T.markedPdf),
  "board-page": (env) => S.boardPage(env, T.chat),
  reader: (env) => S.readerTools(env, T.markedPdf),
};

const results = join(out, "results.jsonl");
writeFileSync(join(out, "meta.json"), JSON.stringify({ base, engine, runs, throttles, scenarios: scen, reactProf: !!reactProf, targets, at: new Date().toISOString() }, null, 2));
const browser = await launch(engine);
let failures = 0;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
try {
  for (const name of scen) {
    if (!table[name]) { log("unknown scenario", name); continue; }
    for (const throttle of throttles) {
      const n = name === "idle" ? 1 : runs;
      for (let i = 0; i < n; i++) {
        const env = { browser, engine, base, throttle, latency, sw: false, profile: false, targets: T, titles, route, trackComponents: !!reactProf, saveProfile() {} };
        try {
          const recs = [].concat(await table[name](env));
          for (const r of recs) {
            appendFileSync(results, JSON.stringify({ engine, throttle, run: i, react: reactProf ? "profiling" : "prod", ...r }) + "\n");
            log(`${name} ${throttle}x #${i} ${r.scenario}/${r.variant}: ${r.t.ms} ms  commits=${r.w.commits} lt=${r.w.longtasks.n}/${r.w.longtasks.ms}ms req=${r.w.requests}`);
          }
        } catch (e) { failures++; log(`FAIL ${name} ${throttle}x #${i}: ${e.message.split("\n")[0]}`); appendFileSync(results, JSON.stringify({ engine, throttle, run: i, scenario: name, error: e.message.slice(0, 500) }) + "\n"); }
      }
    }
    if (flag("profile") && engine === "chromium" && name !== "idle" && name !== "sw") {
      const throttle = Number(opt("profile-throttle", 4));
      const env = { browser, engine, base, throttle, latency, sw: false, profile: true, sampleUs: 100, targets: T, titles, route, trackComponents: !!reactProf,
        saveProfile(pname, profile) {
          const file = join(out, "profiles", `${pname}-${throttle}x`);
          writeFileSync(file + ".cpuprofile", JSON.stringify(profile));
          writeFileSync(file + ".json", JSON.stringify(analyzeProfile(profile, maps, { top: 20 }), null, 2));
          log(`  profile ${pname}-${throttle}x saved`);
        } };
      try {
        const recs = [].concat(await table[name](env));
        for (const r of recs) appendFileSync(results, JSON.stringify({ engine, throttle, run: "profiled", react: reactProf ? "profiling" : "prod", ...r }) + "\n");
      } catch (e) { failures++; log(`FAIL profiled ${name}: ${e.message.split("\n")[0]}`); }
    }
  }
} finally { await browser.close(); }
log(`done → ${out} (${failures} failures)`);
