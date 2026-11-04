import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../support/server.ts";

test("a pre-split DB migrates its bytes out of the resources table, losing none of them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strata-legacy-"));
  const LEGACY = join(dir, "legacy.db");

  const pdf = Buffer.from(Array.from({ length: 9000 }, (_, i) => (i * 7) % 256));
  const pages = ["page one text", "page two text"];
  {
    const old = new DatabaseSync(LEGACY);
    old.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE resources (
        id TEXT NOT NULL, board_id TEXT NOT NULL, filename TEXT, mime TEXT, data TEXT, text TEXT,
        created_at INTEGER NOT NULL, tokens INTEGER, included INTEGER NOT NULL DEFAULT 1,
        kind TEXT, origin_url TEXT, page_text TEXT, PRIMARY KEY (board_id, id));
      CREATE TABLE card_keeps (id TEXT PRIMARY KEY, course TEXT NOT NULL, deck TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    // (card_keeps as it was before the register read it by date: no index on created_at)
    old.prepare("INSERT INTO boards VALUES (?,?,?,?)").run("b-old", "an old board", null, Date.now());
    old.prepare("INSERT INTO resources (id,board_id,filename,mime,data,text,created_at,tokens,included,kind,origin_url,page_text) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)")
      .run("res-old", "b-old", "book.pdf", "application/pdf", pdf.toString("base64"), null, Date.now(), 1234, "pdf", null, JSON.stringify(pages));
    old.prepare("INSERT INTO resources (id,board_id,filename,mime,data,text,created_at,tokens,included,kind,origin_url,page_text) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)")
      .run("res-txt", "b-old", "notes.md", "text/plain", null, "# notes\n\nbody", Date.now(), 7, "text", null, null);
    old.close();
  }

  try {
    const srv = await startServer({ db: LEGACY, env: { STRATA_MIN_SECTION_WORDS: undefined } })
      .catch((e: Error) => assert.fail(`the server has to come up on a legacy DB, not fall over on it: ${e.message}`));
    try {
      const raw = await srv.fetch("/api/boards/b-old/resources/res-old/raw");
      assert.equal(raw.status, 200);
      assert.deepEqual(Buffer.from(await raw.arrayBuffer()), pdf, "the migrated PDF is the PDF");

      const part = await srv.fetch("/api/boards/b-old/resources/res-old/raw", { headers: { Range: "bytes=100-199" } });
      assert.equal(part.status, 206);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), pdf.subarray(100, 200));

      assert.equal(await (await srv.fetch("/api/boards/b-old/resources/res-txt/raw")).text(), "# notes\n\nbody");

      const state = await (await srv.fetch("/api/boards/b-old")).json();
      assert.equal(state.resources.length, 2);
      assert.equal(state.resources.find((r: { id: string }) => r.id === "res-old").tokens, 1234);
    } catch (e) {
      process.stderr.write(`\n── server output ──\n${srv.output()}\n── end of server output ──\n`);
      throw e;
    } finally {
      await srv.stop();   // waits for the process to close, so its handle on the file is gone
    }

    const after = new DatabaseSync(LEGACY, { readOnly: true });
    const cols = (after.prepare("PRAGMA table_info(resources)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.includes("data"), "the data column is dropped once every byte is across");
    assert.ok(!cols.includes("page_text"), "and so is page_text");
    const blob = after.prepare("SELECT bytes, page_text FROM resource_blobs WHERE resource_id = ?").get("res-old") as { bytes: Uint8Array; page_text: string };
    assert.deepEqual(Buffer.from(blob.bytes), pdf);
    assert.deepEqual(JSON.parse(blob.page_text), pages);
    assert.equal((after.prepare("SELECT count(*) n FROM resource_blobs").get() as { n: number }).n, 1);
    assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_card_keeps_created'").get(),
      "an older card_keeps gets the register's date index on boot");
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
