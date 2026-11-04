// Requests run twice: the second round must prepare no statement (only LAZY ones may appear in the first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_DIR, useServer } from "../support/server.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const preload = pathToFileURL(join(APP_DIR, "test", "support", "count-prepares.mjs")).href;
const server = useServer({ env: { NODE_OPTIONS: `--import=${preload}` } });

// prepared on first use: the grade's statements, the projections', and the router's receipt store
const LAZY = [/^server\/features\/review\/routes\.ts:/, /^server\/platform\/projections\.ts:/,
  /^server\/platform\/db\/receipts\.ts:/];

const prepared = (from: number) => server.output(from).split("\n")
  .filter((l) => l.startsWith("[prepare] ")).map((l) => l.slice("[prepare] ".length));

test("the boot prepared its statements, and the room's hot requests prepare none per call", async () => {
  assert.ok(prepared(0).length > 50, "the preload sees the boot's statements (repo.ts modules prepare at import)");
  const board = await newBoard(server, { title: "prepared once" });
  const rid = await addMarkdown(server, board, "a.md", MD);
  const { body: decks } = await server.api("/api/decks");
  const deck = decks.decks[0].slug as string;
  const { body: one } = await server.api(`/api/decks/${deck}`);
  const card = one.cards[0].id as string;
  // The import is finished before the rounds: the pump that finishes it still prepares per call.
  const text = Buffer.from("# Imported\n\nA finished import, so the polled list reads its resource.\n");
  const made = await server.api("/api/imports", { method: "POST",
    body: JSON.stringify({ id: "prepared-import-1", board, filename: "imported.md", size: text.length }) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sent = await server.fetch("/api/imports/prepared-import-1/bytes?offset=0", { method: "PUT", body: text });
  assert.equal(sent.status, 200, await sent.text());
  const done = await server.api("/api/imports/prepared-import-1/complete", { method: "POST" });
  assert.equal(done.status, 202, JSON.stringify(done.body));
  for (const end = Date.now() + 60_000; ; await new Promise((r) => setTimeout(r, 50))) {
    const { body } = await server.api("/api/imports/prepared-import-1");
    const row = body.import;
    if (row.stage === "imported" && row.resource_id && row.generation && !row.generation.busy) break;
    assert.notEqual(row.stage, "error", row.error);
    assert.ok(Date.now() < end, `the import did not settle: ${JSON.stringify(row)}`);
  }
  const upload = await server.api("/api/imports", { method: "POST",
    body: JSON.stringify({ id: "prepared-upload-1", board, filename: "book.pdf", size: 1000 }) });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const { body: polled } = await server.api("/api/imports");
  assert.ok(polled.imports.some((r: { id: string; generation?: unknown }) => r.id === "prepared-import-1" && r.generation),
    "the polled list answers the finished import with its generation, read through statusOf");

  let n = 0;
  // keyed writes, as the client sends them: only a keyed write reaches the receipt store
  const keyed = (what: string) => ({ "Content-Type": "application/json", "Idempotency-Key": `prepared-${n}-${what}` });
  const round = async () => {
    n++;
    for (const path of ["/api/boards", "/api/register", "/api/library", "/api/decks", `/api/boards/${board}`,
      `/api/boards/${board}/status`, `/api/boards/${board}/touched`, `/api/boards/${board}/seen`,
      `/api/boards/${board}/messages`, `/api/boards/${board}/resources/${rid}/raw`,
      `/api/boards/${board}/resources/${rid}/tree`, `/api/decks/${deck}`, `/api/decks/${deck}/keeps`, "/api/review", "/api/imports"]) {
      const r = await server.fetch(path);
      await r.arrayBuffer();
      assert.ok(r.status < 500, `${path} answered ${r.status}`);
    }
    const mark = await server.api(`/api/boards/${board}/marks`, { method: "POST", headers: keyed("mark-post"),
      body: JSON.stringify({ resourceId: rid, start: 2, end: 10, quote: MD.slice(2, 10) }) });
    assert.equal(mark.status, 201, JSON.stringify(mark.body));
    const id = mark.body.id as string;
    const said = await server.api(`/api/boards/${board}/marks/${id}`, { method: "PATCH", headers: keyed("mark-patch"), body: JSON.stringify({ note: "said" }) });
    assert.ok(said.status < 300, JSON.stringify(said.body));
    const gone = await server.api(`/api/boards/${board}/marks/${id}`, { method: "DELETE", headers: keyed("mark-delete") });
    assert.ok(gone.status < 300, JSON.stringify(gone.body));
    const grade = await server.api("/api/review/grade", { method: "POST", headers: keyed("grade"),
      body: JSON.stringify({ requestId: `prepared-once-${n}`, course: deck, card, got: true, surface: "drill", board }) });
    assert.equal(grade.status, 200, JSON.stringify(grade.body));
  };

  const first = server.written();
  await round();
  const second = server.written();
  assert.equal(prepared(first).filter((p) => p.startsWith("server/platform/db/receipts.ts:") && p.includes("request_receipts")).length, 3,
    "the keyed writes reached the router's receipt store, and it prepared its three statements");
  const lazily = prepared(first).filter((p) => !LAZY.some((re) => re.test(p)));
  assert.deepEqual(lazily, [], "prepared after boot, outside the statements that say they wait for first use");
  await round();
  assert.deepEqual(prepared(second), [], "the second round prepared statements: one is prepared per call");
});
