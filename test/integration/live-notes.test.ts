// Comment threads on live pages became notes with replies: the move happens once at boot, and an agent reads
// the reader's notes on its pages from <board>/comments and answers under them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type TestServer } from "../support/server.ts";
import { noteOfThread } from "../../shared/reading/notes.ts";

const PAGE = `<!doctype html><html><body><h1>Decisions</h1><section data-strata-id="S3"><h2>Tree granularity</h2><p>One sample per window.</p></section><script>1</script></body></html>`;
const json = (method: string, body?: unknown) => ({ method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });

async function tool(srv: TestServer, token: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = await srv.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await r.json();
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}

test("comment threads become notes with replies at boot, drafts included, and the threads' tables go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-comments-"));
  const DB = join(dir, "room.db");
  try {
    let srv = await startServer({ db: DB });
    const board = (await srv.api("/api/boards", json("POST", { title: "Comments, then" }))).body.board.id as string;
    const rid = (await srv.api(`/api/boards/${board}/resources`, json("POST", { filename: "decisions.html", base64: Buffer.from(PAGE).toString("base64") }))).body.id as string;
    await srv.stop();

    // an older room: its threads' tables, as they were
    const db = new DatabaseSync(DB);
    db.exec(`CREATE TABLE comments (id TEXT NOT NULL, board_id TEXT NOT NULL, resource_id TEXT NOT NULL, anchor TEXT NOT NULL,
      quote TEXT NOT NULL, start_off INTEGER NOT NULL DEFAULT 0, end_off INTEGER NOT NULL DEFAULT 0, box TEXT,
      resolved_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (board_id, id));
    CREATE TABLE comment_messages (id TEXT NOT NULL, board_id TEXT NOT NULL, comment_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      author TEXT NOT NULL, text TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, sent_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (board_id, id));`);
    const thread = db.prepare("INSERT INTO comments (id,board_id,resource_id,anchor,quote,start_off,end_off,box,resolved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    const said = db.prepare("INSERT INTO comment_messages (id,board_id,comment_id,resource_id,author,text,generation,sent_at,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?,?)");
    thread.run("ct-words", board, rid, "words", "One sample per window.", 30, 52, null, null, 1, 3);
    said.run("cm-1", board, "ct-words", rid, "you", "Why per window?", 2, 1, 1);
    said.run("cm-2", board, "ct-words", rid, "agent", "Windows are what the recorder ships.", 3, 2, 2);
    said.run("cm-3", board, "ct-words", rid, "you", "Fine, keep it.", 4, 3, 3);
    thread.run("ct-box", board, rid, "box", "Tree granularity", 0, 0, "S3", 9, 5, 5);
    said.run("cm-4", board, "ct-box", rid, "you", "A draft never sent back.", null, 5, 5);
    db.close();

    srv = await startServer({ db: DB });
    try {
      const { body: st } = await srv.api(`/api/boards/${board}`);
      const words = st.marks.find((m: { id: string }) => m.id === noteOfThread("ct-words"));
      assert.equal(words.note, "Why per window?");
      assert.equal(words.quote, "One sample per window.");
      assert.deepEqual(words.replies.map((r: { author: string; text: string }) => `${r.author}: ${r.text}`), ["agent: Windows are what the recorder ships.", "you: Fine, keep it."]);
      const box = st.marks.find((m: { id: string }) => m.id === noteOfThread("ct-box"));
      assert.deepEqual({ note: box.note, box: box.box, replies: box.replies.length }, { note: "A draft never sent back.", box: "S3", replies: 0 }, "a draft is a note, sent");
      const left = new DatabaseSync(DB);
      assert.equal((left.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('comments','comment_messages')").get() as { n: number }).n, 0, "the threads' tables are gone");
      left.close();
      await srv.stop();
      srv = await startServer({ db: DB });
      assert.equal((await srv.api(`/api/boards/${board}`)).body.marks.length, 2, "booting again changes nothing");

      const token = (await srv.api("/api/agent/tokens", json("POST", { name: "pages", write: true }))).body.token as string;
      const waiting = await tool(srv, token, "get_context", { id: `${board}/comments`, filter: { state: "with_agent" } });
      assert.match(waiting.text, /reply_note/);
      assert.match(waiting.text, new RegExp(`hl_${noteOfThread("ct-words")} · with agent`));
      assert.match(waiting.text, /box \[data-strata-id="S3"\]/);
      const old = await tool(srv, token, "get_context", { id: "cm_ct-words" });
      assert.match(old.text, /Why per window\?/, "an old comment id still names the note it became");
      const answered = await tool(srv, token, "apply", { board, key: "live-note-1", ops: [{ op: "reply_note", id: `hl_${noteOfThread("ct-box")}`, text: "Drafted the per-tree cut." }] });
      assert.equal(answered.isError, false, answered.text);
      const turn = await tool(srv, token, "get_context", { id: `${board}/comments`, filter: { state: "your_turn" } });
      assert.match(turn.text, /Drafted the per-tree cut\./);
    } finally { await srv.stop(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a note can sit on a page's labelled box", async () => {
  const srv = await startServer();
  try {
    const board = (await srv.api("/api/boards", json("POST", { title: "Boxes" }))).body.board.id as string;
    const rid = (await srv.api(`/api/boards/${board}/resources`, json("POST", { filename: "decisions.html", base64: Buffer.from(PAGE).toString("base64") }))).body.id as string;
    const made = await srv.api(`/api/boards/${board}/marks`, json("POST", { resourceId: rid, start: 0, end: 0, quote: "Tree granularity", box: "S3", note: "this whole box" }));
    assert.equal(made.status, 201);
    assert.equal(made.body.mark.box, "S3");
    const odd = await srv.api(`/api/boards/${board}/marks`, json("POST", { resourceId: rid, start: 0, end: 0, quote: "x", box: "no spaces allowed" }));
    assert.equal(odd.body.mark.box, null, "a box id the page couldn't have written is dropped");
  } finally { await srv.stop(); }
});
