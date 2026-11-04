// Browser sessions, CDP plumbing and window measurement for the perf harness.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium, webkit } from "../pw.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INPAGE = readFileSync(join(HERE, "inpage.js"), "utf8");

export const ENGINES = { chromium, webkit };
export const VIEWPORT = { width: 1440, height: 1000 };

export async function launch(engine = "chromium") {
  const args = engine === "chromium" ? ["--enable-blink-features=LongAnimationFrameTiming"] : [];
  return ENGINES[engine].launch({ args });
}

export async function newSession({ browser, engine = "chromium", sw = false, arm = [], throttle = 1, latency = 0,
  viewport = VIEWPORT, route = null, trackComponents = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: sw ? "allow" : "block", viewport, deviceScaleFactor: 1 });
  await context.addInitScript(`window.__PERF_ARM = ${JSON.stringify(arm)};`);
  await context.addInitScript(INPAGE);
  if (trackComponents) await context.addInitScript("window.__perf && (window.__perf.trackComponents = true);");
  if (route) await route(context);
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  const errors = [], consoleMsgs = [];
  consoleMsgs.counts = {};
  page.on("pageerror", (e) => errors.push(String(e && e.message || e).slice(0, 300)));
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    // group repeats (pdf.js can warn hundreds of times per document)
    const k = `${m.type()}: ${m.text().replace(/[0-9]+/g, "#").slice(0, 120)}`;
    if (!(k in consoleMsgs.counts)) consoleMsgs.push(k);
    consoleMsgs.counts[k] = (consoleMsgs.counts[k] || 0) + 1;
  });
  let cdp = null;
  const netLog = [];
  if (engine === "chromium") {
    cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Network.enable");
    const reqs = new Map();
    cdp.on("Network.requestWillBeSent", (e) => reqs.set(e.requestId, { url: e.request.url, method: e.request.method, ts: e.timestamp }));
    cdp.on("Network.requestServedFromCache", (e) => { const r = reqs.get(e.requestId); if (r) r.memCache = true; });
    cdp.on("Network.responseReceived", (e) => {
      const r = reqs.get(e.requestId); if (!r) return;
      r.status = e.response.status; r.fromDisk = !!e.response.fromDiskCache; r.fromSW = !!e.response.fromServiceWorker;
      const h = e.response.headers || {};
      r.snapshot = !!(h["X-Strata-Snapshot"] || h["x-strata-snapshot"]);
      r.savedAt = !!(h["X-Strata-Saved-At"] || h["x-strata-saved-at"]);
    });
    cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (!r) return; r.bytes = e.encodedDataLength; r.end = e.timestamp; netLog.push(r); reqs.delete(e.requestId); });
    cdp.on("Network.loadingFailed", (e) => { const r = reqs.get(e.requestId); if (!r) return; r.failed = e.errorText; r.end = e.timestamp; netLog.push(r); reqs.delete(e.requestId); });
    if (throttle && throttle !== 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    // added latency: on localhost sequential requests cost nothing, on the tailnet each costs a round trip
    if (latency) await cdp.send("Network.emulateNetworkConditions", { offline: false, latency, downloadThroughput: -1, uploadThroughput: -1 });
  }
  return {
    engine, context, page, cdp, errors, console: consoleMsgs, netLog, throttle,
    async close() { await context.close().catch(() => {}); },
  };
}

export async function snapshot(s) {
  const inPage = await s.page.evaluate(() => {
    const P = window.__perf;
    return {
      t: performance.now(),
      commits: P ? P.commits.length : 0, tasks: P ? P.tasks.length : 0, longtasks: P ? P.longtasks.length : 0,
      loafs: P ? P.loafs.length : 0, events: P ? P.events.length : 0, errors: P ? P.errors.length : 0,
      res: performance.getEntriesByType("resource").length,
      origin: performance.timeOrigin,
      components: P && P.components ? JSON.parse(JSON.stringify(P.components)) : null,
    };
  });
  let metrics = null;
  if (s.cdp) {
    const { metrics: m } = await s.cdp.send("Performance.getMetrics");
    metrics = Object.fromEntries(m.map((x) => [x.name, x.value]));
  }
  return { ...inPage, metrics, net: s.netLog.length };
}

const METRIC_KEYS = ["ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount"];
const round = (v, d = 1) => (v == null || Number.isNaN(v) ? null : +(+v).toFixed(d));

