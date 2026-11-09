// The fifteen MCP tools. tools/list is built from this list, so a tool exists only by being here.
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { q } from "../repo.ts";
import { imports } from "../imports/pump.ts";
import { prepareArticle, prepareVideo } from "../capture/article.ts";
import { captureAvailable, FIRECRAWL_KEY, isHttpUrl, isYouTube, NoTranscript } from "../capture/capture.ts";
import { insertBoard } from "../boards/create.ts";
import { pairForResource, writeSource } from "../sources/ingest.ts";
import { logEvent } from "../../platform/events/events.ts";
import { APP, MAX_UPLOAD_BYTES } from "../../platform/config.ts";
import { db } from "../../platform/db/db.ts";
import { genId } from "../../platform/db/sql.ts";
import { HANDLE, idOf, parseRef } from "../../../shared/agent/ids.ts";
import { agentRepo as a } from "./repo.ts";
import { budgetOf } from "./render.ts";
import { AgentError, boardList, boardOf, changes, CHANGE_KINDS, importContext, openLink, outline, render, search, SEARCH_KINDS, text, type Filter } from "./kinds.ts";
import { checkOps, OP_SCHEMAS, OPS, opLine, runOps } from "./ops.ts";
import { publicOrigin, uploadUrl, type Caller, type Scope } from "./tokens.ts";
import { addItems, checkItem, DashError, LINK_KINDS, STAGES as DASH_STAGES } from "../dashboard/dashboard.ts";
import { renderDashboard } from "../dashboard/render.ts";

export interface Env { req: IncomingMessage; caller: Caller }
type Args = Record<string, unknown>;
/** A read answers at once; a write does its awaiting first and hands back the part that runs in the commit. */
export type Tool = {
  name: string; title: string; description: string; inputSchema: object; scope: Scope;
} & ({ read(args: Args, env: Env): string } | { write(args: Args, env: Env): Promise<() => string> });

const fail = (msg: string): never => { throw new AgentError(msg); };
const schema = (properties: Record<string, object>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const STR = { type: "string" };
const BOARD = { type: "string", description: "The board's handle or id, as whoami lists them." };
const CURSOR = { type: "string", description: "The cursor from the end of a previous answer, to get the next part." };
const MAX = { type: "integer", minimum: 500, maximum: 24000, description: "Size limit in tokens (default 6000)." };
const STUDY = { type: "boolean", description: "Default false: the source arrives without flashcards, and the reader can make them later with a button on the page. Pass true only when the reader wants cards from it now (a book takes minutes)." };
const KEY = { type: "string", pattern: "^[A-Za-z0-9-]{8,80}$", description: "A fresh id for this write, 8–80 letters, digits or dashes. Resending the same key returns the first answer instead of writing twice." };

const GUIDE = (() => {
  const raw = readFileSync(new URL("./guide.md", import.meta.url), "utf8")
    .replace("{{MAX_MB}}", String(Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)))
    .replace("{{OPS}}", Object.keys(OPS).map(opLine).join("\n"));
  const topics = new Map<string, string>();
  for (const part of raw.split(/^## /m).slice(1)) topics.set(part.slice(0, part.indexOf("\n")).trim(), `## ${part.trim()}`);
  return topics;
})();
export const GUIDE_TOPICS = [...GUIDE.keys()];

const ACCEPTED = /\.(pdf|md|markdown|txt|html?)$/i;

const dash = <T,>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof DashError) throw new AgentError(e.message); throw e; } };
const DASH_LINK = schema({ kind: { type: "string", enum: [...LINK_KINDS] }, ref: { type: "string", description: "e.g. GD-247, PR #42, #north-beds" }, title: STR, url: STR }, ["kind", "ref"]);
const DASH_FROM = schema({ source: { type: "string", description: "e.g. Notion · 1:1 with Mara · 23 Oct" }, url: STR, quote: { type: "string", description: "The words it came from." } }, ["source"]);
const DASH_ITEM = {
  type: "object", additionalProperties: false, required: ["title", "from"],
  properties: {
    kind: { type: "string", enum: ["task"] },
    title: { type: "string", description: "One line, the way the person would say it." },
    context: { type: "string", description: "A line or two on what this is and why it came up, at most 400 characters. The reader writes the rest themselves, so don't draft a plan." },
    links: { type: "array", maxItems: 20, items: DASH_LINK, description: "What it is about and already exists: the Linear issue, PR, Slack thread, Notion page." },
    from: DASH_FROM,
    area: { type: "string", enum: ["work", "personal"], description: "Which backlog it lands in. Default: work for Slack, Linear, GitHub and meeting sources, personal otherwise." },
  },
};

