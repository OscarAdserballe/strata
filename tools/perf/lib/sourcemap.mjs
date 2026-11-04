// A dependency-free source-map v3 reader; profile frames resolve to the function header, not the hot line.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64V = new Int8Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) B64V[B64.charCodeAt(i)] = i;

/** Decode `mappings` into per-generated-line Int32Arrays of [genCol, src, line, col, name] (name -1 if none). */
export function decodeMappings(mappings) {
  const lines = [];
  let line = [];
  let genCol = 0, src = 0, oLine = 0, oCol = 0, name = 0;
  let i = 0, value = 0, shift = 0, fields = [];
  const pushSeg = () => {
    if (!fields.length) return;
    genCol += fields[0];
    if (fields.length >= 4) {
      src += fields[1]; oLine += fields[2]; oCol += fields[3];
      let nm = -1;
      if (fields.length >= 5) { name += fields[4]; nm = name; }
      line.push(genCol, src, oLine, oCol, nm);
    }
    fields = [];
  };
  const n = mappings.length;
  for (; i < n; i++) {
    const c = mappings.charCodeAt(i);
    if (c === 59 /* ; */) { pushSeg(); lines.push(Int32Array.from(line)); line = []; genCol = 0; continue; }
    if (c === 44 /* , */) { pushSeg(); continue; }
    const d = B64V[c];
    if (d < 0) throw new Error(`bad VLQ char ${mappings[i]}`);
    value += (d & 31) << shift;
    if (d & 32) { shift += 5; continue; }
    const neg = value & 1; value >>>= 1;
    fields.push(neg ? -value : value);
    value = 0; shift = 0;
  }
  pushSeg(); lines.push(Int32Array.from(line));
  return lines;
}

class OneMap {
  constructor(mapPath, jsPath, repoRoot) {
    const raw = JSON.parse(readFileSync(mapPath, "utf8"));
    this.sources = raw.sources.map((s) => {
      // pdf.js ships its own map, which esbuild chains: name those by the library
      const wp = s.match(/webpack:\/+pdf\.js\/(.*)$/);
      if (wp) return `node_modules/pdfjs-dist/(src)/${wp[1]}`;
      // esbuild writes sources relative to the map file
      const abs = join(mapPath, "..", s);
      return repoRoot ? relative(repoRoot, abs).replace(/\\/g, "/") : s;
    });
    this.names = raw.names || [];
    this.content = raw.sourcesContent || [];
    this.lines = decodeMappings(raw.mappings);
    this.js = readFileSync(jsPath, "utf8");
    this._lineStarts = null;
    this._srcLines = new Map();
  }
  segAt(line0, col0) {
    const L = this.lines[line0]; if (!L || !L.length) return -1;
    let lo = 0, hi = L.length / 5 - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid * 5] <= col0) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }
  srcLine(src, line0) {
    let arr = this._srcLines.get(src);
    if (!arr) { arr = (this.content[src] || "").split("\n"); this._srcLines.set(src, arr); }
    return arr[line0] ?? "";
  }
  resolve(line0, col0) {
    const k = this.segAt(line0, col0); if (k < 0) return null;
    const L = this.lines[line0];
    const src = L[k * 5 + 1], oLine = L[k * 5 + 2], oCol = L[k * 5 + 3];
    // the function's original name: the nearest named segment within a few segments
    let name = null;
    for (let j = k; j < Math.min(L.length / 5, k + 4); j++) {
      if (L[j * 5 + 4] >= 0 && L[j * 5 + 1] === src && Math.abs(L[j * 5 + 2] - oLine) <= 1) { name = this.names[L[j * 5 + 4]]; break; }
    }
    if (!name) for (let j = k - 1; j >= Math.max(0, k - 3); j--) {
      if (L[j * 5 + 4] >= 0 && L[j * 5 + 1] === src && L[j * 5 + 2] === oLine) { name = this.names[L[j * 5 + 4]]; break; }
    }
    const snippet = this.srcLine(src, oLine).trim().slice(0, 90);
    return { source: this.sources[src], line: oLine + 1, col: oCol + 1, name, snippet };
  }
  charToLineCol(pos) {
    if (!this._lineStarts) {
      const s = [0]; for (let i = 0; i < this.js.length; i++) if (this.js.charCodeAt(i) === 10) s.push(i + 1);
      this._lineStarts = s;
    }
    const s = this._lineStarts; let lo = 0, hi = s.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m] <= pos) lo = m; else hi = m - 1; }
    return { line0: lo, col0: pos - s[lo] };
  }
}

