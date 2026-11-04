#!/usr/bin/env node
// node tools/race/run.mjs [--seeds N | --seed S] [--only a,b] [--shard i/n] [--list] [--base URL --db FILE]
// --base must be a throwaway room: scenarios write grades that deleting their board does not remove.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { cappedOn, installNetwork, rngFor, wireOf } from "./network.mjs";
import { ROOM_ENV, scenarios } from "./scenarios.mjs";
import { serveRoom } from "./serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
/* { scenario: { "check, in its words": "why it fails today" } } — every name must exist */
const KNOWN = JSON.parse(readFileSync(join(HERE, "known-failures.json"), "utf8"));
for (const [name, checks] of Object.entries(KNOWN)) {
  const s = scenarios.find((x) => x.name === name);
  if (!s) { console.error(`known-failures.json names "${name}", which is not a scenario`); process.exit(2); }
  if (!checks || typeof checks !== "object") { console.error(`known-failures.json: "${name}" must map its failing checks to reasons`); process.exit(2); }
  for (const check of Object.keys(checks)) if (!Object.values(s.checks).includes(check)) {
    console.error(`known-failures.json: "${name}" makes no check "${check}" (its checks: ${Object.values(s.checks).map((c) => JSON.stringify(c)).join(", ")})`);
    process.exit(2);
  }
}
const knownWhy = (scenario, check) => KNOWN[scenario]?.[check] ?? null;

if (argv.includes("--list")) {
  for (const s of scenarios) {
    console.log(`${s.name.padEnd(26)} ${s.what}`);
    for (const check of Object.values(s.checks)) {
      const why = knownWhy(s.name, check);
      console.log(`${"".padEnd(26)} ${why ? "✗" : "·"} ${check}${why ? `\n${"".padEnd(30)}fails today: ${why}` : ""}`);
    }
  }
  process.exit(0);
}
const only = opt("only") ? opt("only").split(",") : null;
const unknownNames = (only || []).filter((n) => !scenarios.some((s) => s.name === n));
if (unknownNames.length) { console.error(`no such scenario: ${unknownNames.join(", ")} (--list)`); process.exit(2); }
// --shard i/n runs every n-th scenario from the i-th, so a new scenario lands in a shard unlisted
const shard = opt("shard") ? opt("shard").split("/").map(Number) : null;
if (shard && !(shard[1] >= 1 && shard[0] >= 1 && shard[0] <= shard[1])) { console.error(`--shard wants i/n with 1 ≤ i ≤ n, not ${opt("shard")}`); process.exit(2); }
const chosen = scenarios.filter((s) => !only || only.includes(s.name))
  .filter((_, k) => !shard || k % shard[1] === shard[0] - 1);
const seeds = opt("seed") ? [Number(opt("seed"))] : Array.from({ length: Number(opt("seeds", 3)) }, (_, i) => i + 1);

