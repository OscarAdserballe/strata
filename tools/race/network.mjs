// A seeded Playwright /api shim: latency, reordering, lost acks, drops and holds, the same for every seed.

/** FNV-1a, 32-bit. Small and stable is the whole requirement. */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rngFor = (seed, label) => mulberry32(hash32(`${seed}|${label}`));
export function pick(rng, n, k) {
  const all = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  return new Set(all.slice(0, Math.min(k, n)));
}

/* a path with its ids blanked out: ids are random per run, the shape of the path is not */
export const pathKey = (path) => path.split("/").map((s) => (/\d/.test(s) ? ":id" : s)).join("/");

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => performance.now();

const SKIP = (url, request, shim = {}) => (!shim.health && url.pathname.endsWith("/api/health"))
  || (!shim.raw && url.pathname.endsWith("/raw")) || (!shim.perf && url.pathname.endsWith("/api/perf"))
  || (!shim.streams && (request.headers().accept || "").includes("text/event-stream"));

const LATENCY = [40, 800];
const REORDER_WINDOW = 900;
// a backstop for holds nobody releases; a capped hold makes the trial unrunnable, never a verdict
const HOLD_CAP = 60_000;
/* a backstop's timer must not keep the process alive once the run is over */
const backstop = (ms) => new Promise((r) => { setTimeout(r, Math.max(0, ms)).unref?.(); });

/** Put the shim on a page's /api requests; modes: latency, reorder, lostAck, drop, imports, shim. */
export async function installNetwork(page, { base, seed, modes = {}, say = () => {} }) {
  const origin = new URL(base).origin;
  const net = new Net(seed, modes, say);
  await page.route((url) => url.origin === origin && url.pathname.includes("/api/"), (route, request) => net.handle(route, request));
  return net;
}

// a trial's wire is every tab's: a capped hold on any shim makes the trial unrunnable
export const cappedOn = (nets) => nets.filter(Boolean).flatMap((n) => n.entries.filter((e) => e.capped));
export function wireOf(nets) {
  const by = {};
  for (const n of nets.filter(Boolean)) for (const [k, v] of Object.entries(n.summary())) by[k] = (by[k] || 0) + v;
  return by;
}

export class Net {
  constructor(seed, modes, say) {
    this.seed = seed;
    this.modes = modes;
    this.say = say;
    this.entries = [];
    this.counts = new Map();
    this.seq = 0;
    this.holds = [];
    this.watchers = [];
    this.closed = false;
    this.rules = {};
    for (const kind of ["lostAck", "drop"]) {
      const r = modes[kind];
      if (r) this.rules[kind] = { ...r, seen: 0, decided: new Map() };
    }
  }

  // counted among the rule's own matches, so "the 2nd and 5th grade" means exactly those
  victim(kind, e) {
    const r = this.rules[kind];
    if (!r || !e.write || !r.match(e)) return false;
    const k = r.key ? r.key(e) : null;
    if (k !== null && r.decided.has(k)) return false;          // a retry of a decided request passes
    r.seen++;
    let hit = r.pick ? r.pick.has(r.seen) : false;
    if (!hit && r.rate) hit = rngFor(this.seed, `${e.key}#${e.n}#${kind}`)() < r.rate;
    if (k !== null) r.decided.set(k, hit);
    return hit;
  }

  // fates are decided as requests leave, in send order; if drop and lostAck victims meet, the drop wins
  fate(e) {
    const dropped = this.victim("drop", e);
    const lost = this.victim("lostAck", e);
    return { dropped, lost: lost && !dropped };
  }

