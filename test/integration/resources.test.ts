import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";
import { MD, newBoard, addMarkdown } from "./seed.ts";

let boardId = "";
let resourceId = "";

const server = useServer({ seed: async (s) => {
  boardId = await newBoard(s, { question: "How does duration hedging actually fail?" });
  resourceId = await addMarkdown(s, boardId, "tuckman-ch4.md", MD);
} });
const api = (path: string, init?: RequestInit) => server.api(path, init);
const mine = (state: { resources: { id: string }[] }) => state.resources.find((x) => x.id === resourceId) as Record<string, any>;

test("prose covers use bounded previews without counting as reads or truncating the source", async () => {
  const { body: created } = await api("/api/boards",{method:"POST",body:JSON.stringify({title:"Preview fixture"})});
  const id = created.board.id;
  try {
    const text = "# Cover title\n\nOpening sentence.\n" + "A long source. ".repeat(20000).trimEnd();
    const { status: uploaded, body: resource } = await api(`/api/boards/${id}/resources`,{method:"POST",body:JSON.stringify({filename:"Cover.txt",text})});
    assert.equal(uploaded,201,JSON.stringify(resource));
    const {status,body:preview} = await api(`/api/boards/${id}/resources/${resource.id}/preview`);
    assert.equal(status,200);
    assert.deepEqual(preview.lines.slice(0,2),["Cover title","Opening sentence."]);
    assert.ok(JSON.stringify(preview).length < 1100);
    assert.equal((await api(`/api/boards/wrong-board/resources/${resource.id}/preview`)).status,404);
    const connection = new DatabaseSync(server.db,{readOnly:true});
    try {
      assert.equal(connection.prepare("SELECT COUNT(*) n FROM events WHERE event='resource_view' AND json_extract(props,'$.resource')=?").get(resource.id)!.n,0);
    } finally { connection.close(); }
    const raw = await fetch(`${server.base}/api/boards/${id}/resources/${resource.id}/raw`);
    assert.equal(await raw.text(),text);
  } finally { await api(`/api/boards/${id}`,{method:"DELETE"}); }
});

test("add a markdown resource → on the shelf, in the budget", async () => {
  // a board of its own, so "the only source on the shelf" is a fact whatever else has run
  const id = await newBoard(server, { question: "How does duration hedging actually fail?" });
  try {
    const b64 = Buffer.from(MD, "utf-8").toString("base64");
    const { status, body } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "tuckman-ch4.md", base64: b64 }) });
    assert.equal(status, 201);
    assert.equal(body.state.resources.length, 1);
    assert.equal(body.state.resources[0].id, body.id);
    assert.equal(body.state.resources[0].filename, "tuckman-ch4.md");
    assert.equal(body.state.resources[0].kind, "text");
    assert.equal(body.state.resources[0].included, true);
    assert.ok(body.state.budget.usedTokens > 0);
  } finally { await api(`/api/boards/${id}`, { method: "DELETE" }); }
});

test("mark a resource done, and take it back", async () => {
  let r = await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify({ done: true }) });
  assert.equal(r.status, 200);
  let row = r.body.state.resources.find((x: { id: string }) => x.id === resourceId);
  assert.equal(typeof row.doneAt, "number");
  assert.equal(typeof row.createdAt, "number");
  assert.equal(row.lastReadAt, null, "never opened → no last-read time");
  r = await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify({ done: false }) });
  assert.equal(r.status, 200);
  row = r.body.state.resources.find((x: { id: string }) => x.id === resourceId);
  assert.equal(row.doneAt, null);
});

test("raw serves the resource text for the reader", async () => {
  const r = await fetch(`${server.base}/api/boards/${boardId}/resources/${resourceId}/raw`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), MD);
});

