import { compileImportPlan } from "../../../shared/imports/import-plan.ts";

import { logEvent } from "../../platform/events/events.ts";
import { captureFilename } from "../capture/capture.ts";
import { APP, deps } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { now } from "../../platform/db/sql.ts";
import { cleanImportedMarkdown } from "./markdown-clean.ts";
import { q } from "../repo.ts";
import type { ResourceRow, SectionRow } from "../../platform/db/rows.ts";
import { isPdf, kindOf, bytesOf, sliceOf, rawOpen, rawCache, sectionsCount, pagesOf } from "./blobs.ts";
import { sourceFor, htmlSource, prepareSource, writeSource, pairForResource, type IncomingSection } from "./ingest.ts";
import { genSlug } from "../decks/decks.ts";
import { sendJson, sendRanged, etagOf, contentDisposition } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
import type { ServerResponse } from "node:http";
// Side-effect import: the board-state builder registers itself on load.
import "../boards/state.ts";
import { LIVE_CSP, withBridge } from "./live.ts";
import { pageStateProblem } from "../../../shared/reading/page-state.ts";

export const resourceRoutes: Route[] = [
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources$/, async ({ res, ssn, params, body, commit }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<UploadBody>();
    const filename = (b.filename ?? "resource").slice(0, 200);
    const html = b.base64 ? htmlSource(filename, Buffer.from(b.base64.split(",").pop() ?? "", "base64").toString("utf-8")) : null;
    const prepared = html ? await prepareSource({ filename, ...html, createPair: b.pair === true, study: b.study !== false }) : await prepareUpload(res, filename, b);
    if (!prepared) return;
    commit(() => {
      const rid = writeSource(boardId, prepared, ssn);
      const nsec = sectionsCount(rid);
      // Only a divided source gets its pairs here; the client makes a single pair in a second request.
      if (nsec > 1) pairForResource(boardId, filename.replace(/\.[^.]+$/, ""), rid);
      logEvent(db, APP, "resource_add", { board: boardId, kind: prepared.input.kind === "pdf" || prepared.input.kind === "html" ? prepared.input.kind : "text", via: "upload", sections: nsec }, ssn);
      return { status: 201, body: { id: rid, resourceId: rid, sections: nsec, state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("PATCH", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)$/, async ({ res, ssn, params, body, commit }) => {
    const [boardId, rid] = params; const cur = q.resource.get(boardId, rid) as ResourceRow | undefined;
    if (!cur) { sendJson(res, 404, { error: "no such resource" }); return; }
    const b = await body<{ included?: boolean; filename?: string; done?: boolean; pair?: boolean }>();
    const name = b.filename !== undefined ? captureFilename(String(b.filename)) : null;
    if (b.filename !== undefined && (!name || name === "untitled")) { sendJson(res, 400, { error: "a source needs a name" }); return; }
    commit(() => {
      if (name !== null) {
        const was = cur.filename ?? "";
        q.setResourceName.run(name, boardId, rid);
        if (was && was !== name) { q.renameCopiedPairLabels.run(name, boardId, rid, was); q.renameCopiedSectionLabels.run(name, rid, was); }
        if (b.pair === true) q.renameSolePair.run(name, boardId, rid, boardId, rid);
        logEvent(db, APP, "resource_rename", { board: boardId }, ssn);
      }
      if (b.included !== undefined) {
        q.setResourceIncluded.run(b.included === false ? 0 : 1, boardId, rid);
        logEvent(db, APP, "resource_toggle", { board: boardId, included: b.included !== false }, ssn);
      }
      if (b.done !== undefined) {
        q.setResourceDone.run(b.done ? Date.now() : null, boardId, rid);
        logEvent(db, APP, "resource_done", { board: boardId, resource: rid, done: !!b.done }, ssn);
      }
      return { status: 200, body: { state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("DELETE", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)$/, ({ res, ssn, url, params, commit }) => {
    const [boardId, rid] = params; if (!q.resource.get(boardId, rid)) { sendJson(res, 404, { error: "no such resource" }); return; }
    // Sections go with their source; pairs stay as blank pages unless ?pairs=1 (the shelf's delete).
    commit(() => {
      for (const s of q.sectionsOf.all(rid) as SectionRow[]) { q.delCourseCards.run(genSlug(s.id)); q.delCourse.run(genSlug(s.id)); }
      q.delResource.run(boardId, rid); q.delBlob.run(rid);
      q.delPlace.run(boardId, rid); q.delPlacesOfResourcePairs.run(boardId, boardId, rid);
      if (url.searchParams.get("pairs") === "1") q.delPairsOfResource.run(boardId, rid);
      q.clearPairResource.run(boardId, rid);
      q.delSectionsOf.run(rid); q.delTreesOfResource.run(rid); q.delSourceTree.run(rid);
      q.delMarksOfResource.run(rid); q.delRepliesOfResource.run(rid); q.delAsksOfResource.run(rid); q.delPageState.run(rid);
      logEvent(db, APP, "resource_remove", { board: boardId, pairs: url.searchParams.get("pairs") === "1" }, ssn);
      return { status: 200, body: { state: stateOf(boardId) } };
    });
    // the cached bytes go once the rows have (a delete that rolled back still has a source)
    rawCache.forget(rid);
  }, { receipt: "atomic" }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/pagetext$/, ({ res, params }) => {
    const [boardId, rid] = params; if (!q.resource.get(boardId, rid)) { sendJson(res, 404, { error: "no such resource" }); return; }
    sendJson(res, 200, { pages: pagesOf(rid) });
  }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/preview$/, ({ res, params }) => {
    const preview = q.resourcePreview.get(params[0],params[1]);
    if (!preview) { sendJson(res,404,{error:"no such resource"}); return; }
    const lines = (preview.text ?? "").split("\n")
      .map(line=>line.replace(/^#+\s*/, "").replace(/[*_`>[\]]/g, "").trim())
      .filter(line=>line.length>2).slice(0,6).map(line=>line.slice(0,160));
    sendJson(res,200,{lines});
  }),

  // the page runs on an opaque origin: it can draw and compute, never read the room or call its API
  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/live$/, ({ res, params }) => {
    const [boardId, rid] = params; const r = q.resource.get(boardId, rid) as ResourceRow | undefined;
    if (!r || kindOf(r) !== "html" || !r.bytes_len) { sendJson(res, 404, { error: "no live page for this source" }); return; }
    const page = withBridge(bytesOf(rid)?.toString("utf-8") ?? "");
    res.removeHeader("X-Frame-Options");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": LIVE_CSP });
    res.end(page);
  }),

  // what a live page kept with window.strata.save: one JSON value, replaced whole
  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/state$/, ({ res, params }) => {
    const [boardId, rid] = params;
    if (!isLive(boardId, rid)) { sendJson(res, 404, { error: "no live page for this source" }); return; }
    const s = q.pageState.get(rid);
    sendJson(res, 200, { value: s?.value ?? null, rev: s?.rev ?? 0 });
  }),

  route("PUT", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/state$/, async ({ res, ssn, params, body, commit, ifMatch }) => {
    const [boardId, rid] = params;
    if (!isLive(boardId, rid)) { sendJson(res, 404, { error: "no live page for this source" }); return; }
    const value = (await body<{ value?: unknown }>()).value;
    const why = pageStateProblem(value);
    if (why) { sendJson(res, 400, { error: why }); return; }
    commit(() => {
      ifMatch(q.pageState.get(rid)?.rev ?? 0, () => ({ value: q.pageState.get(rid)?.value ?? null }));
      q.setPageState.run(rid, boardId, value as string, now());
      logEvent(db, APP, "page_state_write", { board: boardId, resource: rid, len: (value as string).length }, ssn);
      return { status: 200, body: { rev: q.pageState.get(rid)?.rev ?? 0 } };
    });
  }, { receipt: "atomic" }),

  route("GET", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/resources\/([a-zA-Z0-9_-]+)\/raw$/, ({ req, res, ssn, params }) => {
    const [boardId, rid] = params; const r = q.resource.get(boardId, rid) as ResourceRow | undefined;
    if (!r) { sendJson(res, 404, { error: "no such resource" }); return; }
    logEvent(db, APP, "resource_view", { board: boardId, resource: rid, kind: isPdf(r) ? "pdf" : "text" }, ssn);
    // a PDF is answered from its length alone until the bytes are genuinely owed
    if (r.bytes_len && isPdf(r)) {
      sendRanged(req, res, {
        len: r.bytes_len,
        tag: etagOf(r.id, r.bytes_len, r.created_at),
        type: r.mime ?? "application/pdf",
        disposition: contentDisposition(r.filename ?? "resource"),
        read: (start, len) => sliceOf(rid, start, len),
        open: (start, end) => rawOpen(rid, r.bytes_len as number, start, end),
      });
      return;
    }
    const bodyBuf = Buffer.from(r.text ?? (r.bytes_len ? (bytesOf(rid)?.toString("utf-8") ?? "") : ""), "utf-8");
    sendRanged(req, res, {
      len: bodyBuf.length,
      tag: etagOf(r.id, bodyBuf.length, r.created_at, r.generation),
      type: "text/plain; charset=utf-8",
      read: (start, len) => bodyBuf.subarray(start, start + len),
    });
  }),
];

type UploadBody = { filename?: string; base64?: string; text?: string; kind?: string; sections?: IncomingSection[]; pageText?: string[]; importPlan?: unknown; pair?: boolean; study?: boolean };
async function prepareUpload(res: ServerResponse, filename: string, b: UploadBody) {
  const src = sourceFor(filename, b.base64, b.text);
  if (!src.text && !src.file) {
    sendJson(res, 400, { error: b.base64 !== undefined || b.text !== undefined ? `${filename} came through empty — there was nothing in it to read` : `${filename} arrived with neither bytes nor text` });
    return null;
  }
  const named = b.kind === "transcript" || b.kind === "text" || b.kind === "pdf" ? b.kind : null;
  const text = named === "transcript" ? src.text : await cleanImportedMarkdown(
    src.text ?? "",
    deps.geminiAvailable ? deps.callGeminiJson : undefined,
    (e) => console.error("[markdown-clean]", e),
  );
  if (b.importPlan !== undefined) {
    try {
      if (!src.file || !Array.isArray(b.pageText) || !b.pageText.every(t => typeof t === "string")) throw new Error("Grouping needs the PDF's extracted text.");
      compileImportPlan(b.importPlan,b.pageText);
    } catch (e) { sendJson(res,400,{error:(e as Error).message}); return null; }
  }
  return prepareSource({
    filename, kind: src.file ? "pdf" : (named && named !== "pdf" ? named : "text"),
    text, data: src.file?.data, mime: src.file?.mimeType,
    importPlan: b.importPlan,
    createPair: b.pair === true,
    study: b.study !== false,
    sections: Array.isArray(b.sections) ? b.sections : undefined,
    pageText: Array.isArray(b.pageText) ? b.pageText.map((t) => String(t ?? "")) : undefined,
  });
}

const isLive = (boardId: string, rid: string): boolean => {
  const r = q.liveKindOf.get(boardId, rid);
  return !!r && kindOf(r) === "html" && !!r.bytes_len;
};