  async handle(route, request) {
    const url = new URL(request.url());
    if (this.closed || SKIP(url, request, this.modes.shim)) { await route.fallback().catch(() => {}); return; }
    const method = request.method();
    const write = method !== "GET" && method !== "HEAD";
    let body = null;
    if (write) { try { body = request.postDataJSON(); } catch { body = null; } }
    const event = body && typeof body.event === "string" ? body.event : null;
    const key = `${method} ${pathKey(url.pathname)}${event ? ` ${event}` : ""}`;
    const n = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, n);
    let settle, inside;
    const e = {
      id: ++this.seq, method, path: url.pathname + url.search, key, n, event, body, write,
      headers: request.headers(),
      startedAt: now(), answeredAt: null, deliveredAt: null, outcome: "open", status: null, capped: false,
      response: null,
      done: new Promise((r) => { settle = r; }),
      inside: new Promise((r) => { inside = r; }),
    };
    // must not overtake earlier writes, and for a write, earlier reads too
    const before = this.entries.filter((x) => write || x.write).map((x) => x.inside);
    this.entries.push(e);
    for (const w of [...this.watchers]) if (w.match(e)) w.fire(e);
    const rng = rngFor(this.seed, `${key}#${n}`);
    const delay = typeof this.modes.latency === "number" ? this.modes.latency
      : this.modes.latency ? LATENCY[0] + Math.floor(rng() * (LATENCY[1] - LATENCY[0] + 1)) : 0;
    const finish = (outcome) => { e.outcome = outcome; e.deliveredAt = now(); inside(); settle(); };
    const { dropped, lost } = this.fate(e);
    const frozen = !this.modes.imports && method === "GET" && url.pathname.endsWith("/api/imports");
    try {
      if (dropped) {
        inside();
        await sleep(delay);
        await route.abort("failed").catch(() => {});
        finish("dropped");
        return;
      }
      await Promise.all(before);
      let response;
      // route.fetch can hit a connection the server just closed as idle; retry once on a fresh one
      const forward = () => route.fetch({ timeout: 60_000, maxRedirects: 0 });
      const again = (err) => {
        if (!/ECONNRESET|socket hang up/.test(String(err.message))) return Promise.reject(err);
        this.say(`shim: ${method} ${url.pathname} was reset on a kept-alive connection — sent again`);
        return forward();
      };
      try { response = await forward().catch(again); }
      catch (err) {
        // the harness could not reach the server for the page — said, because it is not a mode
        if (!this.closed) this.say(`shim: ${method} ${url.pathname} could not be forwarded — ${String(err.message).split("\n")[0]}`);
        await route.abort("failed").catch(() => {});
        finish("error");
        return;
      }
      e.answeredAt = now();
      e.status = response.status();
      e.response = response;
      inside();
      let replay = null;
      if (frozen && e.status === 200) {
        if (this.importsAnswer === undefined) this.importsAnswer = await response.body();
        else replay = this.importsAnswer;
      }
      await sleep(e.answeredAt + delay - now());
      if (this.reorders(e)) await this.reorderHold(e);
      for (const h of this.holds) if (h.catches(e)) await h.wait(e);
      if (lost) {
        const status = this.rules.lostAck.status;
        await (status
          ? route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: `the race harness answered ${status} for a write the server made` }) })
          : route.abort("failed")).catch(() => {});
        finish("lost-ack");
        return;
      }
      await route.fulfill(replay ? { response, body: replay } : { response }).catch(() => {});
      finish("ok");
    } catch (err) {
      finish("error");
      this.say(`shim: ${method} ${url.pathname} — ${err.message.split("\n")[0]}`);
    }
  }

  reorders(e) {
    const r = this.modes.reorder;
    if (!r) return false;
    return e.write ? !!r.writes : r.gets !== false;
  }

  // a held write waits only for later writes to its key, and never for one parked in a hold (deadlock)
  async reorderHold(e) {
    const window = this.modes.reorder.window ?? REORDER_WINDOW;
    const until = e.startedAt + window, cap = e.startedAt + HOLD_CAP;
    for (;;) {
      if (this.closed) return;
      if (now() > cap) { this.capped(e, "reorder"); return; }
      const later = this.entries.filter((x) => x.id > e.id && x.write && x.deliveredAt === null && !x.parked && (!e.write || x.key === e.key));
      // looked at again every 50 ms as well: a later write may park rather than finish
      if (later.length) { await Promise.race([...later.map((x) => x.done), sleep(50)]); continue; }
      if (now() >= until) return;
      await sleep(Math.min(25, until - now()));
    }
  }

  /** Hold every matching response from now on until released: { caught, arrived(n), release() }. */
  hold(match) {
    const from = this.seq;
    let open = true, release;
    const gate = new Promise((r) => { release = r; });
    const caught = [];
    const waiters = [];
    const h = {
      release: () => { open = false; release(); this.holds = this.holds.filter((x) => x !== h); },
      catches: (e) => open && e.id > from && match(e),
      wait: async (e) => {
        caught.push(e);
        e.parked = true;
        for (const w of waiters.splice(0)) if (caught.length >= w.n) w.resolve(); else waiters.push(w);
        const released = await Promise.race([gate.then(() => true), backstop(HOLD_CAP).then(() => false)]);
        e.parked = false;
        if (!released && !this.closed) this.capped(e, "net.hold");
      },
    };
    this.holds.push(h);
    return {
      caught,
      arrived: (n = 1, timeout = 60_000) => caught.length >= n ? Promise.resolve() : new Promise((resolve, reject) => {
        waiters.push({ n, resolve });
        setTimeout(() => reject(new Error(`net.hold: ${caught.length} of ${n} responses arrived in ${timeout} ms`)), timeout).unref?.();
      }),
      release: h.release,
    };
  }

  when(match, timeout = 60_000) {
    return new Promise((resolve, reject) => {
      const w = { match, fire: (e) => { clearTimeout(timer); this.watchers = this.watchers.filter((x) => x !== w); resolve(e); } };
      const timer = setTimeout(() => {
        this.watchers = this.watchers.filter((x) => x !== w);
        reject(new Error(`net.when: no matching request within ${timeout} ms`));
      }, timeout);
      this.watchers.push(w);
    });
  }

  async idle(quiet = 400, timeout = 30_000) {
    const end = now() + timeout;
    let calmSince = now();
    while (now() < end) {
      const open = this.entries.some((x) => x.deliveredAt === null);
      if (open) calmSince = now();
      else if (now() - calmSince >= quiet) return;
      await sleep(25);
    }
    const open = this.entries.filter((x) => x.deliveredAt === null).map((x) => `${x.method} ${x.path}`);
    throw new Error(`the wire never went quiet: ${open.slice(0, 4).join(", ")}`);
  }

  /* a hold ran out before anyone let it go: said, and marked, so the runner discards the trial */
  capped(e, by) {
    e.capped = true;
    this.say(`shim: ${by} held ${e.method} ${e.path} for ${HOLD_CAP} ms and let it go — the interleaving was not pinned`);
  }

  summary() {
    const by = {};
    for (const e of this.entries) by[e.outcome] = (by[e.outcome] || 0) + 1;
    return by;
  }

  /* the page is going: let everything held go, so no handler outlives its page */
  close() { this.closed = true; for (const h of [...this.holds]) h.release(); }
}
