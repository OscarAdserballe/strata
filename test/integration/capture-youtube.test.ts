// A YouTube link captured through a fake Firecrawl: the room never reaches the real network here.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/firecrawl/${name}.json`, import.meta.url), "utf8");
const asked: { auth?: string; body: { url: string; actions?: unknown[] } }[] = [];
const firecrawl = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    asked.push({ auth: req.headers.authorization, body });
    if (req.url !== "/v1/scrape") { res.writeHead(404).end(); return; }
    if (/broken/.test(body.url)) { res.writeHead(500).end("{}"); return; }
    res.writeHead(200, { "Content-Type": "application/json" })
      .end(fixture(/no-captions/.test(body.url) ? "youtube-no-transcript" : "youtube-transcript"));
  });
});
await new Promise<void>((resolve) => firecrawl.listen(0, "127.0.0.1", resolve));
after(() => { firecrawl.close(); });

const server = useServer({ env: {
  FIRECRAWL_API_KEY: "fake-firecrawl-key",
  FIRECRAWL_API_URL: `http://127.0.0.1:${(firecrawl.address() as AddressInfo).port}`,
} });

const rows = (sql: string, ...args: string[]) => {
  const db = new DatabaseSync(server.db, { timeout: 5000 });
  try { return db.prepare(sql).all(...args) as Record<string, unknown>[]; } finally { db.close(); }
};
const capture = (board: string, url: string, key: string) => server.fetch(`/api/boards/${board}/capture`, {
  method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ url }),
});

test("a youtube link with a transcript lands as a transcript source, once per key", async () => {
  const board = await newBoard(server, { title: "Talks" });
  const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  const r = await capture(board, url, "yt-capture-key-1");
  const body = await r.json();
  assert.equal(r.status, 201, JSON.stringify(body));
  assert.equal(body.kind, "transcript");
  assert.equal(body.title, "Me at the zoo");
  assert.ok(body.state.resources.some((x: { id: string }) => x.id === body.resourceId));

  const sent = asked.at(-1)!;
  assert.equal(sent.auth, "Bearer fake-firecrawl-key");
  assert.equal(sent.body.url, url);
  assert.ok(sent.body.actions?.length, "without an action Firecrawl returns no transcript");

  const [src] = rows("SELECT kind, origin_url, text FROM resources WHERE board_id = ?", board);
  assert.equal(src.kind, "transcript");
  assert.equal(src.origin_url, url);
  assert.match(String(src.text), /^# Me at the zoo\n\n\*jawed · 2005-04-24 · https:\/\/www\.youtube\.com\/watch\?v=jNQXAC9IVRw\*\n\nAll right, so here we are/);

  const calls = asked.length;
  const again = await capture(board, url, "yt-capture-key-1");
  assert.equal(again.headers.get("Idempotent-Replay"), "true");
  assert.equal((await again.json()).resourceId, body.resourceId);
  assert.equal(asked.length, calls, "a replay does not fetch again");
  assert.equal(rows("SELECT id FROM resources WHERE board_id = ?", board).length, 1);
});

test("a video without a transcript hands back the caption step with the reason, and writes nothing", async () => {
  const board = await newBoard(server, { title: "Silent films" });
  const url = "https://www.youtube.com/watch?v=no-captions";
  const r = await capture(board, url, "yt-capture-key-2");
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.kind, "youtube");
  assert.equal(body.title, "Me at the zoo", "the scrape's own title, not a second fetch");
  assert.equal(body.author, "jawed");
  assert.match(body.why, /no transcript/);
  assert.match(body.ytDlpCommands.macos, /yt-dlp/);
  assert.match(body.ytDlpCommands.windows, /yt-dlp/);
  assert.equal(rows("SELECT id FROM resources WHERE board_id = ?", board).length, 0);
  assert.equal(rows("SELECT key FROM request_receipts WHERE key = ?", "yt-capture-key-2").length, 0, "a retry asks again");
});

let n = 0;
async function tool(token: string, args: Record<string, unknown>) {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: "capture", arguments: args } }) });
  const { result } = await r.json();
  return { text: result.content[0].text as string, isError: !!result.isError };
}

test("an agent captures a youtube link unstudied, and is told plainly when there is no transcript", async () => {
  const board = await newBoard(server, { title: "Agent talks" });
  const { token } = (await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: "writer", write: true }) })).body;
  const ok = await tool(token, { board, key: "agent-yt-1", url: "https://youtu.be/jNQXAC9IVRw" });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /Captured "Me at the zoo" as src_\S+ .*No flashcards/);
  const [src] = rows("SELECT id, kind FROM resources WHERE board_id = ?", board);
  assert.equal(src.kind, "transcript");
  assert.deepEqual(rows("SELECT status FROM trees WHERE resource_id = ?", String(src.id)).map((t) => t.status), ["unstudied"]);

  const none = await tool(token, { board, key: "agent-yt-2", url: "https://www.youtube.com/watch?v=no-captions" });
  assert.equal(none.isError, true);
  assert.match(none.text, /no transcript for this video.*yt-dlp/);
  const broken = await tool(token, { board, key: "agent-yt-3", url: "https://www.youtube.com/watch?v=broken" });
  assert.equal(broken.isError, true);
  assert.match(broken.text, /Couldn't fetch that video's transcript: Firecrawl HTTP 500/);
  assert.equal(rows("SELECT id FROM resources WHERE board_id = ?", board).length, 1);
});