export const TOOLS: Tool[] = [
  {
    name: "whoami", title: "Who am I", scope: "read",
    description: "Which token this is, what it may do, and the boards in this Strata room with their handles and ids. A good first call.",
    inputSchema: schema({}),
    read: (_args, { caller }) => `Connected as "${caller.name}" with ${caller.scopes.has("write") ? "read and write" : "read-only"} access.\n\n${boardList()}`,
  },
  {
    name: "get_outline", title: "Outline", scope: "read",
    description: "The light view: what is under something, one line each, with ids, counts and sizes. With no arguments, lists the boards. With a board, lists its collections and sources. With an id (a collection like thesis/kept, a source, a deck…), lists its children. Use get_context for full detail.",
    inputSchema: schema({ board: BOARD, id: { type: "string", description: "Optional: any id or pasted Strata link." }, cursor: CURSOR }),
    read: (x) => outline(x.board, x.id, budgetOf(undefined), x.cursor),
  },
  {
    name: "get_context", title: "Context", scope: "read",
    description: "Everything about one thing, as Markdown: a board (overview: purpose, milestones, recent changes, open questions, log tail), a collection (<board>/kept, /questions, /highlights, /comments, /plan, /log, /sources, /chat), a source, section, deck, card, question, highlight, group or milestone. Long answers end with a cursor for the next part.",
    inputSchema: schema({
      id: { type: "string", description: "An id such as thesis, thesis/kept, src_…, card_…, or a pasted Strata link." },
      filter: { type: "object", additionalProperties: false, description: "kept: { group, source, since }; questions: { state: open | answered }; highlights: { noted, source }; comments (the reader's notes on live pages): { source, state: open | with_agent | your_turn }; chat: { source, since }.",
        properties: { group: STR, source: STR, since: { type: "string", description: "A date, e.g. 2026-10-01." }, state: { type: "string", enum: ["open", "answered", "with_agent", "your_turn"] }, noted: { type: "boolean" } } },
      cursor: CURSOR, max_tokens: MAX,
    }, ["id"]),
    read: (x, { req }) => {
      const r = parseRef(String(x.id ?? "")) ?? fail(`"${String(x.id)}" is not an id. get_guide({ topic: "ids" }) lists them.`);
      return render(r, (x.filter ?? {}) as Filter, x.cursor, budgetOf(x.max_tokens), false, publicOrigin(req));
    },
  },
  {
    name: "get_text", title: "Source text", scope: "read",
    description: "The extracted text of a source (src_…) or one section (sec_…), with [page n] markers for PDFs. Optionally a page range. Books are long: prefer a section, and follow the cursor for more.",
    inputSchema: schema({ id: STR, pages: { type: "string", description: "A page or range, e.g. \"12-18\"." }, cursor: CURSOR, max_tokens: MAX }, ["id"]),
    read: (x) => text(x.id, x.pages, x.cursor, budgetOf(x.max_tokens)),
  },
  {
    name: "search", title: "Search", scope: "read",
    description: `Finds things by words in them. Send several queries at once, each { kind, query } with kind one of ${SEARCH_KINDS.join(", ")}. Without a board, searches every board. Sources come newest first, each with the day it was added. Returns ids to read with get_context.`,
    inputSchema: schema({
      board: BOARD,
      queries: { type: "array", minItems: 1, maxItems: 10, items: schema({ kind: { type: "string", enum: [...SEARCH_KINDS] }, query: STR }, ["kind", "query"]) },
      max_tokens: MAX,
    }, ["queries"]),
    read: (x) => search(x.board, x.queries, budgetOf(x.max_tokens)),
  },
  {
    name: "get_changes", title: "What changed", scope: "read",
    description: `What happened on a board since a date, newest first: ${CHANGE_KINDS.join(", ")}. "reviewed" lists cards graded in review or drill, with got/missed. Defaults to the last 14 days, all kinds.`,
    inputSchema: schema({
      board: BOARD, since: { type: "string", description: "A date, e.g. 2026-10-01." },
      kinds: { type: "array", items: { type: "string", enum: [...CHANGE_KINDS] } },
      limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: CURSOR, max_tokens: MAX,
    }, ["board"]),
    read: (x) => changes(boardOf(x.board), x.since, x.kinds, x.limit, x.cursor, budgetOf(x.max_tokens)),
  },
  {
    name: "get_guide", title: "Guide", scope: "read",
    description: `How to use this server. Topics: ${GUIDE_TOPICS.join(", ")}. Read "uploads" before request_upload.`,
    inputSchema: schema({ topic: { type: "string", enum: GUIDE_TOPICS } }),
    read: (x) => x.topic ? (GUIDE.get(String(x.topic)) ?? fail(`Topics: ${GUIDE_TOPICS.join(", ")}.`)) : [...GUIDE.values()].join("\n\n"),
  },
  {
    name: "request_upload", title: "Upload files", scope: "write",
    description: "Step one of adding local files (PDF, Markdown, text, HTML) to a board, or of revising one. New files arrive without flashcards unless study is true. An HTML, Markdown or text file sent again under the same origin.ref replaces that source in place (same src_ id, highlights and cards kept); a changed PDF is added as a new source. An HTML page with scripts or drawings opens live in the reader. Returns, per file, either the existing source (same bytes already there) or a one-time upload_url to PUT the raw bytes to, e.g. with curl --data-binary. Read get_guide({ topic: \"uploads\" }) first.",
    inputSchema: schema({
      board: BOARD, key: KEY, study: STUDY,
      files: { type: "array", minItems: 1, maxItems: 20, items: schema({ name: STR, bytes: { type: "integer", minimum: 1 }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }, ["name", "bytes", "sha256"]) },
      origin: schema({ from: { type: "string", description: "Where the files came from, e.g. canvas." }, ref: { type: "string", description: "The file's id there, e.g. course/4411/file/9921, the same each time." } }),
    }, ["board", "key", "files"]),
    write: async (x, { req }) => {
      const b = boardOf(x.board);
      const files = (Array.isArray(x.files) ? x.files : []) as { name?: unknown; bytes?: unknown; sha256?: unknown }[];
      if (!files.length || files.length > 20) fail("files is a list of 1 to 20 files.");
      const origin = (x.origin ?? {}) as { from?: unknown; ref?: unknown };
      const from = origin.from ? String(origin.from).slice(0, 40) : null;
      const ref = origin.ref ? String(origin.ref).slice(0, 300) : null;
      const study = x.study === true ? 1 : 0;
      if (ref && files.length > 1) fail("origin.ref names one file; send files with a ref one at a time.");
      for (const f of files) {
        const name = String(f.name ?? "").trim();
        if (!name || name.length > 200 || !ACCEPTED.test(name)) fail(`"${name}": the name must end in .pdf, .md, .markdown, .txt, .html or .htm.`);
        if (!Number.isSafeInteger(f.bytes) || Number(f.bytes) <= 0 || Number(f.bytes) > MAX_UPLOAD_BYTES) fail(`"${name}": bytes must be the file's size, at most ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
        if (!/^[0-9a-f]{64}$/.test(String(f.sha256))) fail(`"${name}": sha256 is the file's SHA-256 in lowercase hex.`);
      }
      return () => {
        const lines = files.map((f) => {
        const name = String(f.name).trim(), sha = String(f.sha256);
        const prior = ref ? q.sourceOfRef.get(b.id, ref, "") : undefined;
        const revises = prior && prior.kind !== "pdf" && !/\.pdf$/i.test(name) ? prior.resource_id : null;
        if (revises && prior?.sha256 === sha) return `- ${name}: unchanged · already on ${b.ref} as ${idOf("source", revises)}`;
        const known = revises ? undefined : a.importBySha.get(b.id, sha);
        if (known?.resource_id && a.sourceOne.get(known.resource_id)) return `- ${name}: duplicate · already on ${b.ref} as ${idOf("source", known.resource_id)} · open: ${openLink(publicOrigin(req), b.id, known.resource_id)}`;
        if (known && known.stage !== "imported") {
          const link = known.stage === "uploading" ? ` · upload_url: ${uploadUrl(req, known.id).url}` : "";
          return `- ${name}: already uploading as ${idOf("import", known.id)} (${known.stage})${link}`;
        }
        const updated = !revises && ref && a.importByRef.get(b.id, ref) ? name.replace(/(\.[^.]+)$/, " (updated)$1") : name;
        const id = genId("agent-") + genId();
        imports.create(id, b.id, updated, Number(f.bytes));
        a.setImportOrigin.run(from, ref, sha, study, id);
        logEvent(db, APP, "agent_upload", { board: b.id, from, bytes: Number(f.bytes), revise: !!revises }, null);
        const link = uploadUrl(req, id);
        const cards = revises ? "replaces it in place, its highlights and cards kept" : study ? "flashcards: made as it arrives" : "flashcards: none (study: false; the reader can make them later)";
        return `- ${updated}: ${revises ? `revises ${idOf("source", revises)} · open: ${openLink(publicOrigin(req), b.id, revises)} · ` : ""}import ${idOf("import", id)} · upload_url: ${link.url} · method: PUT · expires ${new Date(link.expiresAt).toISOString()} · ${cards}`;
        });
        const put = lines.some((l) => l.includes("upload_url:")) ? `\n\nPUT each file's raw bytes to its upload_url (curl -sf -X PUT --data-binary @<file> "<upload_url>"), then check get_import.` : "";
        return lines.join("\n") + put;
      };
    },
  },
  {
    name: "get_import", title: "Upload progress", scope: "read",
    description: "How an upload is going: waiting for bytes, extracting, splitting, generating cards, done (with its src_ id) or failed (with why).",
    inputSchema: schema({ id: { type: "string", description: "The imp_… id from request_upload." } }, ["id"]),
    read: (x, { req }) => importContext(String(x.id ?? "").replace(/^imp_/, ""), publicOrigin(req)),
  },
  {
    name: "capture", title: "Capture a link", scope: "write",
    description: "Adds a web article, arXiv page or YouTube video (as its transcript, with title, channel and date; this can take a minute or two) to a board as a source, the same way the app's capture does, but without flashcards unless study is true. Not for local files (use request_upload).",
    inputSchema: schema({ board: BOARD, key: KEY, url: STR, study: STUDY }, ["board", "key", "url"]),
    write: async (x) => {
      const b = boardOf(x.board);
      const url = String(x.url ?? "").trim();
      if (!isHttpUrl(url)) fail("That doesn't look like a link.");
      const video = isYouTube(url);
      if (video && !FIRECRAWL_KEY) fail("This room has no Firecrawl key, so it can't read YouTube transcripts. Add the video from the app, which takes captions downloaded on your machine.");
      if (!captureAvailable) fail("This room has no article fetcher configured, so links can't be captured. Download the page and use request_upload.");
      const { prepared, filename, title } = await (video ? prepareVideo(url) : prepareArticle(url)).catch((e: Error) => fail(e instanceof NoTranscript
        ? "YouTube shows no transcript for this video. If it has captions, download them on your machine (yt-dlp) and add the video from the app."
        : `Couldn't fetch that ${video ? "video's transcript" : "page"}: ${e.message}`));
      prepared.input.study = x.study === true;
      return () => {
        const rid = writeSource(b.id, prepared, null);
        pairForResource(b.id, filename, rid);
        logEvent(db, APP, "capture_done", { board: b.id, kind: video ? "youtube" : "article", via: "agent" }, null);
        return `Captured "${title}" as ${idOf("source", rid)} on ${b.ref}. ${x.study === true ? "Flashcards are being made." : "No flashcards (study: false); the reader can make them later."}`;
      };
    },
  },
  {
    name: "apply", title: "Apply changes", scope: "write",
    description: `Adds or arranges things on a board, all together or not at all. Each op is one of the shapes in ops. Agents never delete for good (delete_deck sets a deck aside; the reader can put it back), never keep cards and never answer questions.`,
    inputSchema: schema({
      board: BOARD, key: KEY,
      ops: { type: "array", minItems: 1, maxItems: 50, items: { anyOf: OP_SCHEMAS } },
    }, ["board", "key", "ops"]),
    write: async (x) => {
      const b = boardOf(x.board);
      const ops = checkOps(x.ops);
      return () => `Applied ${ops.length} on ${b.ref}:\n${runOps(boardOf(b.id), ops, "agent")}`;
    },
  },
  {
    name: "create_board", title: "New board", scope: "write",
    description: "Makes a new board, optionally with a handle (a short name such as thesis) and a purpose.",
    inputSchema: schema({ key: KEY, title: STR, handle: { type: "string", pattern: HANDLE.source }, purpose: STR }, ["key", "title"]),
    write: async (x) => {
      const title = String(x.title ?? "").trim().slice(0, 200) || fail("A board needs a title.");
      const handle = x.handle === undefined ? null : String(x.handle);
      if (handle !== null && !HANDLE.test(handle)) fail("A handle is 2–40 lowercase letters, digits and dashes, starting with a letter.");
      return () => {
        if (handle && a.boardByHandle.get(handle)) fail(`The handle "${handle}" is taken.`);
        const id = insertBoard(title, "");
        if (handle) a.setHandle.run(handle, id);
        if (x.purpose) q.setBoardPurpose.run(String(x.purpose).trim().slice(0, 300), id);
        logEvent(db, APP, "board_create", { type: "blank", via: "agent" }, null);
        return `Made board ${handle ?? id} (${id}).`;
      };
    },
  },
  // The dashboard is its own app that borrows this MCP server, so it gets its own tools instead of apply ops.
  {
    name: "dashboard_add_items", title: "Add to the dashboard inbox", scope: "write",
    description: "Puts tasks in the dashboard's inbox; the reader sends each to the backlog or to-do, or drops it. A task is a title, a line or two of context, where it came from (from, with the words it came from as quote) and links to what already exists: Linear issues, GitHub PRs, Slack threads, Notion pages. The reader writes the notes themselves in Thinking, so don't draft a plan or a spec. Read dashboard_read first and don't add what is already there. All or nothing.",
    inputSchema: schema({ key: KEY, items: { type: "array", minItems: 1, maxItems: 50, items: DASH_ITEM } }, ["key", "items"]),
    write: async (x) => {
      if (!Array.isArray(x.items) || !x.items.length || x.items.length > 50) fail("items is a list of 1 to 50 items.");
      const items = dash(() => (x.items as unknown[]).map((it, i) => checkItem(it, `items[${i}]`)));
      return () => {
        const ids = addItems(items);
        logEvent(db, APP, "dashboard_add", { n: ids.length }, null);
        return `${ids.length} in the dashboard inbox: ${ids.join(", ")}. The reader keeps or drops each.`;
      };
    },
  },
  {
    name: "dashboard_read", title: "Read the dashboard", scope: "read",
    description: "Everything on the dashboard as Markdown: each thread with its notes and links, grouped by stage (Backlog, To-do with tomorrow morning's picks first, Thinking, Review), then the inbox. Pass task for one thread in full, stages to narrow, done_since to include finished and archived ones.",
    inputSchema: schema({
      task: { type: "string", description: "A thread's id or exact title: that thread in full." },
      stages: { type: "array", items: { type: "string", enum: [...DASH_STAGES] }, description: "Only these stages. Default: the four open ones." },
      done_since: { type: "string", description: "A date, e.g. 2026-10-20: also show threads done or dropped since then." },
      area: { type: "string", enum: ["work", "personal"], description: "Only that backlog's threads. Default: both." },
      cursor: CURSOR, max_tokens: MAX,
    }),
    read: (x) => renderDashboard(x, budgetOf(x.max_tokens)),
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