test("raw is cacheable, revalidates to a 304, and says how long it is", async () => {
  const url = `${server.base}/api/boards/${boardId}/resources/${resourceId}/raw`;
  const r = await fetch(url);
  assert.match(r.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.equal(r.headers.get("content-length"), String(Buffer.byteLength(MD, "utf-8")));
  const tag = r.headers.get("etag");
  assert.ok(tag, "an etag, so a cache that revalidates gets a cheap answer");

  const again = await fetch(url, { headers: { "If-None-Match": tag! } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
});

test("raw serves a byte range, so a big book opens at the page you are on", async () => {
  const url = `${server.base}/api/boards/${boardId}/resources/${resourceId}/raw`;
  const r = await fetch(url, { headers: { Range: "bytes=0-9" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 0-9/${Buffer.byteLength(MD, "utf-8")}`);
  assert.equal(await r.text(), MD.slice(0, 10));

  const tail = await fetch(url, { headers: { Range: "bytes=-4" } });
  assert.equal(tail.status, 206);
  assert.equal(await tail.text(), MD.slice(-4));

  const daft = await fetch(url, { headers: { Range: "bytes=999999-1000000" } });
  assert.equal(daft.status, 416);
});

test("a pdf comes back byte-for-byte, whole or in slices", async () => {
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  const { body: made } = await api(`/api/boards/${boardId}/resources`, {
    method: "POST",
    body: JSON.stringify({ filename: "slices.pdf", base64: bytes.toString("base64") }),
  });
  const url = `${server.base}/api/boards/${boardId}/resources/${made.id}/raw`;

  const whole = Buffer.from(await (await fetch(url)).arrayBuffer());
  assert.deepEqual(whole, bytes, "the file that comes back is the file that went in");

  const mid = await fetch(url, { headers: { Range: "bytes=1000-1999" } });
  assert.equal(mid.status, 206);
  assert.deepEqual(Buffer.from(await mid.arrayBuffer()), bytes.subarray(1000, 2000));

  await api(`/api/boards/${boardId}/resources/${made.id}`, { method: "DELETE" });
});

// A non-ASCII name must not reach the header raw: it travels RFC 6266-style, with filename*.
test("a pdf whose name has an em dash in it still serves", async () => {
  const bytes = Buffer.from("%PDF-1.4\nnamed for real");
  const { body: made } = await api(`/api/boards/${boardId}/resources`, {
    method: "POST",
    body: JSON.stringify({ filename: "How to Read a Book — Adler & Van Doren.pdf", base64: bytes.toString("base64") }),
  });
  const r = await fetch(`${server.base}/api/boards/${boardId}/resources/${made.id}/raw`);
  assert.equal(r.status, 200);
  const cd = r.headers.get("content-disposition") ?? "";
  assert.ok(/^inline; filename="[\x20-\x7e]*"; /.test(cd), `the fallback name must be plain ASCII, got: ${cd}`);
  assert.ok(cd.includes("filename*=UTF-8''How%20to%20Read%20a%20Book%20%E2%80%94%20Adler%20%26%20Van%20Doren.pdf"), `the real name must arrive encoded, got: ${cd}`);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
  await api(`/api/boards/${boardId}/resources/${made.id}`, { method: "DELETE" });
});

// Guards against a `SELECT *` creeping back into resourcesOf and pulling the bytes into the board state.
test("board state carries a source's metadata and none of its bytes", async () => {
  const bytes = Buffer.from("%PDF-1.4\n" + "x".repeat(4000));
  const { body: made } = await api(`/api/boards/${boardId}/resources`, {
    method: "POST",
    body: JSON.stringify({ filename: "heavy.pdf", base64: bytes.toString("base64") }),
  });
  const { body } = await api(`/api/boards/${boardId}`);
  const row = body.resources.find((x: { id: string }) => x.id === made.id);
  assert.equal(row.filename, "heavy.pdf");
  assert.equal(row.kind, "pdf");
  const asText = JSON.stringify(body);
  assert.ok(!asText.includes(bytes.toString("base64").slice(0, 64)), "the file must not ride the board state");
  assert.ok(!("data" in row) && !("pageText" in row), "and no field pretends to carry it");

  const raw = await fetch(`${server.base}/api/boards/${boardId}/resources/${made.id}/raw`);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), bytes);
  await api(`/api/boards/${boardId}/resources/${made.id}`, { method: "DELETE" });
  assert.equal((await fetch(`${server.base}/api/boards/${boardId}/resources/${made.id}/raw`)).status, 404);
});

test("read markers: unread until opened, opened by the raw fetch, read after a deep scroll", async () => {
  const aside = await api(`/api/boards/${boardId}/resources`, { method: "POST", body: JSON.stringify({ filename: "aside.md", base64: Buffer.from("# aside", "utf-8").toString("base64") }) });
  let { body } = await api(`/api/boards/${boardId}`);
  const by = (id: string) => body.resources.find((x: { id: string }) => x.id === id);
  assert.equal(by(aside.body.id).read, "unread");
  assert.equal((await fetch(`${server.base}/api/boards/${boardId}/resources/${resourceId}/raw`)).status, 200);
  ({ body } = await api(`/api/boards/${boardId}`));
  assert.equal(by(resourceId).read, "opened");
  await api("/api/log", { method: "POST", body: JSON.stringify({ event: "read_progress", props: { board: boardId, resource: resourceId, kind: "text", pct: 97, deepest: 97, ms: 30000 } }) });
  ({ body } = await api(`/api/boards/${boardId}`));
  assert.equal(by(resourceId).read, "read");
  assert.equal(by(resourceId).readPct, 97);
  assert.ok(by(resourceId).readMs >= 30000);
  await api(`/api/boards/${boardId}/resources/${aside.body.id}`, { method: "DELETE" });
});

test("toggle a resource out of context → budget drops to zero, it stays on the shelf", async () => {
  const { body: was } = await api(`/api/boards/${boardId}`);
  assert.ok(mine(was).included && mine(was).tokens > 0, "in context, and it costs tokens");
  const { status, body } = await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify({ included: false }) });
  assert.equal(status, 200);
  assert.ok(mine(body.state), "still on the shelf");
  assert.equal(mine(body.state).included, false);
  // measured relative to before, so a source another test failed to remove cannot fail this one too
  assert.equal(body.state.budget.usedTokens, was.budget.usedTokens - mine(was).tokens);
  if (!body.state.resources.some((r: { included: boolean }) => r.included)) assert.equal(body.state.budget.usedTokens, 0);
  await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify({ included: true }) });
});

test("retitle a resource → the shelf name changes and nothing else does", async () => {
  await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify({ included: false }) });
  const { status, body } = await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify({ filename: "  How Does\nUnderstanding  Work? " }) });
  assert.equal(status, 200);
  assert.equal(mine(body.state).filename, "How Does Understanding Work?");
  assert.equal(mine(body.state).included, false, "a rename must not quietly put it back in context");
  const empty = await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify({ filename: "   " }) });
  assert.equal(empty.status, 400);
  await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "PATCH", body: JSON.stringify({ included: true, filename: "tuckman-ch4.md" }) });
});

test("retitling a source carries the page that was named after it — and only that one", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "retitle" }) });
  const id = made.board.id;
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "Ultralearning", text: "# essay\n\nbody" }) });
  const { body: copied } = await api(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify({ label: "Ultralearning", resourceId: res.id }) });
  await api(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify({ label: "week 3 — comprehension", resourceId: res.id }) });

  const { body } = await api(`/api/boards/${id}/resources/${res.id}`, { method: "PATCH", body: JSON.stringify({ filename: "How Does Understanding Work?" }) });
  const label = (pid: string) => body.state.pairs.find((p: { id: string }) => p.id === pid).label;
  assert.equal(label(copied.id), "How Does Understanding Work?");
  assert.equal(body.state.pairs.filter((p: { label: string }) => p.label === "week 3 — comprehension").length, 1, "a page you named is yours");
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("a rename with pair: true names the source's one pair too, in the same answer", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "sole pair" }) });
  const id = made.board.id;
  const { body: res } = await api(`/api/boards/${id}/resources`, { method: "POST", body: JSON.stringify({ filename: "lecture-3.md", text: "# notes\n\nbody" }) });
  const { body: pair } = await api(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify({ label: "lecture-3", resourceId: res.id }) });
  const { status, body } = await api(`/api/boards/${id}/resources/${res.id}`, { method: "PATCH", body: JSON.stringify({ filename: "Lecture 3: markets", pair: true }) });
  assert.equal(status, 200);
  const labelIn = (state: { pairs: { id: string; label: string }[] }, pid: string) => state.pairs.find((p) => p.id === pid)?.label;
  assert.equal(labelIn(body.state, pair.id), "Lecture 3: markets");
  assert.equal(body.state.resources.find((r: { id: string }) => r.id === res.id).filename, "Lecture 3: markets");
  const { body: plain } = await api(`/api/boards/${id}/resources/${res.id}`, { method: "PATCH", body: JSON.stringify({ filename: "Lecture three" }) });
  assert.equal(labelIn(plain.state, pair.id), "Lecture three", "the copied label follows by the old rule");
  await api(`/api/boards/${id}/pairs/${pair.id}`, { method: "PATCH", body: JSON.stringify({ label: "my page" }) });
  const { body: kept } = await api(`/api/boards/${id}/resources/${res.id}`, { method: "PATCH", body: JSON.stringify({ filename: "Lecture 3" }) });
  assert.equal(labelIn(kept.state, pair.id), "my page", "a page you named is yours without the flag");
  const { body: two } = await api(`/api/boards/${id}/pairs`, { method: "POST", body: JSON.stringify({ label: "week 3 reading", resourceId: res.id }) });
  const { body: after } = await api(`/api/boards/${id}/resources/${res.id}`, { method: "PATCH", body: JSON.stringify({ filename: "Lecture 3, again", pair: true }) });
  assert.equal(labelIn(after.state, two.id), "week 3 reading", "a source on two pages keeps each page's own name");
  assert.equal(labelIn(after.state, pair.id), "my page");
  await api(`/api/boards/${id}`, { method: "DELETE" });
});

test("remove a resource", async () => {
  const { status, body } = await api(`/api/boards/${boardId}/resources/${resourceId}`, { method: "DELETE" });
  assert.equal(status, 200);
  assert.equal(mine(body.state), undefined, "gone from the shelf");
  assert.equal((await fetch(`${server.base}/api/boards/${boardId}/resources/${resourceId}/raw`)).status, 404, "and its bytes with it");
});

test("pagetext answers the upload-time extraction, and [] where there is none", async () => {
  const { body: made } = await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "pagetext" }) });
  const id = made.board.id;
  const pages = ["alpha page one", "beta page two"];
  const { body: res } = await api(`/api/boards/${id}/resources`, {
    method: "POST",
    body: JSON.stringify({ filename: "book.pdf", kind: "pdf", text: pages.join(" "), pageText: pages }),
  });
  const { status, body } = await api(`/api/boards/${id}/resources/${res.id}/pagetext`);
  assert.equal(status, 200);
  assert.deepEqual(body.pages, pages, "the pages come back exactly as they were stored");

  const { body: prose } = await api(`/api/boards/${id}/resources`, {
    method: "POST",
    body: JSON.stringify({ filename: "essay.md", text: "# essay\n\nbody" }),
  });
  const bare = await api(`/api/boards/${id}/resources/${prose.id}/pagetext`);
  assert.equal(bare.status, 200);
  assert.deepEqual(bare.body.pages, [], "no extraction answers an honest empty");

  assert.equal((await api(`/api/boards/${id}/resources/nope/pagetext`)).status, 404);
  await api(`/api/boards/${id}`, { method: "DELETE" });
});
