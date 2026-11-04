import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const REPO = join(import.meta.dirname, "..");
const ROOTS = ["web", "server", "shared"];
const SOURCE = /\.(ts|tsx|js|jsx|mjs|mts)$/;
const SKIP_DIRS = new Set(["node_modules", "dist"]);

interface Edge { from: string; spec: string; to: string }

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(join(REPO, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel, out); }
    else if (SOURCE.test(e.name) && !/\.test\./.test(e.name)) out.push(rel);
  }
  return out;
}

const PATTERNS = [
  // import x from "…", import type { X } from "…", export { x } from "…", export * from "…"
  /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"'\n]+)["']/gm,
  /^[ \t]*import\s*["']([^"'\n]+)["']/gm,
  /\bimport\(\s*["'`]([^"'`\n$]+)["'`]\s*[,)]/g,
  // new URL("…", import.meta.url): a worker or asset loaded by path
  /\bnew\s+URL\(\s*["'`]([^"'`\n$]+)["'`]\s*,\s*import\.meta\.url/g,
];

function resolve(from: string, spec: string): string {
  if (!spec.startsWith(".")) return spec;
  return posix.normalize(posix.join(posix.dirname(from), spec.replace(/[?#].*$/, "")));
}

function edgesOf(file: string): Edge[] {
  const src = readFileSync(join(REPO, file), "utf8");
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const re of PATTERNS) {
    for (const m of src.matchAll(re)) {
      const spec = m[1];
      if (seen.has(spec)) continue;
      seen.add(spec);
      edges.push({ from: file, spec, to: resolve(file, spec) });
    }
  }
  return edges;
}

const FILES = ROOTS.flatMap((r) => walk(r));
const EDGES = FILES.flatMap(edgesOf);

const under = (dir: string) => (path: string) => path === dir || path.startsWith(`${dir}/`);
const isRelative = (e: Edge) => e.spec.startsWith(".");

interface Rule { id: string; rule: string; applies: (from: string) => boolean; forbids: (e: Edge) => boolean }

const featureOf = (path: string) => /^server\/features\/([^/]+)\//.exec(path)?.[1] ?? null;
const surfaceOf = (path: string) => /^web\/surfaces\/([^/]+)\//.exec(path)?.[1] ?? null;
/** a bare specifier's package: "react-dom/client" → "react-dom", "@scope/pkg/x" → "@scope/pkg" */
const packageOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
const SHELL_FOR_CAPABILITIES = new Set(["web/shell/here.ts", "web/shell/layers.ts", "web/shell/routes.ts"]);

const RULES: Rule[] = [
  {
    id: "L1",
    rule: "server/** never imports web/**",
    applies: under("server"),
    forbids: (e) => isRelative(e) && under("web")(e.to),
  },
  {
    id: "L2",
    rule: "shared/** imports only shared/** (no web/, server/, node: builtins or packages: it runs in both runtimes)",
    applies: under("shared"),
    forbids: (e) => !isRelative(e) || !under("shared")(e.to),
  },
  {
    id: "L3",
    rule: "web/engines/** never imports web/{data,capabilities,surfaces,shell}/**",
    applies: under("web/engines"),
    forbids: (e) => isRelative(e) && ["web/data", "web/capabilities", "web/surfaces", "web/shell"].some((d) => under(d)(e.to)),
  },
  {
    id: "L4",
    rule: "web/capabilities/** never imports web/surfaces/**; from web/shell/** only here.ts, layers.ts and routes.ts",
    applies: under("web/capabilities"),
    forbids: (e) => isRelative(e) && (under("web/surfaces")(e.to) || (under("web/shell")(e.to) && !SHELL_FOR_CAPABILITIES.has(e.to))),
  },
  {
    id: "L7",
    rule: "a web surface never imports another surface (what two surfaces need is a capability)",
    applies: (from) => surfaceOf(from) !== null,
    forbids: (e) => isRelative(e) && surfaceOf(e.to) !== null && surfaceOf(e.to) !== surfaceOf(e.from),
  },
  {
    id: "L8",
    rule: "web/data/** imports only web/data/**, web/platform/**, shared/** and react; web/platform/** only web/platform/** and shared/**",
    applies: (from) => under("web/data")(from) || under("web/platform")(from),
    forbids: (e) => {
      const own = under("web/platform")(e.from) ? ["web/platform", "shared"] : ["web/data", "web/platform", "shared"];
      if (!isRelative(e)) return under("web/platform")(e.from) || packageOf(e.spec) !== "react";
      return !own.some((d) => under(d)(e.to));
    },
  },
  {
    id: "L6",
    rule: "server/platform/** never imports server/features/**",
    applies: under("server/platform"),
    forbids: (e) => isRelative(e) && under("server/features")(e.to),
  },
  {
    id: "L9",
    rule: "a server feature's repo.ts imports only server/platform/db/** (its statements and their row types, no logic)",
    applies: (from) => /^server\/features\/[^/]+\/repo\.ts$/.test(from),
    forbids: (e) => !isRelative(e) || !under("server/platform/db")(e.to),
  },
  {
    id: "L10",
    rule: "a server feature never imports another feature's routes.ts (only server/features/index.ts assembles them)",
    applies: (from) => featureOf(from) !== null,
    forbids: (e) => isRelative(e) && /^server\/features\/[^/]+\/routes\.ts$/.test(e.to) && featureOf(e.to) !== featureOf(e.from),
  },
];

// Known violations as "from -> to". This list may only shrink.
const ALLOWED: Record<string, string[]> = {
  L1: [],
  L2: [],
  // the pdf.js runtime asks the data layer for the room's path prefix (StrataPath)
  L3: ["web/engines/pdf/runtime.ts -> web/data/api.ts"],
  L4: [
    // shell's presentation leaves (atoms, format, CardIcon) have no home outside shell yet
    "web/capabilities/progress/KeptChart.tsx -> web/shell/CardIcon.tsx",
    "web/capabilities/progress/Timeline.tsx -> web/shell/format.js",
    "web/capabilities/progress/Timeline.tsx -> web/shell/CardIcon.tsx",
    "web/capabilities/sources/Capture.tsx -> web/shell/atoms.tsx",
  ],
  L7: [],
  L8: [],
  L6: [],
  L9: [],
  // the keeps bench groups cards with the review's flatten(); it belongs in a review module
  L10: ["server/features/keeps/routes.ts -> server/features/review/routes.ts"],
};

test("the scanner reads the tree and finds its edges", () => {
  // A broken scanner would pass every rule vacuously, so these edges must be found.
  assert.ok(FILES.length > 100, `only ${FILES.length} source files found`);
  const has = (from: string, to: string) => EDGES.some((e) => e.from === from && e.to === to);
  assert.ok(has("server/main.ts", "server/features/index.ts"), "static import");
  assert.ok(has("server/features/decks/routes.ts", "shared/cards/faces.ts"), "server → shared");
  assert.ok(has("server/features/imports/pump.ts", "server/features/imports/pdf-worker.ts"), "new URL(…, import.meta.url)");
  assert.ok(EDGES.some((e) => e.from === "shared/cards/card-tidy.ts" && e.to === "shared/cards/faces.ts"), "shared → shared");
  assert.ok(EDGES.some((e) => /\bimport\(/.test(readFileSync(join(REPO, e.from), "utf8")) && e.to.startsWith("web/")), "dynamic import()");
});

for (const r of RULES) {
  test(`${r.id}: ${r.rule}`, () => {
    const found = EDGES.filter((e) => r.applies(e.from) && r.forbids(e)).map((e) => `${e.from} -> ${e.to}`);
    const allowed = new Set(ALLOWED[r.id] ?? []);
    const fresh = found.filter((v) => !allowed.has(v));
    const gone = [...allowed].filter((v) => !found.includes(v));
    assert.deepEqual(fresh, [], `${r.id} violated (move the code, do not allowlist it):\n  ${fresh.join("\n  ")}`);
    assert.deepEqual(gone, [], `${r.id}: these allowed violations are gone, delete them from ALLOWED:\n  ${gone.join("\n  ")}`);
  });
}

const CLIENT = FILES.filter(under("web"));
const WIRE_DOOR = "web/data/api.ts";
const STATIC_FETCH = ["web/capabilities/offline", "web/engines/pdf"];
const CALLS: { what: string; re: RegExp }[] = [
  { what: "fetch", re: /(?<![\w$.])fetch\s*\(|\b(?:window|globalThis|self)\.fetch\s*\(/ },
  { what: "sendBeacon", re: /\bsendBeacon\s*(?:\?\.)?\s*\(/ },
  { what: "EventSource", re: /\bnew\s+EventSource\b/ },
  { what: "XMLHttpRequest", re: /\bnew\s+XMLHttpRequest\b/ },
  { what: "patches fetch", re: /\b(?:window|globalThis|self)\.fetch\s*=(?!=)/ },
  { what: "fetchAsset", re: /\bfetchAsset\s*\(/ },
];
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
function wireCalls(file: string): string[] {
  if (file === WIRE_DOOR) return [];
  const statics = STATIC_FETCH.some((d) => under(d)(file));
  const found = new Set<string>();
  for (const line of stripComments(readFileSync(join(REPO, file), "utf8")).split("\n")) {
    for (const c of CALLS) {
      if (!c.re.test(line)) continue;
      if (c.what === "fetch" && statics && !/\/api\b/.test(line)) continue;
      if (c.what === "fetchAsset" && !/\/api\b/.test(line)) continue;
      found.add(`${file}: ${c.what}`);
    }
  }
  return [...found];
}
// Known, tolerated calls as "file: call". This list may only shrink.
const ALLOWED_CALLS: string[] = [];

test("the wire scan finds a call where there is one", () => {
  // A broken scan would pass vacuously, so these calls must be found.
  const hits = (src: string) => CALLS.filter((c) => c.re.test(stripComments(src))).map((c) => c.what);
  assert.deepEqual(hits('fetch("/api/x")'), ["fetch"]);
  assert.deepEqual(hits("window.fetch = wrapped"), ["patches fetch"]);
  assert.deepEqual(hits("navigator.sendBeacon?.(url, blob)"), ["sendBeacon"]);
  assert.deepEqual(hits("query.fetch().then(go)"), [], "a method named fetch is not the wire");
  assert.deepEqual(hits("// fetch(\"/api/x\") in a comment"), []);
  assert.deepEqual(hits('fetchAsset(StrataPath("/api/boards"))'), ["fetchAsset"], "the static files' fetch is not a way round the door");
  assert.ok(wireCalls(WIRE_DOOR).length === 0 && /\bfetch\(/.test(readFileSync(join(REPO, WIRE_DOOR), "utf8")), "the door itself fetches");
});

test("L5: only web/data/api.ts calls fetch/sendBeacon/EventSource/XMLHttpRequest with an /api URL or patches window.fetch", () => {
  const found = CLIENT.flatMap(wireCalls);
  const allowed = new Set(ALLOWED_CALLS);
  const fresh = found.filter((v) => !allowed.has(v));
  const gone = [...allowed].filter((v) => !found.includes(v));
  assert.deepEqual(fresh, [], `L5 violated (call through web/data/api.ts):\n  ${fresh.join("\n  ")}`);
  assert.deepEqual(gone, [], `L5: these allowed calls are gone, delete them from ALLOWED_CALLS:\n  ${gone.join("\n  ")}`);
});

// crypto.randomUUID is undefined over plain HTTP (no secure context), so each call needs a feature test.
const UNGUARDED_UUID = /(?<!\?\.\s*randomUUID\s*\?\s*)\bcrypto\s*\.\s*randomUUID\s*\(/;
test("no client file calls crypto.randomUUID without checking it is there", () => {
  assert.ok(UNGUARDED_UUID.test("{id:crypto.randomUUID(),board}"), "the scan finds a bare call");
  assert.ok(!UNGUARDED_UUID.test("(crypto?.randomUUID ? crypto.randomUUID() : fallback)"), "a guarded call passes");
  const found = CLIENT.filter((f) => stripComments(readFileSync(join(REPO, f), "utf8")).split("\n").some((l) => UNGUARDED_UUID.test(l)));
  assert.deepEqual(found, [], `crypto.randomUUID throws on the plain-http tailnet; use mintKey (web/data/mutate.ts):\n  ${found.join("\n  ")}`);
});

test.todo("L3 (rest): web/engines/** never calls the API or reads the store");
