import { distilBudgetError } from "./budget.ts";
import { geminiAvailable } from "../../platform/llm/gemini.ts";
import { logEvent } from "../../platform/events/events.ts";
import { normalizeTree, treeToAscii, flattenTree, type ConceptTree } from "./distil.ts";
import { APP } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { now, parseJson } from "../../platform/db/sql.ts";
import { boardRev } from "../boards/repo.ts";
import type { SectionRow, ResourceRow } from "../../platform/db/rows.ts";
import { genSlug, installDeck } from "../decks/decks.ts";
import { classifyThenQueue, enqueueDistil, isDistilRunning, startPump, isWork } from "./queue.ts";
import { applySplit, splitBrief, splitChoice, splitRevOf } from "./resection.ts";
import { kindOf, pagesOf } from "../sources/blobs.ts";
import { compileImportPlan, type StudyUnit } from "../../../shared/imports/import-plan.ts";
import { studyTokens } from "../../../shared/imports/budget.ts";
import { BUDGET_TOKENS } from "../../platform/config.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
// Side-effect import: the board-state builder registers itself on load.
import "../boards/state.ts";
import type { TreeResponse } from "../../../shared/types/index.ts";

export const distilRoutes: Route[] = [
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/distil$/, ({ res, url, ssn, params, commit }) => {
    const [boardId, rid] = params;
    const resource = q.resource.get(boardId, rid);
    if (!resource) { sendJson(res, 404, { error: "no such resource" }); return; }
    const want = url.searchParams.get("section");
    const sections = q.sectionsOf.all(rid) as SectionRow[];
    // A source never studied is classified first, exactly as it would have been on arrival.
    if (!want && sections.length && sections.every((s) => q.tree.get(s.id)?.status === "unstudied")) {
      // 409, not 503: a room with no key will not grow one, so the save path must not keep retrying
      if (!geminiAvailable) { sendJson(res, 409, { error: "this room has no model key, so it can't make flashcards" }); return; }
      commit(() => {
        for (const s of sections) q.setTreeStatus.run("preparing", null, now(), s.id);
        classifyThenQueue(boardId, rid, (resource.filename ?? "source").replace(/\.[^.]+$/, ""), ssn, "explicit");
        logEvent(db, APP, "distil_start", { board: boardId, sections: sections.length, first: true }, ssn);
        return { status: 202, body: { status: "running", sections: sections.length } };
      });
      return;
    }
    // An explicit re-distil skips apparatus and rebuilds `ready` sections, which the queue otherwise refuses.
    const targets = want
      ? [want]
      : sections.filter(isWork).map((s) => s.id);
    for (const sid of targets) {
      const section = q.section.get(sid);
      if (!section || section.resource_id !== rid || section.board_id !== boardId) { sendJson(res, 404, { error: "no such section" }); return; }
      const error = distilBudgetError(resource, section);
      if (error) { sendJson(res, 409, { error }); return; }
    }
    if (!geminiAvailable) { sendJson(res, 503, { error: "no GEMINI_API_KEY — distilling needs the model" }); return; }
    if (!targets.length) { sendJson(res, 202, { status: "idle", sections: 0 }); return; }
    if (targets.every((sid) => isDistilRunning(sid))) { sendJson(res, 202, { status: "running" }); return; }
    commit(() => {
      for (const sid of targets) {
        if (isDistilRunning(sid)) continue;
        enqueueDistil(boardId, sid, ssn, "explicit", true, !!want);
      }
      logEvent(db, APP, "distil_start", { board: boardId, sections: targets.length }, ssn);
      return { status: 202, body: { status: "running", sections: targets.length } };
    });
    startPump();
  }, { receipt: "atomic" }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/sections$/, async ({ res, params }) => {
    const [boardId, rid] = params;
    const r = q.resource.get(boardId, rid) as ResourceRow | undefined;
    const why = r ? splitRefusal(r) : "no such resource";
    if (why) { sendJson(res, r ? 409 : 404, { error: why }); return; }
    sendJson(res, 200, await splitChoice(r!));
  }),

  // The plan is compiled against the stored text before the commit, so nothing awaits inside it.
  route("PUT", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/sections$/, async ({ res, ssn, params, body, commit, ifMatch }) => {
    const [boardId, rid] = params;
    const b = await body<{ plan?: unknown }>(4 * 1024 * 1024);
    const r = q.resource.get(boardId, rid) as ResourceRow | undefined;
    const why = r ? splitRefusal(r) : "no such resource";
    if (why) { sendJson(res, r ? 409 : 404, { error: why }); return; }
    const pages = pagesOf(rid);
    let units: StudyUnit[];
    try {
      units = compileImportPlan(b.plan, pages);
      if (units.some((u) => studyTokens(u, pages) > BUDGET_TOKENS)) throw new Error("A study group exceeds the token budget. Split it or exclude material.");
    } catch (e) { sendJson(res, 400, { error: (e as Error).message }); return; }
    commit(() => {
      ifMatch(splitRevOf(rid), () => splitBrief(rid));
      const done = applySplit(boardId, r!, units, pages);
      let queued = 0;
      for (const s of q.sectionsOf.all(rid) as SectionRow[]) {
        if (!geminiAvailable) { if (!q.tree.get(s.id)) q.upsertTree.run(s.id, rid, boardId, s.label, "", null, null, "disabled", null, 0, now()); continue; }
        if (!isWork(s)) continue;
        // a run under the old shape is fenced off; queued, its finally runs it again on the new one
        if (isDistilRunning(s.id)) { if (done.changed.includes(s.id)) { q.clearTreeDraft.run(s.id); q.setTreeStatus.run("queued", null, now(), s.id); } continue; }
        if (enqueueDistil(boardId, s.id, ssn, "explicit", true)) queued++;
      }
      logEvent(db, APP, "sections_resplit", { board: boardId, sections: done.ids.length, kept: done.kept, removed: done.removed, refiled: done.refiled, queued }, ssn);
      return { status: 200, body: { state: stateOf(boardId), sections: done.ids.length, refiled: done.refiled, queued, rev: splitRevOf(rid) } };
    });
    startPump();
  }, { receipt: "atomic", maxBody: 4 * 1024 * 1024 }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/tree$/, ({ res, url, params }) => {
    const [boardId, rid] = params;
    const sections = q.sectionsOf.all(rid) as SectionRow[];
    const want = url.searchParams.get("section");
    const sid = want || (sections.length === 1 ? sections[0]?.id : null);
    if (!sid) {
      const src = q.sourceTree.get(rid) as { board_id: string; title: string; question: string; json: string | null; ascii: string | null; status: string; error: string | null } | undefined;
      const per = (q.treesOfResource.all(rid) as { section_id: string; status: string; cards: number; title: string }[]);
      const byId = new Map(per.map((t) => [t.section_id, t]));
      sendJson(res, src ? 200 : 404, {
        status: src?.status ?? "pending", error: src?.error ?? null, title: src?.title ?? "", question: src?.question ?? "",
        ascii: src?.ascii ?? null, tree: parseJson<ConceptTree | null>(src?.json ?? null, null),
        cards: per.reduce((a, t) => a + (t.cards || 0), 0),
        sections: sections.map((s) => ({ id: s.id, label: s.label, firstPage: s.first_page, lastPage: s.last_page, status: byId.get(s.id)?.status ?? "pending", cards: byId.get(s.id)?.cards ?? 0, deck: genSlug(s.id) })),
        rev: boardRev(src?.board_id ?? boardId),
      }); return;
    }
    const tree = sectionTree(sid);
    if (!tree) { sendJson(res, 404, { error: "not distilled yet" }); return; }
    sendJson(res, 200, tree);
  }),

  // The body is read first, so nothing awaits between the checks below and the commit.
  route("PUT", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/tree$/, async ({ res, url, ssn, params, body, commit, ifMatch }) => {
    const [boardId, rid] = params;
    const raw = await body<{ tree?: ConceptTree; cards?: Record<string, unknown>[] }>();
    const r = q.resource.get(boardId, rid) as ResourceRow | undefined;
    if (!r) { sendJson(res, 404, { error: "no such resource" }); return; }
    const sections = q.sectionsOf.all(rid) as SectionRow[];
    const sid = url.searchParams.get("section") || (sections.length === 1 ? sections[0]?.id : null);
    if (!sid) { sendJson(res, 400, { error: "this source has sections — name one with ?section=" }); return; }
    if (!sections.some((s) => s.id === sid)) { sendJson(res, 404, { error: "no such section" }); return; }
    if (!raw.tree || !Array.isArray(raw.tree.nodes)) { sendJson(res, 400, { error: "need a tree" }); return; }
    // Always normalize: node ids are positional and assigned here, never trusted from the body.
    const tree = normalizeTree(raw.tree, r.filename ?? "source");
    const title = tree.title || (r.filename ?? "source");
    commit(() => {
      ifMatch(treeRevOf(sid), () => sectionTree(sid));
      const n = Array.isArray(raw.cards) ? installDeck(boardId, sid, title, raw.cards, true) : 0;
      q.upsertTree.run(sid, rid, boardId, title, tree.question ?? "", JSON.stringify(tree), treeToAscii(tree), "ready", null, n, now());
      logEvent(db, APP, "tree_edit", { board: boardId, nodes: flattenTree(tree).length, cards: n }, ssn);
      return { status: 200, body: { ok: true, cards: n, state: stateOf(boardId), treeRev: treeRevOf(sid) } };
    });
  }, { receipt: "atomic" }),
];

// A split is chosen over page text, so only an extracted PDF of several sections has one to change.
function splitRefusal(r: ResourceRow): string | null {
  if (kindOf(r) !== "pdf") return "only a PDF's sections can be changed";
  if ((q.sectionsOf.all(r.id) as SectionRow[]).length < 2) return "this source has one section";
  if (!pagesOf(r.id).length) return "this PDF has no extracted text to divide; add the file again";
  return null;
}

type TreeRowOut ={ title: string; question: string; json: string | null; ascii: string | null; status: string; error: string | null; cards: number; rev?: number };
const treeRevOf = (sid: string): number => (q.tree.get(sid) as TreeRowOut | undefined)?.rev ?? 0;
function sectionTree(sid: string): TreeResponse | null {
  const row = q.tree.get(sid) as TreeRowOut | undefined;
  if (!row) return null;
  return {
    status: row.status, error: row.error, cards: row.cards, title: row.title, question: row.question,
    ascii: row.ascii, tree: parseJson<ConceptTree | null>(row.json, null), deck: genSlug(sid), rev: row.rev ?? 0,
  };
}