export async function delta(s, a, b, opts = {}) {
  const same = a.origin === b.origin; // a navigation in between resets the page clock and lists
  const t0 = opts.t0 ?? (same ? a.t : 0);
  const from = (k) => (same ? a[k] : 0);
  const d = await s.page.evaluate(({ c, k, l, f, e, r, x }) => {
    const P = window.__perf;
    const res = performance.getEntriesByType("resource").slice(r).map((e2) => ({
      name: e2.name, type: e2.initiatorType, s: e2.startTime, end: e2.responseEnd,
      transfer: e2.transferSize, enc: e2.encodedBodySize, dec: e2.decodedBodySize,
    }));
    const nav = performance.getEntriesByType("navigation")[0];
    return {
      commits: P.commits.slice(c), tasks: P.tasks.slice(k), longtasks: P.longtasks.slice(l), loafs: P.loafs.slice(f),
      events: P.events.slice(e), errors: P.errors.slice(x), res,
      nav: nav && r === 0 ? { transfer: nav.transferSize, end: nav.responseEnd, dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd } : null,
      marks: { ...P.marks }, paints: { ...P.paints }, components: P.components,
    };
  }, { c: from("commits"), k: from("tasks"), l: from("longtasks"), f: from("loafs"), e: from("events"), r: from("res"), x: from("errors") });
  // React commit cost: the scheduler task a commit landed in, else event -> commit
  const taskEnd = new Map(d.tasks.map((t) => [t.s, t.s + t.d]));
  const commitCost = d.commits.map((c) => (c.dur != null ? c.dur : c.task != null && taskEnd.has(c.task) ? taskEnd.get(c.task) - c.task : c.evt ? c.t - c.evt.t : null));
  const known = commitCost.filter((v) => v != null);
  const lt = d.longtasks.filter((x) => x.s >= t0 - 1);
  const out = {
    commits: d.commits.length,
    commitMs: { sum: round(known.reduce((p, v) => p + v, 0)), max: round(known.length ? Math.max(...known) : 0), measured: known.length, exact: d.commits.some((c) => c.dur != null) },
    reactTaskMs: round(d.tasks.reduce((p, t) => p + t.d, 0)),
    longtasks: { n: lt.length, ms: round(lt.reduce((p, x) => p + x.d, 0)), max: round(lt.length ? Math.max(...lt.map((x) => x.d)) : 0) },
    loafs: d.loafs.filter((x) => x.s >= t0 - 1),
    events: d.events,
    errors: d.errors,
    marks: d.marks, paints: d.paints, nav: d.nav, components: diffComponents(same ? a.components : null, d.components),
    requests: d.res.length + (d.nav ? 1 : 0),
    bytes: d.res.reduce((p, x) => p + (x.transfer || 0), 0) + (d.nav ? d.nav.transfer || 0 : 0),
    resources: d.res,
    netQuiet: round(Math.max(0, ...d.res.map((x) => x.end), d.nav ? d.nav.end : 0)),
  };
  if (a.metrics && b.metrics) {
    out.cpu = {};
    for (const k of METRIC_KEYS) {
      const va = a.metrics[k] ?? 0, vb = b.metrics[k] ?? 0;
      const v = same && vb >= va ? vb - va : vb;
      out.cpu[k] = k.endsWith("Count") ? v : round(v * 1000);
    }
    out.cpu.nodes = b.metrics.Nodes; out.cpu.heapMB = round(b.metrics.JSHeapUsedSize / 1048576);
  }
  out.cdpNet = s.netLog.slice(a.net, b.net).map((r) => ({ url: r.url, m: r.method, st: r.status, bytes: r.bytes,
    disk: r.fromDisk, mem: r.memCache, sw: r.fromSW, snapshot: r.snapshot, saved: r.savedAt, failed: r.failed }));
  return out;
}

function diffComponents(a, b) {
  if (!b) return null;
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    const p = (a && a[k]) || { renders: 0, selfMs: 0 };
    const n = v.renders - p.renders; if (n > 0) out[k] = { renders: n, selfMs: round(v.selfMs - p.selfMs, 2) };
  }
  return Object.fromEntries(Object.entries(out).sort((x, y) => y[1].selfMs - x[1].selfMs).slice(0, 25));
}

export async function startProfile(s, intervalUs = 100) {
  if (!s.cdp) return false;
  await s.cdp.send("Profiler.enable");
  await s.cdp.send("Profiler.setSamplingInterval", { interval: intervalUs });
  await s.cdp.send("Profiler.start");
  return true;
}
export async function stopProfile(s) {
  if (!s.cdp) return null;
  const { profile } = await s.cdp.send("Profiler.stop");
  await s.cdp.send("Profiler.disable");
  return profile;
}

export async function waitMarks(s, names, timeout = 90_000) {
  await s.page.waitForFunction((ns) => ns.every((n) => window.__perf && window.__perf.marks[n] != null), names, { timeout, polling: 50 });
  return s.page.evaluate((ns) => Object.fromEntries(ns.map((n) => [n, window.__perf.marks[n]])), names);
}
export const arm = (s, names) => s.page.evaluate((ns) => window.__perf.arm(ns), names);
/** Wait until no request has been in flight for `quietMs` (Playwright's networkidle is 500 ms). */
export async function netIdle(s, timeout = 60_000) {
  await s.page.waitForLoadState("networkidle", { timeout }).catch(() => {});
}
export async function nextEventTs(s, type) {
  await s.page.evaluate((ty) => {
    window.__perf.evTs = window.__perf.evTs || {};
    delete window.__perf.evTs[ty];
    addEventListener(ty, (e) => { window.__perf.evTs[ty] = e.timeStamp; }, { capture: true, once: true });
  }, type);
  return async () => s.page.evaluate((ty) => window.__perf.evTs[ty], type);
}

export function stats(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const pick = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  return { n: v.length, median: round(v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2),
    p90: round(pick(0.9)), min: round(v[0]), max: round(v[v.length - 1]), mean: round(v.reduce((a, b) => a + b, 0) / v.length) };
}