class Trial {
  constructor({ browser, base, db, seed, scenario }) {
    Object.assign(this, { browser, base, dbPath: db, seed, scenario });
    this.checks = [];
    this.notes = [];
    this.errors = [];
    this.cleanups = [];
    this.net = null;
    this.page = null;
    this.nets = [];
  }
  say(line) { this.notes.push(line); }
  rng(label) { return rngFor(this.seed, `${this.scenario.name}:${label}`); }
  async open(modes, contextOptions = {}) {
    this.context = await this.browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 }, ...contextOptions });
    this.page = this.watch(await this.context.newPage());
    this.net = await installNetwork(this.page, { base: this.base, seed: this.seed, modes, say: (l) => this.say(l) });
    return this.page;
  }
  async tab(modes, seedOffset = 1000 * (this.nets.length + 1)) {
    if (!this.context) throw new Error("a second tab needs the first: t.open before t.tab");
    const n = this.nets.length + 2;
    const page = this.watch(await this.context.newPage());
    const net = await installNetwork(page, { base: this.base, seed: this.seed + seedOffset, modes, say: (l) => this.say(`tab ${n}: ${l}`) });
    this.nets.push(net);
    return { page, net };
  }
  watch(page) {
    // generous: the gate shares a machine with other checks, and a wait is never the invariant
    page.setDefaultTimeout(45_000);
    page.on("pageerror", (e) => this.errors.push(e.message));
    return page;
  }
  async api(path, method = "GET", body) {
    const r = await fetch(this.base + path, { method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r.status === 204 ? null : r.json();
  }
  sql(query, ...params) {
    if (!this.dbPath) throw new Error(`${this.scenario.name} reads the database — pass --db with --base`);
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try { return db.prepare(query).all(...params); } finally { db.close(); }
  }
  check(key, ok, detail = "") {
    const name = this.scenario.checks[key];
    if (!name) throw new Error(`${this.scenario.name} makes a check it does not declare: "${key}"`);
    this.checks.push({ key, name, ok: !!ok, detail });
  }
  later(fn) { this.cleanups.push(fn); }
  async close() {
    this.net?.close();
    for (const net of this.nets) net.close();
    await this.context?.close().catch(() => {});
    for (const fn of this.cleanups.reverse()) await Promise.resolve().then(fn).catch(() => {});
  }
}

async function trial(browser, room, scenario, seed) {
  const t = new Trial({ browser, base: room.base, db: room.db, seed, scenario });
  const started = performance.now();
  let error = null, wire = {};
  try {
    await scenario.run(t);
    // a verdict needs every declared check, made once, on a pinned interleaving; otherwise the trial errored
    const missing = Object.entries(scenario.checks).filter(([k]) => t.checks.filter((c) => c.key === k).length !== 1);
    if (missing.length) throw new Error(`checks not made exactly once: ${missing.map(([, n]) => JSON.stringify(n)).join(", ")}`);
    const capped = cappedOn([t.net, ...t.nets]);
    if (capped.length) throw new Error(`a hold ran out before it was released (${capped.map((e) => `${e.method} ${e.path.split("?")[0]}`).join(", ")}) — the interleaving was not pinned`);
  }
  catch (e) { error = e; }
  finally { wire = wireOf([t.net, ...t.nets]); await t.close(); }
  const failed = t.checks.filter((c) => !c.ok);
  const outcome = error ? "error" : failed.length ? "fail" : "pass";
  return { scenario: scenario.name, seed, outcome, ms: performance.now() - started, checks: t.checks, failed,
    error: error ? (error.stack || String(error)).split("\n").slice(0, 3).join("\n      ") : null,
    wire, pageErrors: t.errors, notes: t.notes };
}

const base = argv.find((a) => /^https?:\/\//.test(a)) || opt("base");
const room = base ? { base: base.replace(/\/$/, ""), db: opt("db"), stop: async () => {} } : await serveRoom({ label: "race", env: ROOM_ENV });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: !argv.includes("--headed") });
const results = [];
console.log(`race: ${chosen.length} scenario${chosen.length === 1 ? "" : "s"} × seed${seeds.length === 1 ? "" : "s"} ${seeds.join(", ")} against ${room.base}, ${opt("jobs", 3)} at a time`);
// trials run side by side, but never two seeds of one scenario: the imports list is shared room-wide
const jobs = Math.max(1, Number(opt("jobs", 3)));
const queues = new Map(chosen.map((s) => [s, [...seeds]]));
const busy = new Set();
const report = (r) => {
  const mark = r.outcome === "pass" ? "✓" : r.outcome === "fail" ? "✗" : "!";
  const wire = Object.entries(r.wire).filter(([k]) => k !== "ok" && k !== "open").map(([k, v]) => `${v} ${k}`).join(", ");
  const lines = [`${mark} ${r.scenario} · seed ${r.seed} · ${(r.ms / 1000).toFixed(1)}s${wire ? ` · wire: ${wire}` : ""}${r.retried ? " · ran on the second try" : ""}`];
  if (r.retried) lines.push(`    (the first try could not run: ${r.retried})`);
  for (const c of r.failed) lines.push(`    ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}${knownWhy(r.scenario, c.name) ? "  (known)" : "  (NEW)"}`);
  if (r.error) lines.push(`    ! ${r.error}`);
  if (r.outcome !== "pass" && r.pageErrors.length) lines.push(`    page errors: ${r.pageErrors.slice(0, 2).join(" | ")}`);
  if (argv.includes("--verbose")) lines.push(...r.notes.map((n) => `    · ${n}`));
  console.log(lines.join("\n"));
};
async function worker() {
  for (;;) {
    const next = [...queues].find(([s, left]) => left.length && !busy.has(s));
    if (!next) {
      if (![...queues.values()].some((left) => left.length)) return;
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    const [scenario, left] = next;
    const seed = left.shift();
    busy.add(scenario);
    try {
      // only a trial that could not run is retried; retrying a broken invariant would wave a flaky race through
      let r = await trial(browser, room, scenario, seed);
      if (r.outcome === "error") {
        const first = r.error.split("\n")[0];
        r = await trial(browser, room, scenario, seed);
        r.notes.unshift(`retried once after: ${first}`);
        if (r.outcome !== "error") r.retried = first;
      }
      results.push(r);
      report(r);
    }
    finally { busy.delete(scenario); }
  }
}
const startedAt = performance.now();
try {
  await Promise.all(Array.from({ length: jobs }, worker));
} finally {
  await browser.close();
  await room.stop();
}

// an unlisted failing check is a new race; a listed check that held on every seed is fixed
const problems = [];
let holding = 0, knownFailing = 0;
console.log("\n━━ race ━━");
for (const s of chosen) {
  const runs = results.filter((r) => r.scenario === s.name);
  const errored = runs.filter((r) => r.outcome === "error");
  if (errored.length) {
    console.log(`  ERROR ${s.name}  (seed ${errored.map((r) => r.seed).join(", ")} could not run)`);
    problems.push(`${s.name} could not run — the harness is broken, not the room`);
    continue;
  }
  const lines = [];
  let failing = false;
  for (const check of Object.values(s.checks)) {
    const failedOn = runs.filter((r) => r.failed.some((c) => c.name === check)).map((r) => r.seed);
    const why = knownWhy(s.name, check);
    if (failedOn.length) failing = true;
    if (failedOn.length && !why) {
      lines.push(`      ✗ ${check}  — NEW, fails on seed ${failedOn.join(", ")}`);
      problems.push(`${s.name}: "${check}" fails and is not a known failure — a new race`);
    } else if (failedOn.length) {
      knownFailing++;
      lines.push(`      ✗ ${check}  (known: ${why})`);
    } else if (why) {
      lines.push(`      ✓ ${check}  — now passing on every seed`);
      problems.push(`now passing — remove "${check}" under ${s.name} from tools/race/known-failures.json`);
    } else holding++;
  }
  console.log(`  ${failing ? "FAIL " : "pass "} ${s.name}${lines.length ? `\n${lines.join("\n")}` : ""}`);
}
if (problems.length) {
  console.log(`\nrace FAILED\n${problems.map((p) => `  · ${p}`).join("\n")}`);
  console.log(`  reproduce one: node tools/race/run.mjs --only <scenario> --seed <seed> --verbose`);
  process.exit(1);
}
console.log(`\nrace passed in ${Math.round((performance.now() - startedAt) / 1000)}s — ${holding} check${holding === 1 ? " holds" : "s hold"}; ${knownFailing} known failure${knownFailing === 1 ? " still fails" : "s still fail"} as recorded`);
