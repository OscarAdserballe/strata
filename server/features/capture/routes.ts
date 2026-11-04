import { logEvent } from "../../platform/events/events.ts";
import {
  isYouTube, isHttpUrl, ytDlpCommand, fetchOembed,
  transcriptToMarkdown, captureFilename, hostname, captureAvailable, FIRECRAWL_KEY, NoTranscript,
} from "./capture.ts";
import { APP } from "../../platform/config.ts";
import { prepareArticle, prepareVideo, type PreparedCapture } from "./article.ts";
import { db } from "../../platform/db/db.ts";
import { q } from "../repo.ts";
import { prepareSource, writeSource, pairForResource } from "../sources/ingest.ts";
import { sendJson } from "../../platform/http/http.ts";
import { route, stateOf, type Route } from "../../platform/router/router.ts";
// Side-effect import: the board-state builder registers itself on load.
import "../boards/state.ts";

// Captures await first, then write source, pair and event in one commit, so a resent capture replays.
export const captureRoutes: Route[] = [
  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/capture$/, async ({ res, ssn, params, body, commit }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ url?: string }>();
    const url = String(b.url ?? "").trim();
    if (!isHttpUrl(url)) { sendJson(res, 400, { error: "that doesn't look like a link" }); return; }

    const kind = isYouTube(url) ? "youtube" : "article";
    logEvent(db, APP, "capture_start", { board: boardId, kind, host: hostname(url) }, ssn);

    let captured: PreparedCapture | null = null;
    if (kind === "youtube") {
      let why: string | null = null, seen: { title?: string; author?: string } = {};
      if (FIRECRAWL_KEY) {
        try { captured = await prepareVideo(url); }
        catch (e) {
          why = e instanceof NoTranscript
            ? "YouTube shows no transcript for this video, so it couldn't be fetched here. If it has captions, you can download them yourself."
            : `The transcript couldn't be fetched here (${e instanceof Error ? e.message : "failed"}). You can download the captions yourself.`;
          if (e instanceof NoTranscript && e.video.title) seen = e.video;
          logEvent(db, APP, "capture_error", { board: boardId, kind, why: why.slice(0, 120) }, ssn);
        }
      }
      if (!captured) {
        const o = seen.title ? seen : await fetchOembed(url);
        sendJson(res, 200, { kind: "youtube", url, title: o.title ?? url, author: o.author ?? null, why,
          ytDlpCommand: ytDlpCommand(url),
          ytDlpCommands: { macos: ytDlpCommand(url), windows: ytDlpCommand(url, "windows") } }); return;
      }
    } else {
      if (!captureAvailable) {
        logEvent(db, APP, "capture_error", { board: boardId, kind, why: "no fetcher configured" }, ssn);
        sendJson(res, 503, { error: "no article fetcher configured — set TAVILY_API_KEY or FIRECRAWL_API_KEY" }); return;
      }
      try { captured = await prepareArticle(url); }
      catch (e) {
        const why = e instanceof Error ? e.message : "couldn't fetch that page";
        logEvent(db, APP, "capture_error", { board: boardId, kind, host: hostname(url), why: why.slice(0, 120) }, ssn);
        sendJson(res, 502, { error: why }); return;
      }
    }
    const { prepared, filename, title } = captured;
    commit(() => {
      const rid = writeSource(boardId, prepared, ssn);
      const pid = pairForResource(boardId, filename, rid);
      logEvent(db, APP, "capture_done", { board: boardId, kind, host: hostname(url) }, ssn);
      return { status: 201, body: { kind: kind === "youtube" ? "transcript" : "article", resourceId: rid, pairId: pid, title, state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),

  route("POST", /^\/api\/boards\/([a-zA-Z0-9_-]+)\/capture\/finish$/, async ({ res, ssn, params, body, commit }) => {
    const boardId = params[0]; if (!q.board.get(boardId)) { sendJson(res, 404, { error: "no such board" }); return; }
    const b = await body<{ url?: string; title?: string; author?: string; vtt?: string }>();
    const url = String(b.url ?? "").trim();
    const vtt = String(b.vtt ?? "");
    if (!isHttpUrl(url)) { sendJson(res, 400, { error: "that doesn't look like a link" }); return; }
    if (!vtt.includes("-->")) { logEvent(db, APP, "capture_error", { board: boardId, kind: "transcript", why: "not a vtt" }, ssn); sendJson(res, 400, { error: "that doesn't look like a .vtt caption file" }); return; }
    const title = String(b.title ?? "").trim() || url;
    const { text, cues } = transcriptToMarkdown(vtt, { title, author: b.author ?? undefined, url });
    if (!cues) { logEvent(db, APP, "capture_error", { board: boardId, kind: "transcript", why: "no cues" }, ssn); sendJson(res, 400, { error: "no captions found in that file" }); return; }
    const filename = captureFilename(title);
    const prepared = await prepareSource({ filename, kind: "transcript", text, originUrl: url });
    commit(() => {
      const rid = writeSource(boardId, prepared, ssn);
      const pid = pairForResource(boardId, filename, rid);
      logEvent(db, APP, "capture_done", { board: boardId, kind: "transcript", cues }, ssn);
      return { status: 201, body: { kind: "transcript", resourceId: rid, pairId: pid, cues, state: stateOf(boardId) } };
    });
  }, { receipt: "atomic" }),
];
