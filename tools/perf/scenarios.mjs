// Hot-path scenarios: each takes an env and returns one run's record { scenario, variant, t, w, extra }.
import { newSession, snapshot, delta, startProfile, stopProfile, waitMarks, arm, netIdle, nextEventTs } from "./lib/harness.mjs";

const r1 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10) / 10);
const SETTLE_MS = 4500; // the reader sweeps on a 250 ms interval for its first 4 s after opening
const INTERACTIONS = new Set(["click", "pointerdown", "pointerup", "mousedown", "mouseup", "keydown", "keyup", "keypress", "input", "beforeinput"]);

async function session(env, arms = []) {
  return newSession({ browser: env.browser, engine: env.engine, sw: env.sw, throttle: env.throttle, latency: env.latency || 0, arm: arms,
    trackComponents: !!env.trackComponents, route: env.route });
}
// network-bound journeys run at the tailnet's round trip: on localhost a request costs nothing
const TAILNET_MS = 40;
const onTailnet = (env) => ({ ...env, latency: env.latency ?? TAILNET_MS });
/** Profile fn() when env.profile is set; a same-origin warm-up keeps navigation in the profiled renderer. */
async function profiled(env, s, name, fn) {
  const on = !!(env.profile && s.cdp);
  if (on) await startProfile(s, env.sampleUs || 100);
  try { return await fn(); }
  finally { if (on) env.saveProfile(name, await stopProfile(s)); }
}
const pdfUrl = (base, t) => `${base}/?board=${t.board}&resource=${t.id}${t.pair ? `&pair=${t.pair}` : ""}`;
const popTo = (s, url) => s.page.evaluate((u) => { history.pushState(null, "", u); dispatchEvent(new PopStateEvent("popstate")); }, url);
function windowOf(d) {
  return {
    commits: d.commits, commitMs: d.commitMs, reactTaskMs: d.reactTaskMs, longtasks: d.longtasks,
    requests: d.requests, bytes: d.bytes, cpu: d.cpu, errors: d.errors,
    loafs: d.loafs.map((l) => ({ s: r1(l.s), d: r1(l.d), block: r1(l.block), scripts: l.scripts.slice(0, 6) })),
    events: d.events.filter((e) => INTERACTIONS.has(e.name)).map((e) => ({ name: e.name, d: e.d, delay: r1(e.delay), proc: r1(e.proc), tgt: e.tgt })),
    components: d.components,
  };
}
const takeConsole = (s) => { const c = { ...s.console.counts }; s.console.length = 0; s.console.counts = {}; return c; };
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const inkCheck = (s, sel) => s.page.evaluate((sel2) => {
  const cv = document.querySelector(sel2); if (!cv || !cv.width) return false;
  const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 0; i < d.length; i += 4 * 97) if (d[i + 3] > 0 && (d[i] < 220 || d[i + 1] < 220 || d[i + 2] < 220)) return true;
  return false;
}, sel);

