import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WRITES, offlineReads } from "../shared/offline/contract.ts";

const REPO = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(REPO, rel), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(rel, out); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(rel);
  }
  return out;
}

/** Every write op the client builds, by label: a label followed by its method, with no other label between. */
function opLabels(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk("web")) {
    const src = read(file);
    for (const m of src.matchAll(/label:\s*(?:[\w.]+\s*\?\?\s*)?"([^"]+)"([\s\S]{0,400}?)method:/g)) {
      if (!/label:/.test(m[2])) found.set(m[1], file);
    }
  }
  return found;
}

/** The StrataAPI calls that write outside the save path: posts, keyed captures and model streams. */
function apiWrites(): string[] {
  const src = read("web/data/api.ts");
  const body = src.slice(src.indexOf("export const StrataAPI = {"));
  const out: string[] = [];
  for (const m of body.matchAll(/^ {2}(\w+):([^\n]*(?:\n {4}[^\n]*)*)/gm)) {
    if (/keyed\(|"(POST|PUT|PATCH|DELETE)"|Stream\(/.test(m[2])) out.push(`api.${m[1]}`);
  }
  return out;
}

const KINDS_BY_FILE: Record<string, string> = { grade: "web/data/entities/grades.ts", link: "web/capabilities/sources/waiting-links.ts" };
function outboxKinds(): Set<string> {
  const kinds = new Set<string>();
  for (const file of walk("web")) for (const m of read(file).matchAll(/\.kind(?:<\w+>)?\("([\w-]+)"/g)) kinds.add(m[1]);
  for (const [kind, file] of Object.entries(KINDS_BY_FILE)) if (existsSync(join(REPO, file))) kinds.add(kind);
  return kinds;
}

test("every client write is placed in shared/offline/contract.ts: it waits on the device, or needs the server and says why", () => {
  const found = [...opLabels().keys(), ...apiWrites()];
  const missing = found.filter((w) => !(w in WRITES));
  assert.deepEqual(missing, [], `classify ${missing.map((m) => JSON.stringify(m)).join(", ")} in shared/offline/contract.ts: { waits: "<outbox kind>" } or { online: "<why it needs the server>" }`);
  const stale = Object.keys(WRITES).filter((w) => !found.includes(w));
  assert.deepEqual(stale, [], `shared/offline/contract.ts lists writes no code makes any more: ${stale.join(", ")}`);
});

test("a write that waits offline names an outbox kind that is registered", () => {
  const kinds = outboxKinds();
  const unknown = Object.entries(WRITES).flatMap(([w, o]) => ("waits" in o && !kinds.has(o.waits) ? [`${w} → ${o.waits}`] : []));
  assert.deepEqual(unknown, [], `no outbox kind registered for ${unknown.join(", ")}`);
});

test("an online-only write says why, so the button can grey out with the reason", () => {
  const bare = Object.entries(WRITES).flatMap(([w, o]) => ("online" in o && o.online.trim().length < 12 ? [w] : []));
  assert.deepEqual(bare, []);
});

test("a downloaded board saves what review, the concept tree and a live primer read", () => {
  const reads = offlineReads("b1", {
    pairs: [{ deck: "econ" }],
    resources: [{ id: "r1", kind: "pdf" }, { id: "r2", kind: "html", generation: 3 }],
    sections: [{ id: "s1", resourceId: "r1" }],
  });
  for (const want of ["/api/review", "/api/review/tree?course=econ", "/api/decks/econ", "/api/boards/b1/resources/r1/tree",
    "/api/boards/b1/resources/r1/tree?section=s1", "/api/boards/b1/resources/r2/live?v=3", "/api/boards/b1/resources/r1/raw"]) {
    assert.ok(reads.includes(want), `the download misses ${want}`);
  }
  assert.ok(!reads.includes("/api/boards/b1/resources/r1/preview"), "a PDF has no text preview");
});
