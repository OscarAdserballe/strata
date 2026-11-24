import type { BoardState } from "../../shared/types/index.ts";

// What works offline, in one table. Download saves the reads marked saved, a refused write and the banner say
// what the writes' rows say, and test/offline-coverage.test.ts fails when a server route has no row here.

/** What a Download needs to know to name every URL a read could ask for. */
export interface Room { board: string; state: BoardState; since: number }

type Saved = { path: string; offline: "saved"; urls(r: Room): string[] };
type Live = { path: string; offline: "live"; why: string };
export type ReadRow = Saved | Live;

const enc = encodeURIComponent;
const decksOf = (r: Room): string[] => [...new Set((r.state.pairs || []).map((p) => p.deck).filter((d): d is string => !!d))];
const each = (r: Room) => r.state.resources || [];
const at = (r: Room, rid: string) => `/api/boards/${r.board}/resources/${rid}`;
const gen = (g?: number) => (g ? `?v=${g}` : "");
const once = (path: string) => () => [path];
const board = (tail: string) => (r: Room) => [`/api/boards/${r.board}${tail}`];
const perDeck = (tail: string) => (r: Room) => decksOf(r).map((d) => `/api/decks/${d}${tail}`);

/** `:name` is one path segment, a trailing `*` the rest of the path. */
export const READS: ReadRow[] = [
  { path: "/api/register", offline: "saved", urls: once("/api/register") },
  { path: "/api/boards", offline: "saved", urls: once("/api/boards") },
  { path: "/api/decks", offline: "saved", urls: once("/api/decks") },
  { path: "/api/review", offline: "saved", urls: once("/api/review") },
  // `since` is the reader's midnight; the worker answers another day's from this copy (sw.js anyQuery)
  { path: "/api/review/session", offline: "saved", urls: (r) => [`/api/review/session?since=${r.since}`] },
  { path: "/api/review/tree", offline: "saved", urls: (r) => decksOf(r).map((d) => `/api/review/tree?course=${enc(d)}`) },
  { path: "/api/collection", offline: "saved", urls: once("/api/collection") },
  { path: "/api/library", offline: "saved", urls: once("/api/library") },
  { path: "/api/library/questions", offline: "saved", urls: once("/api/library/questions") },
  { path: "/api/boards/:board", offline: "saved", urls: board("") },
  { path: "/api/boards/:board/touched", offline: "saved", urls: board("/touched") },
  { path: "/api/boards/:board/seen", offline: "saved", urls: board("/seen") },
  { path: "/api/boards/:board/collection", offline: "saved", urls: board("/collection") },
  { path: "/api/boards/:board/minted", offline: "saved", urls: board("/minted") },
  {
    path: "/api/boards/:board/messages", offline: "saved",
    urls: (r) => [`/api/boards/${r.board}/messages?`, ...each(r).map((s) => `/api/boards/${r.board}/messages?resource=${enc(s.id)}`)],
  },
  // both URLs: the prose reader asks with ?v=<generation>, pdf.js and the download without
  { path: "/api/boards/:board/resources/:rid/raw", offline: "saved", urls: (r) => each(r).flatMap((s) => [`${at(r, s.id)}/raw`, ...(s.generation ? [`${at(r, s.id)}/raw${gen(s.generation)}`] : [])]) },
  { path: "/api/boards/:board/resources/:rid/live", offline: "saved", urls: (r) => each(r).filter((s) => s.kind === "html").map((s) => `${at(r, s.id)}/live${gen(s.generation)}`) },
  { path: "/api/boards/:board/resources/:rid/state", offline: "saved", urls: (r) => each(r).filter((s) => s.kind === "html").map((s) => `${at(r, s.id)}/state`) },
  { path: "/api/boards/:board/resources/:rid/preview", offline: "saved", urls: (r) => each(r).filter((s) => s.kind !== "pdf").map((s) => `${at(r, s.id)}/preview`) },
  { path: "/api/boards/:board/resources/:rid/pagetext", offline: "saved", urls: (r) => each(r).filter((s) => s.kind === "pdf").map((s) => `${at(r, s.id)}/pagetext`) },
  {
    path: "/api/boards/:board/resources/:rid/tree", offline: "saved",
    urls: (r) => [...each(r).map((s) => `${at(r, s.id)}/tree`), ...(r.state.sections || []).map((s) => `${at(r, s.resourceId)}/tree?section=${enc(s.id)}`)],
  },
  { path: "/api/decks/:deck", offline: "saved", urls: perDeck("") },
  { path: "/api/decks/:deck/keeps", offline: "saved", urls: perDeck("/keeps") },
  { path: "/api/decks/:deck/ignored", offline: "saved", urls: perDeck("/ignored") },
  // named by its hash; Download finds each one in the text of the sources it saves (imagesIn)
  { path: "/api/images/:hash", offline: "saved", urls: () => [] },

  { path: "/api/boards/:board/status", offline: "live", why: "it asks whether a job is running on the server" },
  { path: "/api/boards/:board/resources/:rid/sections", offline: "live", why: "only the section editor reads it, and editing sections needs a connection" },
  { path: "/api/review/history", offline: "live", why: "one read per card; the panel says it needs a connection" },
  { path: "/api/review/chat", offline: "live", why: "one thread per card; asking needs the model anyway" },
  { path: "/api/health", offline: "live", why: "it is how the room tells the wire is up" },
  { path: "/api/feedback", offline: "live", why: "the feedback list is the server's" },
  { path: "/api/agent/tokens", offline: "live", why: "tokens are made and revoked on the server" },
  { path: "/api/imports*", offline: "live", why: "an import runs on the server" },
  { path: "/api/dashboard*", offline: "live", why: "the dashboard is a separate app; offline its page says it needs a connection" },
  { path: "/mcp", offline: "live", why: "agents reach the server, not this device" },
];