export async function home(env) {
  const s = await session(env, ["homeDoors", "homeLibrary"]);
  try {
    await s.page.goto(env.base + "/api/health");
    const a = await snapshot(s);
    await profiled(env, s, "home", async () => {
      await s.page.goto(env.base + "/", { waitUntil: "domcontentloaded" });
      await waitMarks(s, ["homeDoors", "homeLibrary"]);
      await netIdle(s);
    });
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    return { scenario: "home", variant: env.sw ? "cold+sw" : "cold",
      t: { ms: r1(d.marks.homeLibrary), doors: r1(d.marks.homeDoors), library: r1(d.marks.homeLibrary),
        libraryPaint: r1(d.marks["homeLibrary:paint"]), fcp: r1(d.paints["first-contentful-paint"]), lcp: r1(d.paints.lcp),
        dcl: r1(d.nav && d.nav.dcl), netQuiet: d.netQuiet },
      w: windowOf(d), net: summarizeNet(d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally { await s.close(); }
}

function summarizeNet(d) {
  const by = {};
  for (const r of d.resources) {
    const p = pathOf(r.name).replace(/\?v=[^&]+/, "").replace(/\/dist\/[^/]+\.woff2$/, "/dist/*.woff2");
    const k = p.replace(/(b-|res-|pr-|s)[0-9a-f]{8,}/g, "$1…");
    by[k] = by[k] || { n: 0, bytes: 0 }; by[k].n++; by[k].bytes += r.transfer || 0;
  }
  return by;
}

export async function board(env) {
  const id = env.targets.biggestBoard.id, title = env.titles[id];
  const s = await session(env, ["homeDoors", "homeLibrary"]);
  const out = [];
  try {
    await s.page.goto(env.base + "/", { waitUntil: "domcontentloaded" });
    await waitMarks(s, ["homeDoors", "homeLibrary"]);
    await netIdle(s);
    await s.page.waitForTimeout(300);
    for (const pass of ["first", "again"]) {
      await s.page.locator(".home-all-boards").click();
      const btn = s.page.locator("#home-boards").getByRole("button", { name: title, exact: true });
      await btn.waitFor();
      const a = await snapshot(s);
      const clickTs = await nextEventTs(s, "click");
      await arm(s, ["boardShown"]);
      await profiled(env, s, `board-${pass}`, async () => {
        await btn.click();
        await waitMarks(s, ["boardShown"]);
        await netIdle(s);
      });
      const b = await snapshot(s);
      const d = await delta(s, a, b);
      const c = await clickTs();
      out.push({ scenario: "board", variant: pass,
        t: { ms: r1(d.marks.boardShown - c), paint: r1(d.marks["boardShown:paint"] - c), netQuiet: r1(d.netQuiet - c),
          clickEvent: r1((d.events.find((e) => e.name === "click") || {}).d) },
        w: windowOf(d), net: summarizeNet(d), pageErrors: s.errors.splice(0), console: takeConsole(s) });
      if (pass === "first") {
        await s.page.locator(".bp-crumb", { hasText: "All boards" }).click();
        await s.page.locator(".veil.launcher").waitFor();
        await netIdle(s);
        await s.page.waitForTimeout(300);
      }
    }
    return out;
  } finally { await s.close(); }
}

/** When did the page under the eyes get ink and keep it? A PDF can draw page 1, then jump to its landing. */
function viewSummary(trace, since = 0) {
  const tr = trace.filter((x) => x[0] >= since);
  const lastIdx = (col) => { let k = -1; for (let i = 0; i < tr.length; i++) if (!tr[i][col]) k = i; return k; };
  const settled = (col) => { const k = lastIdx(col); return k + 1 < tr.length ? tr[k + 1][0] : null; };
  const first = tr.find((x) => x[2]);
  return { inkAt: settled(2), textAt: settled(3), firstInkAt: first ? first[0] : null, firstInkPage: first ? first[1] : null,
    page: tr.length ? tr[tr.length - 1][1] : null, pagesInView: [...new Set(tr.map((x) => x[1]).filter(Boolean))].length, transitions: tr.length };
}
const viewInked = (s, timeout = 180_000) => s.page.waitForFunction(() => { const v = window.__perf.view; const l = v[v.length - 1]; return l && l[2] && l[3]; }, null, { timeout, polling: 100 });
const viewTrace = (s) => s.page.evaluate(() => window.__perf.view.slice());
const quiet = (s) => s.page.evaluate(() => window.__perf.quiet());

export async function pdfOpen(env, t, label) {
  const s = await session(env, ["view", "pdfSlides", "firstCanvas", "firstTlayer"]);
  const out = [];
  try {
    await s.page.goto(env.base + "/api/health");
    const a = await snapshot(s);
    await profiled(env, s, `pdf-${label}`, async () => {
      await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
      await waitMarks(s, ["firstCanvas", "firstTlayer"], 180_000);
      await viewInked(s);
      await netIdle(s);
      await s.page.waitForTimeout(1500);
      await viewInked(s);
    });
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const v = viewSummary(await viewTrace(s));
    const ink = await s.page.evaluate((p) => !!document.querySelector(`#pg-${p} canvas`), v.page) && await inkCheck(s, `#pg-${v.page} canvas`);
    const raw = d.resources.find((x) => /\/raw$/.test(x.name));
    const chunk = d.resources.find((x) => /\/chunks\/pdf-/.test(x.name));
    const worker = d.resources.find((x) => /pdf\.worker/.test(x.name));
    const state = d.resources.find((x) => new RegExp(`/api/boards/${t.board}$`).test(x.name));
    out.push({ scenario: `pdf-${label}`, variant: "cold",
      t: { ms: r1(v.inkAt), inView: r1(v.inkAt), textInView: r1(v.textAt), firstCanvas: r1(d.marks.firstCanvas), firstTlayer: r1(d.marks.firstTlayer),
        slides: r1(d.marks.pdfSlides), mark: r1(d.marks.firstMark), stateEnd: r1(state && state.end),
        chunkEnd: r1(chunk && chunk.end), workerEnd: r1(worker && worker.end), rawStart: r1(raw && raw.s), rawEnd: r1(raw && raw.end), netQuiet: d.netQuiet },
      extra: { ink, view: v, rawBytes: raw && raw.transfer, rawDecoded: raw && raw.dec, wholeFileBeforeFirstPage: !!raw && raw.end <= d.marks.firstCanvas,
        canvases: await s.page.locator(".slide canvas").count(), slidesN: await s.page.locator(".slide").count(), mkboxes: await s.page.locator(".mkbox").count() },
      w: windowOf(d), net: summarizeNet(d), pageErrors: s.errors.splice(0), console: takeConsole(s) });

    await quiet(s);
    if (t.other) {
      await s.page.waitForTimeout(SETTLE_MS);
      await arm(s, ["newCanvas"]);
      await popTo(s, pdfUrl(env.base, t.other));
      await waitMarks(s, ["newCanvas"], 180_000).catch(() => {});
      await netIdle(s);
      await s.page.waitForTimeout(1500);
      const a2 = await snapshot(s);
      await s.page.evaluate(() => window.__perf.trackView(true));
      await arm(s, ["newCanvas", "newTlayer"]);
      await profiled(env, s, `pdf-${label}-reopen`, async () => {
        await popTo(s, pdfUrl(env.base, t));
        await waitMarks(s, ["newCanvas", "newTlayer"], 180_000);
        await viewInked(s);
        await netIdle(s);
        await s.page.waitForTimeout(1500);
        await viewInked(s);
      });
      const b2 = await snapshot(s);
      const d2 = await delta(s, a2, b2);
      const v2 = viewSummary(await viewTrace(s), a2.t);
      await quiet(s);
      const raws = d2.resources.filter((x) => /\/raw$/.test(x.name));
      const cdpRaws = d2.cdpNet.filter((x) => /\/raw$/.test(x.url));
      out.push({ scenario: `pdf-${label}`, variant: "reopen",
        t: { ms: r1(v2.inkAt - a2.t), inView: r1(v2.inkAt - a2.t), textInView: r1(v2.textAt - a2.t), firstNewCanvas: r1(d2.marks.newCanvas - a2.t), netQuiet: r1(d2.netQuiet - a2.t) },
        extra: { view: v2, rawRequests: raws.length, rawTransfer: raws.map((x) => x.transfer), rawCdp: cdpRaws.map((x) => ({ st: x.st, bytes: x.bytes, disk: x.disk, mem: x.mem, sw: x.sw })),
          workerFetches: d2.resources.filter((x) => /pdf\.worker/.test(x.name)).length,
          // the reader boots one pdf.js worker and shares it across documents
          pdfWorkers: await s.page.evaluate(() => window.__perf.workers.filter((u) => /pdf\.worker/.test(u)).length) },
        w: windowOf(d2), net: summarizeNet(d2), pageErrors: s.errors.splice(0), console: takeConsole(s) });
    }
    return out;
  } finally { await s.close(); }
}

async function marksByPage(base, t) {
  const st = await (await fetch(`${base}/api/boards/${t.board}`)).json();
  const by = {};
  for (const m of st.marks) if (m.resourceId === t.id && m.page && (m.rects || []).length) by[m.page] = (by[m.page] || 0) + 1;
  return by;
}

export async function pdfScroll(env, t, label) {
  const s = await session(env, ["view", "firstCanvas", "firstTlayer"]);
  try {
    await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
    await waitMarks(s, ["firstCanvas", "firstTlayer"], 180_000);
    await viewInked(s);
    await netIdle(s);
    await quiet(s);
    await s.page.waitForTimeout(SETTLE_MS);
    const pages = await s.page.locator(".slide").count();
    const steps = [0.05, 0.15, 0.3, 0.5, 0.7, 0.9, 0.98, 0.6, 0.1].map((f) => Math.max(1, Math.round(f * pages)));
    // a scroll renders the reader, not the board route
    const rooms = () => s.page.evaluate(() => window.__perf.roomRenders);
    // a page that draws must repaint its own marks, and only its own
    const held = await marksByPage(env.base, t);
    await s.page.evaluate((held2) => {
      const P = window.__perf, drew = P._drew = new Set();
      const m = P._marks = { all: 0, other: 0, markedDraws: 0, missing: 0 };
      let last, open = null;
      const close = () => { if (open && open.got.size < open.want) m.missing++; open = null; };
      const pageOf = (n) => { const sl = n.closest && n.closest(".slide"); return sl ? sl.dataset.page || sl.id : null; };
      const seen = (rs) => {
        for (const r of rs) for (const n of r.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.nodeName === "CANVAS" || n.classList.contains("tlayer")) {
            close();
            last = pageOf(n); drew.add(last);
            if (held2[last] && n.closest(".slide").querySelector("canvas")) { m.markedDraws++; open = { want: held2[last], got: new Set() }; }
          } else if (n.classList.contains("mkbox") && n.dataset.mark) {
            m.all++;
            if (pageOf(n) !== last) m.other++;
            else if (open) open.got.add(n.dataset.mark);
          }
        }
      };
      P._pmo = new MutationObserver(seen);
      P._pmoDone = () => { seen(P._pmo.takeRecords()); P._pmo.disconnect(); close(); };
      P._pmo.observe(document.querySelector(".page"), { subtree: true, childList: true });
    }, held);
    const paintsOf = () => s.page.evaluate(() => {
      const P = window.__perf; P._pmoDone();
      return { markPaints: P._marks.all, pagesDrew: P._drew.size, otherPagePaints: P._marks.other,
        markedPageDraws: P._marks.markedDraws, drawsMissingMarks: P._marks.missing };
    });
    const ra = await rooms();
    const a = await snapshot(s);
    const stepMs = await profiled(env, s, `scroll-${label}-steps`, async () => {
      const res = [];
      for (const n of steps) {
        res.push(await s.page.evaluate(async (n2) => {
          const t0 = performance.now();
          const sc = document.querySelector(".page");
          sc.scrollTop = document.querySelector(`#pg-${n2}`).offsetTop;
          sc.dispatchEvent(new Event("scroll"));
          await new Promise((ok, no) => {
            const give = setTimeout(() => no(new Error(`page ${n2} never drew`)), 60_000);
            const chk = () => (document.querySelector(`#pg-${n2} canvas`) && document.querySelector(`#pg-${n2} .tlayer`) ? (clearTimeout(give), ok()) : requestAnimationFrame(chk));
            chk();
          });
          return performance.now() - t0;
        }, n));
        // one pixel readback, on the last jump only: getImageData is not free and would bill the window
        if (res.length === steps.length && !(await inkCheck(s, `#pg-${n} canvas`))) res[res.length - 1] = null;
      }
      return res;
    });
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const rb = await rooms();
    const paints = await paintsOf();
    // pagesDrawn proves the wheel moved the reader; roomRenders 0 alone would hold for a wheel that did nothing
    await s.page.waitForTimeout(1500);
    const box = await s.page.locator(".page").boundingBox();
    await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await s.page.evaluate(() => {
      window.__perf.drawn = 0;
      window.__perf._dmo = new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) if (n.nodeName === "CANVAS") window.__perf.drawn++; });
      window.__perf._dmo.observe(document.querySelector(".page"), { subtree: true, childList: true });
    });
    const ra2 = await rooms();
    const a2 = await snapshot(s);
    await s.page.evaluate(() => window.__perf.frames.start());
    const top0 = await s.page.evaluate(() => document.querySelector(".page").scrollTop);
    await profiled(env, s, `scroll-${label}-wheel`, async () => {
      const end = Date.now() + 3000;
      while (Date.now() < end) { await s.page.mouse.wheel(0, 120); await s.page.waitForTimeout(16); }
    });
    const frames = await s.page.evaluate(() => window.__perf.frames.stop());
    const after = await s.page.evaluate(() => ({ top: document.querySelector(".page").scrollTop, drawn: window.__perf.drawn,
      blankInView: (() => { const sc = document.querySelector(".page"); const y = sc.scrollTop + sc.clientHeight / 2;
        const sl = [...document.querySelectorAll(".slide")].find((x) => x.offsetTop <= y && x.offsetTop + x.offsetHeight > y); return sl ? !sl.querySelector("canvas") : null; })() }));
    await s.page.waitForTimeout(500);
    const b2 = await snapshot(s);
    const d2 = await delta(s, a2, b2);
    const rb2 = await rooms();
    return [
      { scenario: `scroll-${label}`, variant: "steps", t: { ms: r1(stepMs.reduce((p, v) => p + (v || 0), 0) / stepMs.length), max: r1(Math.max(...stepMs.map((v) => v || 0))) },
        extra: { pages, steps, stepMs: stepMs.map(r1), roomRenders: rb - ra, ...paints }, w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) },
      { scenario: `scroll-${label}`, variant: "wheel", t: { ms: r1(frames.jankMs), over50: frames.over50, over33: frames.over33, maxFrame: r1(frames.maxMs), frames: frames.frames },
        extra: { frames, scrolledPx: Math.round(after.top - top0), pagesDrawn: after.drawn, blankAtEnd: after.blankInView, roomRenders: rb2 - ra2 }, w: windowOf(d2), pageErrors: s.errors.splice(0), console: takeConsole(s) },
    ];
  } finally { await s.close(); }
}

