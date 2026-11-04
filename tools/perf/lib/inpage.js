// In-page instrumentation injected before any app script; results on window.__perf.
(() => {
  if (window.__perf) return;
  const now = () => performance.now();
  const P = window.__perf = {
    commits: [], tasks: [], longtasks: [], loafs: [], events: [], marks: {}, errors: [], paints: {},
    mk: [], components: null,
  };
  try { performance.setResourceTimingBufferSize(20000); } catch (e) { /* old engine */ }
  addEventListener("error", (e) => P.errors.push({ t: now(), msg: String(e.message || e.error || e).slice(0, 300) }));
  addEventListener("unhandledrejection", (e) => P.errors.push({ t: now(), msg: "unhandled: " + String(e.reason && (e.reason.message || e.reason)).slice(0, 300) }));

  // React DevTools hook stub: production builds call onCommitFiberRoot once per commit.
  let curTask = null, lastEvt = null, lastCommitT = 0;
  const FN_TAGS = new Set([0, 1, 11, 14, 15]);
  const nameOf = (t) => (t && (t.displayName || t.name)) || (t && t.type && (t.type.displayName || t.type.name)) || (t && t.render && (t.render.displayName || t.render.name)) || "(anon)";
  function collect(root, since) {
    const stats = P.components || (P.components = {});
    const stack = [root];
    while (stack.length) {
      const f = stack.pop();
      if (FN_TAGS.has(f.tag) && f.actualStartTime >= since) {
        const n = nameOf(f.type);
        const s = stats[n] || (stats[n] = { renders: 0, selfMs: 0 });
        s.renders++; s.selfMs += f.selfBaseDuration || 0;
      }
      // a subtree whose child pointer is unchanged bailed out: nothing below rendered
      if (f.child && !(f.alternate && f.alternate.child === f.child)) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
  }
  // roomRenders: a fresh hook list on the route's body component means it rendered rather than bailed out.
  P.roomRenders = 0;
  let roomHooks = null;
  const hooksOf = (f) => { let n = 0; for (let h = f.memoizedState; h && n < 100000; h = h.next) n++; return n; };
  function roomOf(hostRoot) {
    let best = null, most = -1;
    const consider = (f) => {
      if (f.tag === 14) f = f.child;                 // memo(…) with a compare: the component is its child
      if (!f || (f.tag !== 0 && f.tag !== 15)) return;
      const n = hooksOf(f);
      if (n > most) { most = n; best = f; }
    };
    for (let f = hostRoot.child; f; f = f.sibling) {
      consider(f);
      if (f.tag === 0) for (let g = f.child; g; g = g.sibling) consider(g);
    }
    return best;
  }
  const renderers = new Map();
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers, isDisabled: false,
    inject(r) { const id = renderers.size + 1; renderers.set(id, r); return id; },
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
    setStrictMode() {},
    onCommitFiberRoot(id, root) {
      const t = now();
      const c = { t };
      if (curTask) c.task = curTask.s;
      else if (lastEvt && t - lastEvt.t < 1000) c.evt = lastEvt;
      const cur = root && root.current;
      if (cur && typeof cur.actualDuration === "number" && cur.actualDuration > 0) {
        c.dur = cur.actualDuration;
        if (P.trackComponents) { try { collect(cur, lastCommitT); } catch (e) { /* walking is best effort */ } }
      }
      try {
        const room = cur && roomOf(cur);
        if (room && room.memoizedState !== roomHooks) { if (roomHooks) P.roomRenders++; roomHooks = room.memoizedState; }
      } catch (e) { /* walking is best effort */ }
      lastCommitT = t;
      P.commits.push(c);
    },
  };
  // React's scheduler posts work through a MessageChannel, so wrapping onmessage brackets each task
  try {
    const d = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
    if (d && d.set) Object.defineProperty(MessagePort.prototype, "onmessage", {
      configurable: true, enumerable: d.enumerable,
      get() { return d.get.call(this); },
      set(fn) {
        if (typeof fn !== "function") return d.set.call(this, fn);
        const wrapped = function (ev) {
          const task = { s: now() }; const outer = curTask; curTask = task;
          try { return fn.call(this, ev); }
          finally { task.d = now() - task.s; curTask = outer; if (task.d > 0.05) P.tasks.push(task); }
        };
        d.set.call(this, wrapped);
      },
    });
  } catch (e) { /* engine without the accessor */ }
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "keydown", "input", "wheel", "touchend"]) {
    addEventListener(type, () => { lastEvt = { type, t: now() }; }, { capture: true, passive: true });
  }

  // record each dedicated worker's script, so reopen scenarios can count pdf.worker starts
  P.workers = [];
  try {
    const W = window.Worker;
    if (W) window.Worker = new Proxy(W, { construct(target, args, nt) { P.workers.push(String(args[0])); return Reflect.construct(target, args, nt); } });
  } catch (e) { /* engine without workers */ }

  const observe = (type, fn, extra) => {
    try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...(extra || {}) }); }
    catch (e) { /* unsupported entry type */ }
  };
  observe("longtask", (e) => P.longtasks.push({ s: e.startTime, d: e.duration }));
  observe("long-animation-frame", (e) => P.loafs.push({
    s: e.startTime, d: e.duration, block: e.blockingDuration, render: e.renderStart, style: e.styleAndLayoutStart,
    scripts: (e.scripts || []).map((x) => ({ inv: x.invoker, type: x.invokerType, url: x.sourceURL, fn: x.sourceFunctionName,
      pos: x.sourceCharPosition, s: x.startTime, d: x.duration, forced: x.forcedStyleAndLayoutDuration })),
  }));
  observe("event", (e) => P.events.push({ name: e.name, s: e.startTime, d: e.duration,
    delay: e.processingStart - e.startTime, proc: e.processingEnd - e.processingStart,
    tgt: e.target ? (e.target.className || e.target.tagName || "").toString().slice(0, 40) : null }), { durationThreshold: 16 });
  observe("paint", (e) => { P.paints[e.name] = e.startTime; });
  observe("largest-contentful-paint", (e) => { P.paints.lcp = e.startTime; });

  const q = (s) => document.querySelector(s);
  const PROBES = {
    homeDoors: () => !!q(".home-primary") && !!q(".home-all-boards"),
    homeLibrary: () => !!q(".home-library .rg-title"),
    boardReady: () => { const h = q(".bp-hname"); return !!h && !!h.textContent.trim() && !!q(".bp-rail .bp-it") && !!q(".bp-big"); },
    readerShell: () => !!q(".page .pdf-col .slide, .page .page-col.prose > *"),
    pdfSlides: () => !!q(".pdf-col .slide"),
    firstCanvas: () => !!q(".slide canvas"),
    firstTlayer: () => !!q(".slide .tlayer"),
    firstMark: () => !!q(".slide .mkbox"),
    proseText: () => { const c = q(".page-col.prose"); return !!c && c.childElementCount > 3; },
    selMenu: () => !!q(".selmenu"),
    chatInput: () => !!q(".line input"),
    chatThread: () => !!q(".turns .turn"),
    askLine: () => !!q(".fold .fi.asked .fi-q"),
    launcher: () => !!q(".veil.launcher"),
    boardShown: () => { const h = q(".bp-hname"); return !q(".veil.launcher") && !!h && !!h.textContent.trim() && !!q(".bp-rail .bp-it") && !!q(".bp-big"); },
    newCanvas: () => [...document.querySelectorAll(".slide canvas")].some((c) => !c.__perfOld),
    newTlayer: () => [...document.querySelectorAll(".slide .tlayer")].some((c) => !c.__perfOld),
    // a card of the deck: in its sheet over its words, or in the column when cards are alone
    newRoomCard: () => [...document.querySelectorAll(".fi-face .q, .deck .q-meta")].some((c) => !c.__perfOld),
    reviewCard: () => !!q(".rcard .q-meta") || !!q(".rdone"),
  };
  P.probeNames = Object.keys(PROBES);
  const pending = new Set();
  let mo = null, rafOn = false;
  const check = () => {
    for (const name of [...pending]) {
      let ok = false; try { ok = PROBES[name](); } catch (e) { ok = false; }
      if (ok) {
        const t = now(); P.marks[name] = t; pending.delete(name);
        // ≈ next paint: a task queued from the next rAF runs after that frame's style/layout/paint
        requestAnimationFrame(() => setTimeout(() => { P.marks[name + ":paint"] = now(); }, 0));
      }
    }
    if (!pending.size && mo) { mo.disconnect(); mo = null; }
  };
  const tick = () => { if (!pending.size) { rafOn = false; return; } check(); requestAnimationFrame(tick); };
  P.arm = (names, reset = true) => {
    if (names.includes("newCanvas")) document.querySelectorAll(".slide canvas").forEach((c) => { c.__perfOld = true; });
    if (names.includes("newTlayer")) document.querySelectorAll(".slide .tlayer").forEach((c) => { c.__perfOld = true; });
    if (names.includes("newRoomCard")) document.querySelectorAll(".fi-face .q, .deck .q-meta").forEach((c) => { c.__perfOld = true; });
    for (const n of names) { if (!PROBES[n]) throw new Error("no probe " + n); if (reset) { delete P.marks[n]; delete P.marks[n + ":paint"]; } pending.add(n); }
    if (!mo) { mo = new MutationObserver(check); mo.observe(document, { subtree: true, childList: true }); }
    if (!rafOn) { rafOn = true; requestAnimationFrame(tick); }
    check();
  };
  P.watchMarks = (on) => {
    if (P._mkmo) { P._mkmo.disconnect(); P._mkmo = null; }
    if (!on) return;
    P.mk = [];
    P._mkmo = new MutationObserver((recs) => {
      const t = now();
      for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains("mkbox") && n.dataset.mark) P.mk.push({ t, id: n.dataset.mark });
    });
    P._mkmo.observe(document, { subtree: true, childList: true });
  };
  // the slide at the scroller's centre, recorded on change, to find when the page in view stayed inked
  P.view = [];
  // cheap: the rAF callback does nothing unless the DOM changed or the reader scrolled
  let viewOn = false, dirty = true, col = null, slides = null, vmo = null;
  const markDirty = () => { dirty = true; };
  const centreSlide = () => {
    const sc = q(".page"); if (!sc) return null;
    const c = sc.querySelector(".pdf-col"); if (!c) return null;
    if (c !== col) { col = c; slides = c.getElementsByClassName("slide"); }
    const n = slides.length; if (!n || !sc.clientHeight) return null;
    const y = sc.scrollTop + sc.clientHeight / 2;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (slides[m].offsetTop <= y) lo = m; else hi = m - 1; }
    return slides[lo];
  };
  let lastView = "";
  const viewTick = () => {
    if (!viewOn) return;
    if (dirty) {
      dirty = false;
      const sl = centreSlide();
      const rec = sl ? [sl.dataset.page, !!sl.querySelector("canvas"), !!sl.querySelector(".tlayer")] : [null, false, false];
      const key = rec.join("|");
      if (key !== lastView) { lastView = key; P.view.push([now(), +rec[0] || null, rec[1], rec[2]]); }
    }
    requestAnimationFrame(viewTick);
  };
  P.trackView = (on = true) => {
    if (on && !viewOn) {
      viewOn = true; dirty = true; lastView = ""; P.view = [];
      vmo = new MutationObserver(markDirty); vmo.observe(document, { subtree: true, childList: true });
      document.addEventListener("scroll", markDirty, { capture: true, passive: true });
      requestAnimationFrame(viewTick);
    }
    if (!on && viewOn) {
      viewOn = false; if (vmo) { vmo.disconnect(); vmo = null; }
      document.removeEventListener("scroll", markDirty, { capture: true });
    }
  };
  P.quiet = () => { P.trackView(false); pending.clear(); if (mo) { mo.disconnect(); mo = null; } };
  if (Array.isArray(window.__PERF_ARM) && window.__PERF_ARM.includes("view")) P.trackView(true);
  if (Array.isArray(window.__PERF_ARM) && window.__PERF_ARM.length) P.arm(window.__PERF_ARM.filter((n) => n !== "view"));

  let frameTs = null;
  P.frames = {
    start() { frameTs = []; const loop = (t) => { if (!frameTs) return; frameTs.push(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop); },
    stop() {
      const ts = frameTs || []; frameTs = null;
      const iv = []; for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
      const over = (x) => iv.filter((v) => v > x);
      return { frames: ts.length, spanMs: ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0,
        over33: over(33.4).length, over50: over(50).length, over100: over(100).length,
        maxMs: iv.length ? Math.max(...iv) : 0, jankMs: over(50).reduce((a, v) => a + v - 16.7, 0) };
    },
  };
})();
