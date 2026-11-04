import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceTokens, pageGroups, studyTokens } from "../../../shared/imports/budget.ts";
import { compileImportPlan } from "../../../shared/imports/import-plan.ts";

const dir = mkdtempSync(join(tmpdir(), "strata-budget-"));
process.env.STRATA_DB = join(dir, "test.db");
process.env.STRATA_COURSES = join(dir, "courses");
process.env.STRATA_BUDGET_TOKENS = "1000";
process.env.GEMINI_API_KEY = "test-only";
const { q } = await import("../repo.ts");
const { db } = await import("../../platform/db/db.ts");
const { deps } = await import("../../platform/config.ts");
const { insertResource } = await import("../sources/ingest.ts");
const { enqueueDistil, distilSection, backfillDistil } = await import("./queue.ts");
const { distilRoutes } = await import("./routes.ts");
let generated = 0;
let counted: number | null = 1001;
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ totalTokens: counted }));
deps.callGeminiJson = async () => {
  generated++;
  return { title: "Test", question: "Why?", glossary: [], nodes: [{ label: "Ideas build on each other", kind: "synthesis", anchor: "p. 1", questions: ["Why do ideas build on each other?"], children: [] }], cards: [] };
};
after(() => { globalThis.fetch = fetchBefore; db.close(); rmSync(dir, { recursive: true, force: true }); });
q.insBoard.run("board", "Test", "course", 1, 1);
const pages = ["First chapter. ".repeat(40), "Second chapter. ".repeat(40)];
const outline = pageGroups(pages, 1000).outline;
const plan = { outline, starts: [1], excluded: [] };
const input = { filename: "Book.pdf", kind: "pdf", mime: "application/pdf", data: Buffer.from("pdf").toString("base64"), pageText: pages };

async function settled(rid: string) {
  for (const end = Date.now() + 10_000; Date.now() < end;) {
    const rows = q.treesOfResource.all(rid);
    if (rows.length && rows.every(row => row.status === "ready" || row.status === "error")) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("distil did not settle");
}

test("exact oversized count rejects an unconfirmed import before writes or generation", async () => {
  await assert.rejects(insertResource("board", input), { httpStatus: 428 });
  assert.equal(q.resourcesOf.all("board").length, 0);
  assert.equal(generated, 0);
});

test("fallback counts extracted text when exact counting fails; a confirmed oversized unit still fails", async () => {
  counted = null;
  const large = { ...input, pageText: ["word ".repeat(1000)] };
  await assert.rejects(insertResource("board", large), { httpStatus: 428 });
  await assert.rejects(insertResource("board", { ...large, importPlan: { ...plan, outline: [outline[0]], starts: [] } }), { httpStatus: 400 });
  assert.equal(q.resourcesOf.all("board").length, 0);
  assert.equal(generated, 0);
  counted = 1001;
});

test("confirmed scope distils only the selected range and persists consent", async () => {
  const rid = await insertResource("board", { ...input, importPlan: { ...plan, starts: [], excluded: [1] } });
  await settled(rid);
  const sections = q.sectionsOf.all(rid);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].last_page, 1);
  assert.ok(sections[0].content_ranges);
  assert.ok(generated > 0);
  const before = generated;
  await backfillDistil();
  assert.equal(generated, before, "completed selected scope is not regenerated");
});

test("the budget boundary keeps ordinary automatic imports working", async () => {
  counted = 1000;
  const rid = await insertResource("board", input);
  await settled(rid);
  assert.equal(q.tree.get(q.sectionsOf.all(rid)[0].id)?.status, "ready");
  counted = 1001;
});

test("restart, enqueue, and direct distil cannot bypass missing consent; ready cards survive", async () => {
  q.insResource.run("legacy", "board", "Old book.pdf", "application/pdf", null, 1001, 1, "pdf", null, 3);
  q.insBlob.run("legacy", Buffer.from("pdf"), JSON.stringify(pages));
  for (const [i, status] of ["running", "queued", "ready"].entries()) {
    const sid = `legacy-${i}`;
    q.insSection.run(sid, "legacy", "board", i, "Chapter", 1, 1, 1, 100);
    q.upsertTree.run(sid, "legacy", "board", "Chapter", "", "{}", "tree", status, null, status === "ready" ? 5 : 0, 1);
  }
  const before = generated;
  await backfillDistil();
  assert.equal(q.tree.get("legacy-0")?.status, "error");
  assert.equal(q.tree.get("legacy-1")?.status, "error");
  assert.equal(q.tree.get("legacy-2")?.status, "ready");
  assert.equal(q.tree.get("legacy-2")?.cards, 5);
  assert.equal(enqueueDistil("board", "legacy-0", null, "explicit", true), false);
  // claimable again, so only the consent hold (not the claim) can stop the direct call
  q.setTreeStatus.run("queued", null, 1, "legacy-1");
  await distilSection("board", "legacy-1", null);
  assert.equal(q.tree.get("legacy-1")?.status, "error", "held, and told why");
  await backfillDistil();
  assert.equal(generated, before);
});

test("explicit API requests reject oversized sources and foreign sections", async () => {
  let status = 0;
  const response = { writeHead: (code: number) => { status = code; }, end: () => {} };
  const route = distilRoutes[0];
  const { handler } = route;
  const before = generated;
  await handler({ res: response, params: ["board", "legacy"], url: new URL("http://test/distil?section=legacy-0"), ssn: null } as never);
  assert.equal(status, 409);
  const foreign = q.sectionsOf.all(q.resourcesOf.all("board").find(r => r.id !== "legacy")!.id)[0];
  await handler({ res: response, params: ["board", "legacy"], url: new URL(`http://test/distil?section=${foreign.id}`), ssn: null } as never);
  assert.equal(status, 404);
  assert.equal(generated, before);
});

test("page groups offer bounded choices without bookmarks; exact counts override estimates", () => {
  const pages = Array.from({ length: 12 }, () => "word ".repeat(100));
  const groups = pageGroups(pages, 1000);
  const selected = compileImportPlan({ outline: groups.outline, starts: groups.defaultStarts, excluded: [] }, pages);
  assert.ok(selected.length > 1);
  assert.ok(selected.every(unit => studyTokens(unit, pages) <= 1000));
  assert.equal(sourceTokens({ tokens: 1000, bytes: 99999999, pages }), 1000);
});