// the save answers slowly, so a highlight that waits for it shows the whole wait
const SLOW_SAVE_MS = 250;
export async function highlight(env, t, pageN) {
  const s = await session(onTailnet(env), ["view", "firstCanvas", "firstTlayer"]);
  let made = null;
  await s.page.route(/\/marks$/, async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, SLOW_SAVE_MS));
    await route.continue();
  });
  try {
    await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
    await waitMarks(s, ["firstCanvas", "firstTlayer"], 180_000);
    await viewInked(s);
    await netIdle(s);
    await quiet(s);
    await s.page.waitForTimeout(SETTLE_MS);
    await s.page.evaluate((n) => { const sc = document.querySelector(".page"); sc.scrollTop = document.querySelector(`#pg-${n}`).offsetTop + 40; sc.dispatchEvent(new Event("scroll")); }, pageN);
    await s.page.waitForFunction((n) => document.querySelector(`#pg-${n} canvas`) && document.querySelector(`#pg-${n} .tlayer [data-i]`), pageN);
    await s.page.waitForTimeout(800);
    const pts = await s.page.evaluate((n) => {
      const vh = innerHeight;
      const spans = [...document.querySelectorAll(`#pg-${n} .tlayer [data-i]`)].map((el) => ({ el, r: el.getBoundingClientRect(), len: el.textContent.length }))
        .filter((x) => x.len >= 12 && x.r.width > 60 && x.r.top > 120 && x.r.bottom < vh - 160);
      for (let i = 0; i + 1 < spans.length; i++) {
        const A = spans[i], B = spans[i + 1];
        if (B.r.top > A.r.bottom - 2 && B.r.top - A.r.bottom < 40) {
          const s0 = { x: A.r.left + 2, y: A.r.top + A.r.height / 2 }, e0 = { x: B.r.right - 2, y: B.r.top + B.r.height / 2 };
          const hit = document.elementFromPoint(s0.x, s0.y);
          return { s: s0, e: e0, hitOk: !!hit && !!hit.closest(".tlayer"), marksOnPage: document.querySelectorAll(`#pg-${n} .mkbox[data-mark]`).length };
        }
      }
      return null;
    }, pageN);
    if (!pts) throw new Error("no selectable line pair on page " + pageN);
    // neither the selection menu nor the painted mark may render the board route
    const rooms = () => s.page.evaluate(() => window.__perf.roomRenders);
    const rm = await rooms();
    await s.page.mouse.move(pts.s.x, pts.s.y);
    await s.page.mouse.down();
    await s.page.mouse.move(pts.e.x, pts.e.y, { steps: 8 });
    const a = await snapshot(s);
    const upTs = await nextEventTs(s, "mouseup");
    await arm(s, ["selMenu"]);
    const r = await profiled(env, s, "highlight", async () => {
      await s.page.mouse.up();
      await waitMarks(s, ["selMenu"], 30_000);
      await s.page.waitForTimeout(250);
      const menuRoomRenders = (await rooms()) - rm;
      await s.page.evaluate(() => window.__perf.watchMarks(true));
      const clickTs = await nextEventTs(s, "click");
      const resp = s.page.waitForResponse((x) => x.url().endsWith(`/api/boards/${t.board}/marks`) && x.request().method() === "POST");
      const ra = await rooms();
      // a highlight is a note left empty: the mark paints on the click, before the note is written
      await s.page.locator(".selmenu button", { hasText: "Note" }).click();
      const body = await (await resp).json();
      made = body.id;
      await s.page.waitForFunction((id) => window.__perf.mk.some((m) => m.id === id), made);
      await s.page.waitForTimeout(400);
      return { click: await clickTs(), roomRenders: (await rooms()) - ra, menuRoomRenders };
    });
    const up = await upTs();
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const mk = await s.page.evaluate(() => { const m = window.__perf.mk; window.__perf.watchMarks(false); return m; });
    const painted = (mk.find((m) => m.id === made) || {}).t;
    const post = d.resources.filter((x) => /\/marks$/.test(x.name)).pop();
    const commitsIn = async (lo, hi) => s.page.evaluate(([l, h]) => window.__perf.commits.filter((c) => c.t >= l && c.t <= h).length, [lo, hi]);
    return { scenario: "highlight", variant: `p${pageN}`,
      t: { ms: r1(painted - r.click), menu: r1(d.marks.selMenu - up), menuPaint: r1(d.marks["selMenu:paint"] - up),
        postStart: r1(post && post.s - r.click), postEnd: r1(post && post.end - r.click), painted: r1(painted - r.click), afterPost: r1(post && painted - post.end) },
      extra: { selectionStartedOnTextLayer: pts.hitOk, marksOnPage: pts.marksOnPage, mkboxInsertsDuringPaint: mk.length, roomRenders: r.roomRenders, menuRoomRenders: r.menuRoomRenders,
        commitsUpToMenu: await commitsIn(up, d.marks.selMenu + 50), commitsClickToPaint: await commitsIn(r.click, painted + 5),
        events: d.events },
      w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally {
    if (made) await fetch(`${env.base}/api/boards/${t.board}/marks/${made}`, { method: "DELETE" }).catch(() => {});
    await s.close();
  }
}

export async function prose(env, t) {
  const s = await session(env, ["readerShell", "proseText"]);
  try {
    await s.page.goto(env.base + "/api/health");
    const a = await snapshot(s);
    await profiled(env, s, "prose-open", async () => {
      await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
      await waitMarks(s, ["proseText"]);
      await netIdle(s);
    });
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const raw = d.resources.find((x) => /\/raw$/.test(x.name));
    const info = await s.page.evaluate(() => { const c = document.querySelector(".page-col.prose"); return { blocks: c ? c.childElementCount : 0, nodes: document.getElementsByTagName("*").length, height: document.querySelector(".page").scrollHeight }; });
    await s.page.waitForTimeout(1500);
    const box = await s.page.locator(".page").boundingBox();
    await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const a2 = await snapshot(s);
    await s.page.evaluate(() => window.__perf.frames.start());
    await profiled(env, s, "prose-wheel", async () => {
      const end = Date.now() + 3000;
      while (Date.now() < end) { await s.page.mouse.wheel(0, 120); await s.page.waitForTimeout(16); }
    });
    const frames = await s.page.evaluate(() => window.__perf.frames.stop());
    await s.page.waitForTimeout(500);
    const b2 = await snapshot(s);
    const d2 = await delta(s, a2, b2);
    return [
      { scenario: "prose", variant: "cold", t: { ms: r1(d.marks.proseText), text: r1(d.marks.proseText), textPaint: r1(d.marks["proseText:paint"]),
        rawEnd: r1(raw && raw.end), netQuiet: d.netQuiet }, extra: { ...info, rawBytes: raw && raw.transfer }, w: windowOf(d), net: summarizeNet(d), pageErrors: s.errors.splice(0), console: takeConsole(s) },
      { scenario: "prose", variant: "wheel", t: { ms: r1(frames.jankMs), over50: frames.over50, over33: frames.over33, maxFrame: r1(frames.maxMs), frames: frames.frames },
        extra: { frames }, w: windowOf(d2), pageErrors: s.errors.splice(0), console: takeConsole(s) },
    ];
  } finally { await s.close(); }
}

// drags across a run of the PDF's text layer in view, so the selection menu offers its verbs
async function pickWords(s) {
  const run = await s.page.evaluate(() => {
    const R = document.querySelector(".page").getBoundingClientRect();
    const el = [...document.querySelectorAll(".slide .tlayer [data-i]")].find((e) => {
      const r = e.getBoundingClientRect();
      return e.textContent.length >= 16 && r.width > 80 && r.top > R.top + 80 && r.bottom < R.bottom - 200;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x0: r.left + 2, x1: r.left + r.width * 0.8, y: r.top + r.height / 2 };
  });
  if (!run) throw new Error("no run of words in view to pick");
  await s.page.mouse.move(run.x0, run.y); await s.page.mouse.down();
  await s.page.mouse.move(run.x1, run.y, { steps: 8 }); await s.page.mouse.up();
  await s.page.locator(".selmenu").waitFor({ timeout: 5000 });
}

export async function chat(env, t, text = "how does the variance of this estimator behave") {
  const s = await session(env, ["view", "firstCanvas"]);
  try {
    await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
    await waitMarks(s, ["firstCanvas"], 180_000);
    await viewInked(s);
    await netIdle(s);
    await quiet(s);
    await s.page.waitForTimeout(SETTLE_MS);
    // a source is asked under its words: Ask on picked words opens the fold's line
    await pickWords(s);
    const input = s.page.locator(".fold .fi.asked .fi-q");
    const a0 = await snapshot(s);
    const clickTs = await nextEventTs(s, "click");
    await arm(s, ["askLine"]);
    await s.page.locator(".selmenu").getByRole("button", { name: "Ask", exact: true }).click();
    await waitMarks(s, ["askLine"], 30_000).catch(() => {});
    await s.page.waitForTimeout(400);
    const b0 = await snapshot(s);
    const d0 = await delta(s, a0, b0);
    const c0 = await clickTs();
    const turns = await s.page.locator(".fold .fi.asked .fi-turn").count();
    await s.page.evaluate(() => {
      const P = window.__perf; P.keyLat = [];
      document.addEventListener("keydown", (e) => {
        const t0 = e.timeStamp;
        requestAnimationFrame(() => setTimeout(() => P.keyLat.push(performance.now() - t0), 0));
      }, true);
    });
    const a = await snapshot(s);
    await profiled(env, s, "chat-typing", async () => {
      await s.page.keyboard.type(text, { delay: 90 });
      await s.page.waitForTimeout(400);
    });
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const lat = await s.page.evaluate(() => window.__perf.keyLat);
    // `typed`: the keys did reach the line, so a ceiling on commits per key means something
    const typed = (await input.inputValue()) === text ? 1 : 0;
    await s.page.keyboard.press("Escape");
    const sorted = [...lat].sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)], p90 = sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)];
    return [
      { scenario: "chat", variant: "focus-opens-thread", t: { ms: r1(d0.marks.askLine - c0), paint: r1(d0.marks["askLine:paint"] - c0) },
        extra: { turns }, w: windowOf(d0), pageErrors: s.errors.splice(0), console: takeConsole(s) },
      { scenario: "chat", variant: "keystroke", t: { ms: r1(med), p90: r1(p90), max: r1(sorted[sorted.length - 1]) },
        extra: { keys: text.length, typed, commitsPerKey: r1(d.commits / text.length), turns, keyLat: lat.map(r1) }, w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) },
    ];
  } finally { await s.close(); }
}