/** A write while the wire is down: waits on this device and is sent on reconnect, or needs a connection. */
export interface WriteRow { route: string; offline: "waits" | "live"; what: string }

// `what` is said in "<what> needs a connection" and in the banner's list of what waits.
export const WRITES: WriteRow[] = [
  { route: "POST /api/review/grade", offline: "waits", what: "grades" },
  { route: "POST /api/boards/:board/marks", offline: "waits", what: "marks" },
  { route: "PATCH /api/boards/:board/marks/:id", offline: "waits", what: "notes on marks" },
  { route: "POST /api/boards/:board/marks/:id/replies", offline: "waits", what: "replies" },
  { route: "DELETE /api/boards/:board/marks/:id", offline: "waits", what: "removing a mark" },
  { route: "POST /api/decks/:deck/keeps", offline: "waits", what: "keeps" },
  { route: "POST /api/decks/:deck/keeps/minted", offline: "waits", what: "keeps" },
  { route: "PUT /api/boards/:board/notes", offline: "waits", what: "board notes" },

  { route: "POST /api/boards/:board/minted", offline: "waits", what: "cards" },
  { route: "PATCH /api/boards/:board/minted/:id", offline: "waits", what: "cards" },
  { route: "DELETE /api/boards/:board/minted/:id", offline: "live", what: "deleting a card" },
  { route: "POST /api/boards/:board/minted/file", offline: "live", what: "filing cards" },
  { route: "POST /api/library/cards", offline: "waits", what: "cards" },
  { route: "PATCH /api/decks/:deck/cards/:id", offline: "waits", what: "cards" },
  { route: "DELETE /api/decks/:deck/cards/:id", offline: "live", what: "deleting a card" },
  { route: "POST /api/decks/:deck/cards/:id/restore", offline: "live", what: "putting a card back" },
  { route: "POST /api/decks/:deck/ignore", offline: "live", what: "setting a deck aside" },
  { route: "POST /api/decks/:deck/restore", offline: "live", what: "putting a deck back" },
  { route: "PUT /api/boards/:board/resources/:rid/state", offline: "waits", what: "interactive pages" },
  { route: "PUT /api/boards/:board/plan/*", offline: "live", what: "the plan" },
  { route: "POST /api/boards/:board/plan/*", offline: "live", what: "the plan" },
  { route: "PATCH /api/boards/:board/plan/*", offline: "live", what: "the plan" },
  { route: "DELETE /api/boards/:board/plan/*", offline: "live", what: "the plan" },
  { route: "POST /api/boards/:board/chat", offline: "live", what: "asking" },
  { route: "POST /api/review/chat", offline: "live", what: "asking" },
  { route: "DELETE /api/review/chat", offline: "live", what: "clearing a conversation" },
  { route: "DELETE /api/boards/:board/messages", offline: "live", what: "clearing a conversation" },
  { route: "POST /api/boards", offline: "live", what: "making a board" },
  { route: "PATCH /api/boards/:board", offline: "live", what: "renaming" },
  { route: "DELETE /api/boards/:board", offline: "live", what: "deleting" },
  { route: "POST /api/boards/:board/resources", offline: "live", what: "adding a source" },
  { route: "PATCH /api/boards/:board/resources/:rid", offline: "live", what: "renaming or filing a source" },
  { route: "DELETE /api/boards/:board/resources/:rid", offline: "live", what: "deleting" },
  { route: "PUT /api/boards/:board/resources/:rid/sections", offline: "live", what: "editing sections" },
  { route: "PUT /api/boards/:board/resources/:rid/tree", offline: "live", what: "saving a tree" },
  { route: "POST /api/boards/:board/resources/:rid/distil", offline: "live", what: "making cards" },
  { route: "POST /api/boards/:board/resources/:rid/primer", offline: "live", what: "asking for a primer" },
  { route: "POST /api/boards/:board/pairs", offline: "live", what: "pairing a deck" },
  { route: "PATCH /api/boards/:board/pairs/:id", offline: "live", what: "pairing a deck" },
  { route: "DELETE /api/boards/:board/pairs/:id", offline: "live", what: "pairing a deck" },
  { route: "POST /api/boards/:board/pairs/:id/move", offline: "live", what: "moving a deck" },
  { route: "POST /api/boards/:board/capture", offline: "live", what: "capturing a link" },
  { route: "POST /api/boards/:board/capture/finish", offline: "live", what: "capturing a link" },
  { route: "POST /api/boards/:board/plan/draft", offline: "live", what: "drafting a plan" },
  { route: "POST /api/cards/tidy", offline: "live", what: "tidying a card" },
  { route: "POST /api/images", offline: "live", what: "uploading an image" },
  { route: "POST /api/register/inbox", offline: "live", what: "filing" },
  { route: "POST /api/feedback", offline: "live", what: "feedback" },
  { route: "PATCH /api/feedback/:id", offline: "live", what: "feedback" },
  { route: "POST /api/agent/tokens", offline: "live", what: "agent tokens" },
  { route: "DELETE /api/agent/tokens/:id", offline: "live", what: "agent tokens" },
  { route: "POST /api/imports*", offline: "live", what: "importing" },
  { route: "DELETE /api/imports*", offline: "live", what: "importing" },
  { route: "PUT /api/imports*", offline: "live", what: "importing" },
  { route: "POST /api/dashboard*", offline: "live", what: "the dashboard" },
  { route: "PUT /api/dashboard*", offline: "live", what: "the dashboard" },
  { route: "PATCH /api/dashboard*", offline: "live", what: "the dashboard" },
  { route: "DELETE /api/dashboard*", offline: "live", what: "the dashboard" },
  { route: "POST /api/log", offline: "live", what: "logging" },
  { route: "POST /api/perf", offline: "live", what: "logging" },
  { route: "POST /api/login", offline: "live", what: "signing in" },
  { route: "POST /api/logout", offline: "live", what: "signing out" },
  { route: "PUT /api/agent/v1/upload/:id", offline: "live", what: "agent uploads" },
  { route: "POST /mcp", offline: "live", what: "agents" },
  { route: "DELETE /mcp", offline: "live", what: "agents" },
];