export function loadMaps(distDir, repoRoot) {
  const byName = new Map();
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".js") && existsSync(p + ".map")) byName.set(relative(distDir, p).replace(/\\/g, "/"), { js: p, map: p + ".map", m: null });
    }
  };
  walk(distDir);
  const get = (url) => {
    if (!url) return null;
    let path; try { path = new URL(url).pathname; } catch { return null; }
    const i = path.indexOf("/dist/"); if (i < 0) return null;
    const e = byName.get(path.slice(i + 6)); if (!e) return null;
    if (!e.m) e.m = new OneMap(e.map, e.js, repoRoot);
    return e.m;
  };
  return {
    has: (url) => !!get(url),
    resolve(url, line0, col0) { const m = get(url); return m ? m.resolve(line0, col0) : null; },
    charToLineCol(url, pos) { const m = get(url); return m ? m.charToLineCol(pos) : null; },
    resolveChar(url, pos) { const m = get(url); if (!m) return null; const { line0, col0 } = m.charToLineCol(pos); return m.resolve(line0, col0); },
  };
}

export function bucketOf(source) {
  if (!source) return null;
  const m = source.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (m) return m[1];
  const w = source.match(/^(web\/[^?]+|vendor\/[^?]+|shared\/[^?]+)/);
  return w ? w[1] : source;
}

export function analyzeProfile(profile, maps, { top = 15 } = {}) {
  const nodes = new Map();
  for (const n of profile.nodes) nodes.set(n.id, n);
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const keyCache = new Map();
  const keyOf = (id) => {
    if (keyCache.has(id)) return keyCache.get(id);
    const cf = nodes.get(id).callFrame;
    let k;
    const special = cf.functionName && cf.functionName.startsWith("(") ? cf.functionName : null;
    if (special) k = { key: special, bucket: special };
    else {
      const r = maps.resolve(cf.url, cf.lineNumber, cf.columnNumber);
      if (r) {
        const b = bucketOf(r.source);
        k = { key: `${r.source}:${r.line} ${r.name || cf.functionName || "(anon)"}`, bucket: b, snippet: r.snippet };
      } else if (cf.url) {
        let short = cf.url; try { const u = new URL(cf.url); short = u.pathname.split("/").pop() || u.host; } catch { /* keep */ }
        k = { key: `${short}:${cf.lineNumber + 1} ${cf.functionName || "(anon)"}`, bucket: `(unmapped ${short})` };
      } else {
        k = { key: `(native) ${cf.functionName || "(anon)"}`, bucket: "(native/browser)" };
      }
    }
    keyCache.set(id, k);
    return k;
  };
  const self = new Map(), total = new Map(), buckets = new Map(), snippets = new Map(), owners = new Map();
  const samples = profile.samples || [], deltas = profile.timeDeltas || [];
  let totalUs = 0, idleUs = 0;
  for (let i = 0; i < samples.length; i++) {
    const dt = i + 1 < deltas.length ? deltas[i + 1] : 0;
    if (dt <= 0) continue;
    const leaf = samples[i];
    const lk = keyOf(leaf);
    if (lk.key === "(idle)") { idleUs += dt; continue; }
    totalUs += dt;
    self.set(lk.key, (self.get(lk.key) || 0) + dt);
    if (lk.snippet) snippets.set(lk.key, lk.snippet);
    const b = lk.bucket, seen = new Set();
    let id = leaf, owner = null;
    while (id !== undefined) {
      const k = keyOf(id);
      if (!seen.has(k.key)) { seen.add(k.key); total.set(k.key, (total.get(k.key) || 0) + dt); if (k.snippet) snippets.set(k.key, k.snippet); }
      if (!owner && k.bucket && /^(web|shared|vendor|experiments)\//.test(k.bucket)) owner = k.key;
      id = parent.get(id);
    }
    buckets.set(b, (buckets.get(b) || 0) + dt);
    const ok = owner || `(no app frame) ${b}`;
    owners.set(ok, (owners.get(ok) || 0) + dt);
  }
  const rank = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([key, us]) => ({ key, ms: +(us / 1000).toFixed(1), pct: +(100 * us / Math.max(1, totalUs)).toFixed(1), snippet: snippets.get(key) }));
  // total is dominated by (root)/(program) wrappers; drop the pseudo-frames from its ranking
  const totalRanked = new Map([...total].filter(([k]) => !k.startsWith("(")));
  const totalApp = new Map([...total].filter(([k]) => /^(web|shared|vendor|experiments)\//.test(k)));
  return {
    busyMs: +(totalUs / 1000).toFixed(1), idleMs: +(idleUs / 1000).toFixed(1),
    self: rank(self), total: rank(totalRanked), totalApp: rank(totalApp), owners: rank(owners),
    buckets: [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([bucket, us]) => ({ bucket, ms: +(us / 1000).toFixed(1), pct: +(100 * us / Math.max(1, totalUs)).toFixed(1) })),
  };
}