export async function idle(env, where, t) {
  const s = await session(env, where === "home" ? ["homeDoors", "homeLibrary"] : ["view", "firstCanvas", "firstTlayer"]);
  try {
    await s.page.goto(where === "home" ? env.base + "/" : pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
    await waitMarks(s, where === "home" ? ["homeDoors", "homeLibrary"] : ["firstCanvas", "firstTlayer"], 180_000);
    if (where !== "home") await viewInked(s);
    await netIdle(s);
    await quiet(s);
    await s.page.waitForTimeout(SETTLE_MS);
    if (where === "pdf-chat") {
      await pickWords(s);
      await arm(s, ["askLine"]);
      await s.page.locator(".selmenu").getByRole("button", { name: "Ask", exact: true }).click();
      await waitMarks(s, ["askLine"], 30_000);
      await s.page.waitForTimeout(3000);
    }
    const a = await snapshot(s);
    await s.page.waitForTimeout(30_000);
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const commits = await s.page.evaluate(([lo]) => window.__perf.commits.filter((c) => c.t >= lo).map((c) => Math.round(c.t - lo)), [a.t]);
    const reqs = d.resources.map((x) => ({ at: Math.round(x.s - a.t), path: pathOf(x.name) }));
    const byPath = {};
    for (const r of reqs) (byPath[r.path.replace(/(b-|res-|pr-)[0-9a-f]{8,}/g, "$1…")] ||= []).push(r.at);
    return { scenario: "idle", variant: where, t: { ms: commits.filter((x) => x < 10_000).length, commits10s: commits.filter((x) => x < 10_000).length, commits30s: commits.length, requests30s: reqs.length },
      extra: { commitTimes: commits, requests: byPath, tasks: d.reactTaskMs }, w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally { await s.close(); }
}

export async function swHome(env) {
  const s = await newSession({ browser: env.browser, engine: env.engine, sw: true, throttle: env.throttle, arm: ["homeDoors", "homeLibrary"] });
  const out = [];
  try {
    // visit 1 installs the worker, visit 2 is its first controlled load and fills its caches, visit 3 is served from them
    for (const pass of ["first-visit", "sw-controlled", "sw-warm"]) {
      if (pass === "first-visit") await s.page.goto(env.base + "/api/health");
      const a = await snapshot(s);
      if (pass === "first-visit") await s.page.goto(env.base + "/", { waitUntil: "domcontentloaded" });
      else await s.page.reload({ waitUntil: "domcontentloaded" });
      await waitMarks(s, ["homeDoors", "homeLibrary"]);
      await netIdle(s);
      const b = await snapshot(s);
      const d = await delta(s, a, b);
      const controlled = await s.page.evaluate(() => !!navigator.serviceWorker && !!navigator.serviceWorker.controller);
      const document = d.cdpNet.find((x) => new URL(x.url).pathname.replace(/\/$/, "") === new URL(env.base + "/").pathname.replace(/\/$/, ""));
      out.push({ scenario: "home", variant: `sw:${pass}`, t: { ms: r1(d.marks.homeLibrary), doors: r1(d.marks.homeDoors), library: r1(d.marks.homeLibrary), netQuiet: d.netQuiet },
        extra: { controlled, viaSW: d.cdpNet.filter((x) => x.sw).length,
          // the page itself came from the worker's saved copy (it carries the save stamp), and the boot reads from its snapshot
          pageFromWorker: document && document.sw && document.saved ? 1 : 0,
          snapshotReads: d.cdpNet.filter((x) => x.snapshot).length },
        w: windowOf(d), net: summarizeNet(d), pageErrors: s.errors.splice(0), console: takeConsole(s) });
      await s.page.waitForTimeout(1500);
    }
    return out;
  } finally { await s.close(); }
}
export async function swPdf(env, t) {
  const s = await newSession({ browser: env.browser, engine: env.engine, sw: true, throttle: env.throttle, arm: ["view", "firstCanvas", "firstTlayer"] });
  const out = [];
  try {
    await s.page.goto(env.base + "/", { waitUntil: "domcontentloaded" });
    await s.page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30_000 }).catch(() => {});
    for (const pass of ["first", "reload"]) {
      const a = await snapshot(s);
      if (pass === "first") await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
      else await s.page.reload({ waitUntil: "domcontentloaded" });
      await waitMarks(s, ["firstCanvas", "firstTlayer"], 180_000);
      await viewInked(s);
      await netIdle(s);
      await s.page.waitForTimeout(1500);
      const b = await snapshot(s);
      const d = await delta(s, a, b);
      const v = viewSummary(await viewTrace(s));
      const raw = d.cdpNet.filter((x) => /\/raw$/.test(x.url));
      out.push({ scenario: "pdf-marked", variant: `sw:${pass}`, t: { ms: r1(v.inkAt), inView: r1(v.inkAt), firstCanvas: r1(d.marks.firstCanvas), tlayer: r1(d.marks.firstTlayer), netQuiet: d.netQuiet },
        extra: { raw: raw.map((x) => ({ st: x.st, bytes: x.bytes, sw: x.sw, disk: x.disk })), controlled: await s.page.evaluate(() => !!navigator.serviceWorker.controller) },
        w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) });
      await s.page.waitForTimeout(1500);
    }
    return out;
  } finally { await s.close(); }
}