const pattern = (path: string) =>
  new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-z]+/g, "[^/]+").replace(/\*/g, ".*")}$`);
const reads = READS.map((row) => ({ row, re: pattern(row.path) }));
const writes = WRITES.map((row) => { const [method, path] = row.route.split(" "); return { row, method, re: pattern(path) }; });
const bare = (path: string) => path.split("?")[0].replace(/^.*?(?=\/api\/|\/mcp)/, "");

/** The row that answers for this read (query and mount ignored), if any. */
export const readRow = (path: string): ReadRow | undefined => reads.find((c) => c.re.test(bare(path)))?.row;
/** The row that answers for this write, if any. */
export const writeRow = (method: string, path: string): WriteRow | undefined =>
  writes.find((c) => c.method === method.toUpperCase() && c.re.test(bare(path)))?.row;

/** "grades, marks and keeps": the writes that wait, for the banner. */
export function waitingKinds(): string {
  const what = [...new Set(WRITES.filter((w) => w.offline === "waits" && !/^(removing|replies|notes on)/.test(w.what)).map((w) => w.what))];
  return what.length < 2 ? what.join("") : `${what.slice(0, -1).join(", ")} and ${what[what.length - 1]}`;
}

/** What a write refused offline says: "editing a card needs a connection". */
export function needsWire(method: string, path: string): string {
  const row = writeRow(method, path);
  return `${row ? row.what : "this"} needs a connection`;
}

/** Every URL a Download of this board saves: the rows marked saved. */
export function savedUrls(r: Room): string[] {
  const out = new Set<string>();
  for (const row of READS) if (row.offline === "saved") for (const u of row.urls(r)) out.add(u);
  return [...out];
}

/** The image URLs a source's text names; their bytes are saved beside the source. */
export const imagesIn = (text: string): string[] => [...new Set(Array.from(text.matchAll(/\/api\/images\/([0-9a-f]{16})\b/g), (m) => `/api/images/${m[1]}`))];