// flipping cards with `n` while a source is open: per key, keydown to next frame
export async function flip(env, t, label, keys = 12) {
  const isPdf = label !== "prose";
  const s = await session(env, isPdf ? ["view", "firstCanvas", "firstTlayer"] : ["proseText"]);
  try {
    await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
    if (isPdf) { await waitMarks(s, ["firstCanvas", "firstTlayer"], 180_000); await viewInked(s); }
    else await waitMarks(s, ["proseText"], 60_000);
    await netIdle(s);
    await quiet(s);
    await s.page.waitForTimeout(SETTLE_MS);
    await s.page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    await s.page.evaluate(() => {
      const P = window.__perf; P.keyLat = [];
      document.addEventListener("keydown", (e) => {
        const t0 = e.timeStamp;
        requestAnimationFrame(() => setTimeout(() => P.keyLat.push(performance.now() - t0), 0));
      }, true);
    });
    const rooms = () => s.page.evaluate(() => window.__perf.roomRenders);
    // the card in hand, to tell a key that flipped from one that did nothing: its sheet lies where it is asked, maybe off the drawn pages
    const cardNow = () => s.page.evaluate(() => document.querySelector(".page[data-hand]")?.getAttribute("data-hand") || (document.querySelector(".deck.solo") || {}).textContent || "");
    let was = await cardNow(), flipped = 0;
    // React never renders the PDF column's children, so its canvases survive re-renders
    if (isPdf) await s.page.evaluate(() => { window.__perf.flipCanvases = [...document.querySelectorAll(".slide canvas")]; });
    const a = await snapshot(s), ra = await rooms();
    await profiled(env, s, `flip-${label}`, async () => {
      for (let i = 0; i < keys; i++) {
        await s.page.keyboard.press("n"); await s.page.waitForTimeout(250);
        const now = await cardNow();
        if (now !== was) flipped++;
        was = now;
      }
      await s.page.waitForTimeout(400);
    });
    const b = await snapshot(s), rb = await rooms();
    const d = await delta(s, a, b);
    const lat = await s.page.evaluate(() => window.__perf.keyLat);
    const sorted = [...lat].sort((x, y) => x - y);
    const held = isPdf ? await s.page.evaluate(() => { const c = window.__perf.flipCanvases; return { canvasesHeld: c.length, canvasesLost: c.filter((x) => !x.isConnected).length }; }) : {};
    const { deckFetches, seenFetches } = fetched(d);
    // a flip is the drill's: it may not render the board route or refetch the deck or seen set
    return { scenario: `flip-${label}`, variant: "key-n", t: { ms: r1(sorted[Math.floor(sorted.length / 2)]), p90: r1(sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]), max: r1(sorted[sorted.length - 1]) },
      extra: { keys, flipped, keyLat: lat.map(r1), commitsPerKey: r1(d.commits / keys), roomRenders: rb - ra, deckFetches, seenFetches, ...held }, w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally { await s.close(); }
}

// cards only on, off and on again: the third `o` must be answered by the kept decks
export async function cardsOnly(env, t) {
  const s = await session(env, ["proseText"]);
  try {
    await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
    await waitMarks(s, ["proseText"], 60_000);
    await netIdle(s);
    await quiet(s);
    await s.page.waitForTimeout(SETTLE_MS);
    await s.page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    // read every frame, so the first time it holds is the frame that drew it
    const POOLED = /^cards only · (\d+) cards/;
    const line = (want, what) => s.page.waitForFunction(([w, re, n]) => {
      const seg = [...document.querySelectorAll(".seg")].map((e) => new RegExp(re).exec(e.textContent || "")).find(Boolean);
      if (w ? !seg : seg) return false;
      return n ? Number(seg[1]) : performance.now();
    }, [want, POOLED.source, what === "cards"], { polling: "raf", timeout: 30_000 }).then((h) => h.jsonValue());
    const press = async (want) => {
      const ts = await nextEventTs(s, "keydown");
      await s.page.keyboard.press("o");
      const at = await line(want);
      return at - (await ts());
    };
    const a0 = await snapshot(s);
    await press(true);
    await netIdle(s);
    await s.page.waitForTimeout(400);
    const a = await snapshot(s);
    const firstFetches = fetched(await delta(s, a0, a)).deckFetches;
    let ms = 0;
    await profiled(env, s, "cards-only", async () => {
      await press(false);
      await s.page.waitForTimeout(250);
      ms = await press(true);
      await s.page.waitForTimeout(400);
    });
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const cards = await line(true, "cards");
    // firstFetches proves the first `o` pooled decks, so againFetches 0 means the kept decks answered
    return { scenario: "cards-only", variant: "toggle", t: { ms: r1(ms) },
      extra: { firstFetches, againFetches: fetched(d).deckFetches, cards }, w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally { await s.close(); }
}

// the three doors a sitting starts from (continue, deck, review), each at the tailnet's round trip
const LOOK_MS = 1500;
const homeReady = async (s, env) => {
  await s.page.goto(env.base + "/", { waitUntil: "domcontentloaded" });
  await waitMarks(s, ["homeDoors", "homeLibrary"]);
  await netIdle(s);
  await s.page.waitForTimeout(LOOK_MS);
};
// what a journey should never wait on after the click: a web font, the pdf.js worker, board state, deck
const fetched = (d) => {
  const n = (re) => d.resources.filter((x) => re.test(pathOf(x.name))).length;
  return { fonts: n(/\.(woff2?|ttf)(\?|$)/), workerFetches: n(/pdf\.worker/), stateFetches: n(/^\/api\/boards\/[^/?]+$/), deckFetches: n(/^\/api\/decks\/[^/?]+$/),
    seenFetches: n(/^\/api\/boards\/[^/?]+\/seen$/) };
};
const timeline = (d, c) => d.resources.map((x) => [pathOf(x.name).replace(/\?v=[^&]+/, "").replace(/(b-|res-|pr-|s)[0-9a-f]{8,}/g, "$1…"), r1(x.s - c), r1(x.end - c)]);
async function toCardAndPage(env, s, name, locator) {
  await s.page.evaluate(() => window.__perf.trackView(true));
  const a = await snapshot(s);
  const clickTs = await nextEventTs(s, "click");
  await arm(s, ["newRoomCard"]);
  await profiled(env, s, name, async () => {
    await locator.click();
    await waitMarks(s, ["newRoomCard"], 60_000);
    await viewInked(s, 60_000);
    await netIdle(s);
    await s.page.waitForTimeout(1000);
    await viewInked(s, 60_000);
  });
  const b = await snapshot(s);
  const d = await delta(s, a, b);
  const c = await clickTs();
  const v = viewSummary(await viewTrace(s), c);
  await quiet(s);
  const card = d.marks.newRoomCard - c, page = v.inkAt - c;
  return { d, t: { ms: r1(Math.max(card, page)), card: r1(card), cardPaint: r1(d.marks["newRoomCard:paint"] - c), page: r1(page),
    text: r1(v.textAt - c), netQuiet: r1(d.netQuiet - c) }, extra: { view: v, timeline: timeline(d, c), ...fetched(d) } };
}

export async function continueBoard(env, t) {
  env = onTailnet(env);
  // this board is the one last worked (the log's board prop is what "last worked" reads)…
  await fetch(`${env.base}/api/log`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event: "perf_touch", props: { board: t.board } }) });
  const s = await session(env, ["homeDoors", "homeLibrary"]);
  await s.context.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v); } catch (e) { /* no storage */ } },
    [`strata.at.${t.board}`, JSON.stringify({ pairId: t.pair, scroll: 12_000 })]);
  try {
    await homeReady(s, env);
    const btn = s.page.locator(".home-doors").getByRole("button", { name: /Continue board/ });
    const r = await toCardAndPage(env, s, "continue", btn);
    // the keeps and cram chunks must not start before the page inks: they compete for the board's connections
    const warmsBeforePage = r.extra.timeline.filter(([p, at]) => /\/chunks\/(Keeps|Cram)Surface-/.test(p) && at < r.t.page).length;
    return { scenario: "continue", variant: "home", t: r.t, extra: { ...r.extra, warmsBeforePage },
      w: windowOf(r.d), net: summarizeNet(r.d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally { await s.close(); }
}

export async function deckOpen(env, board) {
  env = onTailnet(env);
  const s = await session(env, ["boardReady"]);
  try {
    await s.page.goto(`${env.base}/?board=${board}`, { waitUntil: "domcontentloaded" });
    await waitMarks(s, ["boardReady"]);
    await netIdle(s);
    await s.page.waitForTimeout(LOOK_MS);
    const btn = s.page.locator(".bp-front .bp-btn.primary");
    const r = await toCardAndPage(env, s, "deck-open", btn);
    return { scenario: "deck-open", variant: "board-page", t: r.t, extra: r.extra,
      w: windowOf(r.d), net: summarizeNet(r.d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally { await s.close(); }
}

export async function reviewOpen(env) {
  env = onTailnet(env);
  const s = await session(env, ["homeDoors", "homeLibrary"]);
  try {
    await homeReady(s, env);
    const btn = s.page.locator(".home-review button.home-primary:not([disabled])");
    await btn.waitFor();
    const a = await snapshot(s);
    const clickTs = await nextEventTs(s, "click");
    await arm(s, ["reviewCard"]);
    await profiled(env, s, "review-open", async () => {
      await btn.click();
      await waitMarks(s, ["reviewCard"], 60_000);
      await netIdle(s);
    });
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const c = await clickTs();
    const due = await s.page.evaluate(() => !!document.querySelector(".rcard .q-meta"));
    const reviewFetches = d.resources.filter((x) => /\/api\/review(\?|$)/.test(pathOf(x.name))).length;
    return { scenario: "review", variant: "home", t: { ms: r1(d.marks.reviewCard - c), paint: r1(d.marks["reviewCard:paint"] - c), netQuiet: r1(d.netQuiet - c) },
      extra: { due, reviewFetches, ...fetched(d) }, w: windowOf(d), net: summarizeNet(d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally { await s.close(); }
}

// a reload into a reader: the deck's read must start beside the board's answer, not after the first render
export async function reloadReader(env, t) {
  env = onTailnet(env);
  const s = await session(env, ["newRoomCard"]);
  try {
    await s.page.goto(env.base + "/api/health");
    const a = await snapshot(s);
    await profiled(env, s, "reload-reader", async () => {
      await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
      await waitMarks(s, ["newRoomCard"], 60_000);
      await netIdle(s);
    });
    const b = await snapshot(s);
    const d = await delta(s, a, b);
    const state = d.resources.find((x) => new RegExp(`^/api/boards/${t.board}$`).test(pathOf(x.name)));
    const deck = d.resources.find((x) => /^\/api\/decks\/[^/?]+$/.test(pathOf(x.name)));
    if (!state || !deck) throw new Error(`reload-reader: no ${state ? "deck" : "board state"} read`);
    const tasks = await s.page.evaluate(() => window.__perf.tasks.map((x) => [x.s, x.d]));
    const deckInRender = tasks.some(([ts, td]) => ts <= deck.s && deck.s <= ts + td) ? 1 : 0;
    return { scenario: "reload-reader", variant: "pair",
      t: { ms: r1(d.marks.newRoomCard), card: r1(d.marks.newRoomCard), cardPaint: r1(d.marks["newRoomCard:paint"]), stateEnd: r1(state.end), deckStart: r1(deck.s), deckEnd: r1(deck.end) },
      extra: { deckInRender, deckAfterBoard: r1(deck.s - state.end), cardAfterBoard: r1(d.marks.newRoomCard - state.end), timeline: timeline(d, 0), ...fetched(d) },
      w: windowOf(d), net: summarizeNet(d), pageErrors: s.errors.splice(0), console: takeConsole(s) };
  } finally { await s.close(); }
}

// the board page, a file drag and a plan write over a reader with its long thread: none may render the route
const latStats = (lat) => {
  const sorted = [...lat].sort((x, y) => x - y);
  return { ms: r1(sorted[Math.floor(sorted.length / 2)]), p90: r1(sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]), max: r1(sorted[sorted.length - 1]) };
};
export async function boardPage(env, t, text = "the variance shrinks") {
  const s = await session(env, ["view", "firstCanvas"]);
  try {
    await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
    await waitMarks(s, ["firstCanvas"], 180_000);
    await viewInked(s);
    await netIdle(s);
    await quiet(s);
    await s.page.waitForTimeout(SETTLE_MS);
    await s.page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    await s.page.evaluate(() => {
      const P = window.__perf; P.keyLat = [];
      document.addEventListener("keydown", (e) => {
        const t0 = e.timeStamp;
        requestAnimationFrame(() => setTimeout(() => P.keyLat.push(performance.now() - t0), 0));
      }, true);
    });
    const boardUp = s.page.locator(".desk-at");
    const rooms = () => s.page.evaluate(() => window.__perf.roomRenders);
    const lats = () => s.page.evaluate(() => window.__perf.keyLat.splice(0));

    const a = await snapshot(s), ra = await rooms();
    await profiled(env, s, "board-page-h", async () => {
      await s.page.keyboard.press("h");
      await boardUp.waitFor();
      await netIdle(s);
      await s.page.waitForTimeout(250);
      await s.page.keyboard.press("h");
      await boardUp.waitFor({ state: "detached" });
      await s.page.waitForTimeout(250);
    });
    const b = await snapshot(s), rb = await rooms();
    const d = await delta(s, a, b);
    const hLat = await lats();
    // `countsLanded` says the counts landed inside the window, so roomRenders covers them
    const countsLanded = d.resources.filter((x) => /\/touched$/.test(pathOf(x.name))).length;
    const keyH = { scenario: "board-page", variant: "key-h", t: latStats(hLat),
      extra: { keys: 2, commitsPerKey: r1(d.commits / 2), roomRenders: rb - ra, countsLanded, keyLat: hLat.map(r1) },
      w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) };

    // a drag over the room is the drop capability's, so the route must not render
    const a3 = await snapshot(s), ra3 = await rooms();
    const shown = await s.page.evaluate(async () => {
      const panes = document.querySelector(".panes");
      const dt = new DataTransfer();
      dt.items.add(new File(["%PDF-1.4"], "perf.pdf", { type: "application/pdf" }));
      const fire = (type) => panes.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      fire("dragenter");
      for (let i = 0; i < 6; i++) { fire("dragover"); await frame(); }
      const on = !!document.querySelector(".dropzone");
      fire("dragleave"); await frame(); await frame();
      return on && !document.querySelector(".dropzone") ? 1 : 0;
    });
    await s.page.waitForTimeout(250);
    const b3 = await snapshot(s), rb3 = await rooms();
    const d3 = await delta(s, a3, b3);
    const dragFiles = { scenario: "board-page", variant: "drag-files", t: { ms: 0 },
      extra: { shown, roomRenders: rb3 - ra3 }, w: windowOf(d3), pageErrors: s.errors.splice(0), console: takeConsole(s) };

    await s.page.keyboard.press("h");
    await boardUp.waitFor();
    await netIdle(s);
    await s.page.waitForTimeout(400);
    // near its top: the ask line floats over the foot of the page, and a long log runs under it
    await boardUp.locator(".note-read, textarea.note-edit").first().click({ position: { x: 60, y: 16 } });
    await s.page.waitForFunction(() => document.activeElement && document.activeElement.matches("textarea.note-edit"));
    await s.page.waitForTimeout(400);
    await lats();
    const a2 = await snapshot(s), ra2 = await rooms();
    await profiled(env, s, "board-page-log", async () => {
      await s.page.keyboard.type(text, { delay: 90 });
      await s.page.waitForTimeout(400);
    });
    const b2 = await snapshot(s), rb2 = await rooms();
    const d2 = await delta(s, a2, b2);
    const typeLat = await lats();
    // `typed`: the log's box holds what was typed, so roomRenders 0 is over keys that reached it
    const typed = await s.page.evaluate((x) => { const el = document.activeElement; return el && el.matches("textarea.note-edit") && el.value.includes(x) ? 1 : 0; }, text);
    await s.page.keyboard.press("Escape");
    const logTyping = { scenario: "board-page", variant: "log-typing", t: latStats(typeLat),
      extra: { keys: text.length, typed, commitsPerKey: r1(d2.commits / text.length), roomRenders: rb2 - ra2, keyLat: typeLat.map(r1) },
      w: windowOf(d2), pageErrors: s.errors.splice(0), console: takeConsole(s) };

    // the plan is the store's plan:<board>, read by the board page and not the route
    await s.page.waitForTimeout(600);
    await boardUp.locator(".bp-btn.quiet", { hasText: "Details" }).first().dispatchEvent("click");
    const pin = boardUp.locator(".bp-acts .bp-btn.quiet", { hasText: "Pin" });
    await pin.waitFor();
    await s.page.waitForTimeout(400);
    const a4 = await snapshot(s), ra4 = await rooms();
    const was = await pin.getAttribute("aria-pressed");
    const planned = await profiled(env, s, "board-page-plan", async () => {
      const said = [];
      for (const want of was === "true" ? ["false", "true"] : ["true", "false"]) {
        const [answer] = await Promise.all([
          s.page.waitForResponse((x) => /\/plan\/places\//.test(x.url()) && x.request().method() === "PATCH", { timeout: 30_000 }),
          // the click itself: the open thread floats over the foot of the page, where the cover's buttons can sit
          pin.dispatchEvent("click"),
        ]);
        await s.page.waitForFunction((w) => { const b = document.querySelector(".desk-at .bp-acts .bp-btn[aria-pressed]"); return !!b && b.getAttribute("aria-pressed") === w; }, want);
        said.push(answer.ok() ? 1 : 0);
        await s.page.waitForTimeout(400);
      }
      return said;
    });
    const b4 = await snapshot(s), rb4 = await rooms();
    const d4 = await delta(s, a4, b4);
    const planWrite = { scenario: "board-page", variant: "plan-write", t: { ms: 0 },
      extra: { saved: planned.reduce((p, v) => p + v, 0), planWrites: d4.resources.filter((x) => /\/plan\//.test(pathOf(x.name))).length, roomRenders: rb4 - ra4 },
      w: windowOf(d4), pageErrors: s.errors.splice(0), console: takeConsole(s) };
    return [keyH, dragFiles, logTyping, planWrite];
  } finally { await s.close(); }
}

// the reader's own tools (toast, find, split, zoom) on the most-marked PDF: none may render the route
const frame = (s) => s.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
const PAGETEXT_HOLD_MS = 300;
export async function readerTools(env, t) {
  const s = await session(env, ["view", "firstCanvas", "firstTlayer"]);
  const pagetext = { out: 0 };
  await s.page.route(/\/pagetext$/, async (route) => {
    pagetext.out++;
    try { await new Promise((r) => setTimeout(r, PAGETEXT_HOLD_MS)); } finally { pagetext.out--; }
    await route.continue();
  });
  try {
    await s.page.goto(pdfUrl(env.base, t), { waitUntil: "domcontentloaded" });
    await waitMarks(s, ["firstCanvas", "firstTlayer"], 180_000);
    await viewInked(s);
    await netIdle(s);
    await quiet(s);
    await s.page.waitForTimeout(SETTLE_MS);
    const rooms = () => s.page.evaluate(() => window.__perf.roomRenders);
    const toBody = () => s.page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
    const out = [];
    const measure = async (variant, fn) => {
      await toBody();
      const a = await snapshot(s), ra = await rooms();
      await s.page.evaluate(() => window.__perf.watchMarks(true));
      const extra = await profiled(env, s, `reader-${variant}`, fn);
      const markRepaints = await s.page.evaluate(() => { const n = window.__perf.mk.length; window.__perf.watchMarks(false); return n; });
      const b = await snapshot(s), rb = await rooms();
      const d = await delta(s, a, b);
      const fetches = (re) => d.resources.filter((x) => re.test(pathOf(x.name))).length;
      out.push({ scenario: "reader", variant, t: { ms: 0 }, extra: { ...extra, roomRenders: rb - ra, pagetextFetches: fetches(/\/pagetext$/), markRepaints },
        w: windowOf(d), pageErrors: s.errors.splice(0), console: takeConsole(s) });
    };

    await measure("toast", async () => {
      await s.page.keyboard.press("Control+z");
      const shown = await s.page.locator(".toast").waitFor({ timeout: 5000 }).then(() => 1, () => 0);
      await s.page.locator(".toast").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      await s.page.waitForTimeout(250);
      return { shown };
    });

    const word = await s.page.evaluate(() => {
      const words = [...document.querySelectorAll(".slide .tlayer [data-i]")].flatMap((el) => el.textContent.split(/[^A-Za-z]+/)).filter((w) => w.length >= 6);
      return (words[0] || "the").toLowerCase();
    });
    await measure("find", async () => {
      let found = 0, typedWhileOut = 0;
      for (let pass = 0; pass < 2; pass++) {
        await s.page.keyboard.press("f");
        const input = s.page.locator(".findbar input");
        await input.waitFor();
        await s.page.waitForTimeout(100);
        for (const ch of word) {
          await s.page.keyboard.type(ch);
          if (pagetext.out) typedWhileOut++;
          await s.page.waitForTimeout(40);
        }
        await s.page.waitForFunction(() => /\d+ \/ \d+|no text/.test((document.querySelector(".findbar .fb-n") || {}).textContent || ""), null, { timeout: 30_000 });
        if (/\d+ \/ \d+/.test(await s.page.locator(".findbar .fb-n").textContent())) found++;
        for (let i = 0; i < 2; i++) { await s.page.keyboard.press("Enter"); await s.page.waitForTimeout(300); }
        await s.page.keyboard.press("Escape");
        await s.page.locator(".findbar").waitFor({ state: "detached" });
        await s.page.waitForTimeout(250);
      }
      return { found, typedWhileOut };
    });

    // the column beside the page opens only for writing a card, so the drag is measured while one is edited
    await toBody();
    await s.page.keyboard.press("e");
    await s.page.locator(".split").waitFor({ timeout: 10_000 });
    await quiet(s);
    await measure("split", async () => {
      const box = await s.page.locator(".split").boundingBox();
      const w0 = await s.page.evaluate(() => document.querySelector(".deck").getBoundingClientRect().width);
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await s.page.mouse.move(x, y);
      await s.page.mouse.down();
      const c0 = await s.page.evaluate(() => window.__perf.commits.length);
      const moves = 8;
      for (let i = 1; i <= moves; i++) { await s.page.mouse.move(x - 12 * i, y); await frame(s); }
      const c1 = await s.page.evaluate(() => window.__perf.commits.length);
      await s.page.mouse.up();
      await s.page.waitForTimeout(400);
      const w1 = await s.page.evaluate(() => document.querySelector(".deck").getBoundingClientRect().width);
      return { moves, moved: w1 < w0 ? 1 : 0, commitsPerMove: r1((c1 - c0) / moves) };
    });
    await s.page.locator(".ced-x", { hasText: "cancel" }).click();
    await s.page.locator(".split").waitFor({ state: "detached", timeout: 10_000 });
    await quiet(s);

    await measure("zoom", async () => {
      const zoomOf = () => s.page.evaluate(() => document.querySelector(".page").style.zoom || "1");
      const z0 = await zoomOf();
      const wheel = (dy) => s.page.evaluate((d) => {
        document.querySelector(".page").dispatchEvent(new WheelEvent("wheel", { deltaY: d, ctrlKey: true, bubbles: true, cancelable: true }));
      }, dy);
      await wheel(-24);
      await s.page.waitForTimeout(600);
      const z1 = await zoomOf();
      await wheel(24);
      await s.page.waitForTimeout(600);
      const z2 = await zoomOf();
      await s.page.locator(".toast").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      await s.page.waitForTimeout(250);
      return { steps: 2, stepped: z1 !== z0 && z2 === z0 ? 1 : 0 };
    });
    return out;
  } finally { await s.close(); }
}
