// The MCP surface end to end: the three journeys it exists for, and the rules it must keep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { useServer } from "../support/server.ts";
import { addMarkdown, MD, newBoard } from "./seed.ts";

const server = useServer();
const DECKS = ["aio-lecture-1", "aio-lecture-3", "aio-lecture-4", "aio-lecture-5", "aio-lecture-6", "aio-lecture-7", "csharp-async"];
let token = "", reader = "", board = "", rid = "";
let n = 0;

const mint = async (write: boolean) => (await server.api("/api/agent/tokens", { method: "POST", body: JSON.stringify({ name: write ? "writer" : "reader", write }) })).body as { id: string; token: string };
const rpc = async (method: string, params?: unknown, as = token) => {
  const r = await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
};
async function call(name: string, args: Record<string, unknown> = {}, as = token): Promise<{ text: string; isError: boolean }> {
  const { body } = await rpc("tools/call", { name, arguments: args }, as);
  assert.ok(body.result, `${name} answered ${JSON.stringify(body)}`);
  return { text: body.result.content[0].text as string, isError: !!body.result.isError };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  assert.equal(r.isError, false, `${name}: ${r.text}`);
  return r.text;
};
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail("timed out"); };

test("a room is seeded the way the app would leave it", async () => {
  token = (await mint(true)).token;
  reader = (await mint(false)).token;
  board = await newBoard(server, { title: "Master's thesis" });
  rid = await addMarkdown(server, board, "lost-in-the-middle.md", MD);
  for (const deck of DECKS) {
    const p = await server.api(`/api/boards/${board}/pairs`, { method: "POST", body: JSON.stringify({ label: deck, resourceId: rid, deck }) });
    assert.ok(p.status < 300, JSON.stringify(p.body));
    const cards = (await server.api(`/api/decks/${deck}`)).body.cards as { id: string }[];
    await server.api(`/api/decks/${deck}/keeps`, { method: "POST", body: JSON.stringify({ add: cards.map((c) => c.id) }) });
  }
  await ok("apply", { board, key: "seed-handle-1", ops: [{ op: "set_handle", handle: "thesis" }] });
});

test("it refuses anyone without a live token, and a read-only token cannot write", async () => {
  assert.equal((await rpc("tools/list", {}, "")).status, 401);
  assert.equal((await rpc("tools/list", {}, "stk_notarealtokennotarealtoken")).status, 401);
  const w = await call("apply", { board: "thesis", key: "reader-try-1", ops: [{ op: "append_log", text: "x" }] }, reader);
  assert.ok(w.isError && /only read/.test(w.text));
  const gone = await mint(false);
  await server.api(`/api/agent/tokens/${gone.id}`, { method: "DELETE" });
  assert.equal((await rpc("tools/list", {}, gone.token)).status, 401, "a revoked token stops working at once");
});

test("it speaks MCP: initialize, the twelve tools, notifications", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc("initialize", { protocolVersion: "1999-01-01" })).body.result.protocolVersion, "2025-11-25", "an unknown version gets our newest");
  assert.equal((await server.fetch("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status, 202);
  const tools = (await rpc("tools/list")).body.result.tools as { name: string; inputSchema: { required?: string[] } }[];
  // Changing this list changes every connected agent's tools: it changes on purpose or not at all.
  assert.deepEqual(tools.map((t) => `${t.name}(${(t.inputSchema.required ?? []).join(",")})`), [
    "whoami()", "get_outline()", "get_context(id)", "get_text(id)", "search(queries)", "get_changes(board)", "get_guide()",
    "request_upload(board,key,files)", "get_import(id)", "capture(board,key,url)", "apply(board,key,ops)", "create_board(key,title)", "dashboard_add_items(key,items)", "dashboard_read()",
    "dashboard_board()", "dashboard_open(id)", "dashboard_post(key,id)",
  ]);
  assert.equal((await rpc("no/such")).body.error.code, -32601);
});

test("journey: the last cards I reviewed", async () => {
  const cards = (await server.api(`/api/decks/${DECKS[2]}`)).body.cards as { id: string }[];
  for (const [i, got] of [true, false, true].entries()) {
    const g = await server.api("/api/review/grade", { method: "POST", body: JSON.stringify({ requestId: `grade-test-${i}000`, course: DECKS[2], card: cards[i].id, got }) });
    assert.equal(g.status, 200);
  }
  const text = await ok("get_changes", { board: "thesis", kinds: ["reviewed"], limit: 2 });
  assert.match(text, /\*\*got\*\*/);
  assert.equal(text.match(/card_/g)?.length, 2, "limit is honoured");
  assert.match(text, /more: get_changes/);
  const card = await ok("get_context", { id: `card_${cards[1].id}` });
  assert.match(card, /missed/);
  assert.match(card, /kept \d{4}-/);
});

test("journey: everything on the board, page by page, reaches every kept card exactly once", async () => {
  const outline = await ok("get_outline", { board: "thesis" });
  const kept = Number(/thesis\/kept — (\d+) card/.exec(outline)?.[1]);
  assert.ok(kept >= 6, outline);
  const seen: string[] = [];
  let args: Record<string, unknown> | null = { id: "thesis/kept", max_tokens: 500 };
  let pages = 0;
  for (; args; pages++) {
    assert.ok(pages < 100);
    const text = await ok("get_context", args);
    seen.push(...[...text.matchAll(/^ {2}card_(\S+)/gm)].map((m) => m[1]));
    const next = /cursor: "(o\d+)"/.exec(text)?.[1];
    args = next ? { id: "thesis/kept", max_tokens: 500, cursor: next } : null;
  }
  assert.ok(pages > 1, `the budget should force several pages, got ${pages}`);
  assert.equal(seen.length, kept);
  assert.equal(new Set(seen).size, kept);
  for (const id of ["thesis", "thesis/log", "thesis/plan", "thesis/questions", "thesis/highlights", "thesis/sources", `src_${rid}`]) await ok("get_context", { id });
  assert.match(await ok("get_text", { id: `src_${rid}` }), /DV01/);
});

test("journey: upload a file, then the same file again", async () => {
  const bytes = Buffer.from("# Lecture 7\n\nRe-ranking comes after retrieval, and costs a second model pass.\n");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const file = { name: "lecture-07.md", bytes: bytes.length, sha256: sha };
  const asked = await ok("request_upload", { board: "thesis", key: "upload-test-1", files: [file], origin: { from: "canvas", ref: "course/1/file/7" } });
  const url = new URL(/upload_url: (\S+)/.exec(asked)![1]);
  const imp = /import (imp_\S+)/.exec(asked)![1];
  const put = (body: Buffer, sig = url.searchParams.get("sig")!) => server.fetch(`${url.pathname}?exp=${url.searchParams.get("exp")}&sig=${sig}`, { method: "PUT", body: new Uint8Array(body) });

  assert.equal((await put(bytes, "forged")).status, 403);
  assert.equal((await put(Buffer.from(bytes.toString().toUpperCase()))).status, 400, "bytes that don't match the hash are refused");
  assert.equal((await put(bytes)).status, 200);
  assert.equal((await put(bytes)).status, 409, "a link works once");
  await until(async () => /imported/.test(await ok("get_import", { id: imp })));
  const done = await ok("get_import", { id: imp });
  const src = /source: (src_\S+)/.exec(done)![1];
  assert.match(done, new RegExp(`open: https?://\\S+/\\?board=\\S+&resource=${src.slice(4)}\\b`), "the finished upload carries a link to open the page");
  assert.match(await ok("get_context", { id: src }), /pushed from canvas \(course\/1\/file\/7\)/);
  assert.match(await ok("get_context", { id: src }), /\nopen: https?:\/\/\S+\?board=/);

  const again = await ok("request_upload", { board: "thesis", key: "upload-test-2", files: [file] });
  assert.match(again, new RegExp(`duplicate · already on thesis as ${src}`));
  assert.doesNotMatch(again, /upload_url/);
});

test("journey: a new board by its handle, then a page uploaded to it", async () => {
  assert.match(await ok("create_board", { key: "explore-board", title: "Explorations", handle: "explorations" }), /Made board explorations/);
  const bytes = Buffer.from(`<!doctype html><html><head><title>Atlas</title><script>window.x = 1</script></head>
<body><h1>Card atlas</h1><p>Every card on the board, grouped by idea.</p><input type="range"></body></html>`);
  const file = { name: "card-atlas.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const asked = await ok("request_upload", { board: "explorations", key: "explore-upload", files: [file], origin: { from: "claude", ref: "card-atlas" } });
  const url = new URL(/upload_url: (\S+)/.exec(asked)![1]);
  const imp = /import (imp_\S+)/.exec(asked)![1];
  assert.equal((await server.fetch(`${url.pathname}${url.search}`, { method: "PUT", body: new Uint8Array(bytes) })).status, 200);
  await until(async () => /imported/.test(await ok("get_import", { id: imp })));
  const src = /source: (src_\S+)/.exec(await ok("get_import", { id: imp }))![1];
  assert.match(await ok("get_context", { id: src }), new RegExp(`${src} on explorations · html ·`));
  assert.match(await ok("get_text", { id: src }), /grouped by idea/);
});

test("journey: a page is revised in place under its ref, and is not studied until asked", async () => {
  const page = (body: string) => Buffer.from(`<!doctype html><html><head><script>window.v = 1</script></head><body>${body}</body></html>`);
  const send = async (bytes: Buffer, key: string) => {
    const file = { name: "retrieval-map.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const asked = await ok("request_upload", { board: "explorations", key, files: [file], origin: { from: "claude", ref: "retrieval-map" } });
    const link = /upload_url: (\S+)/.exec(asked);
    if (link) {
      const url = new URL(link[1]);
      assert.equal((await server.fetch(`${url.pathname}${url.search}`, { method: "PUT", body: new Uint8Array(bytes) })).status, 200);
      const imp = /import (imp_\S+)/.exec(asked)![1];
      await until(async () => /imported/.test(await ok("get_import", { id: imp })));
    }
    return asked;
  };
  const asked = await send(page("<h1>Retrieval map</h1><p>Dense retrieval misses rare names.</p>"), "revise-page-1");
  assert.match(asked, /flashcards: none \(study: false; the reader can make them later\)/, "the reply says no cards are coming");
  const first = await ok("get_outline", { board: "explorations" });
  assert.match(first, /"retrieval-map" · 1 section · html · not studied, no flashcards/);
  const board2 = /^id: (\S+)/m.exec(first)![1];
  const src = /(src_\S+) "retrieval-map"/.exec(first)![1];
  const rid2 = src.replace(/^src_/, "");
  const tree = await server.api(`/api/boards/${board2}/resources/${rid2}/tree`);
  assert.equal(tree.body.status, "unstudied", "an agent's page is not carded on arrival");
  const mark = await server.api(`/api/boards/${board2}/marks`, { method: "POST", body: JSON.stringify({ resourceId: rid2, quote: "rare names" }) });
  assert.ok(mark.status < 300, JSON.stringify(mark.body));

  const second = await send(page("<h1>Retrieval map</h1><p>Dense retrieval misses rare names; BM25 catches them.</p>"), "revise-page-2");
  assert.match(second, new RegExp(`revises ${src}`));
  assert.doesNotMatch(second, /\(updated\)/);
  assert.match(second, /replaces it in place, its highlights and cards kept/);
  const outline = await ok("get_outline", { board: "explorations" });
  assert.equal(outline.match(/retrieval-map/g)?.length, 1, "a revision replaces its source rather than adding one");
  assert.match(await ok("get_text", { id: src }), /BM25 catches them/);
  assert.match(await (await server.fetch(`/api/boards/${board2}/resources/${rid2}/live`)).text(), /BM25 catches them/);
  assert.match(await ok("get_context", { id: `${board2}/highlights` }), /rare names/, "the reader's highlight stays");
  assert.match(await send(page("<h1>Retrieval map</h1><p>Dense retrieval misses rare names; BM25 catches them.</p>"), "revise-page-3"), new RegExp(`unchanged · already on explorations as ${src}`));

  const generate = await server.api(`/api/boards/${board2}/resources/${rid2}/distil`, { method: "POST" });
  assert.ok(generate.status === 202 || generate.status === 409, JSON.stringify(generate.body));
});

test("apply is all or nothing, and a resent key writes once", async () => {
  const batch = { board: "thesis", key: "apply-test-0001", ops: [{ op: "add_group", name: "RQ2" }, { op: "place", id: `src_${rid}`, group: "RQ2" }, { op: "append_log", text: "Grouped the first source." }, { op: "add_question", front: "Why does recall dip mid-context?" }] };
  const first = await ok("apply", batch);
  assert.equal(await ok("apply", batch), first, "the same key replays the first answer");
  const log = await ok("get_context", { id: "thesis/log" });
  assert.equal(log.match(/Grouped the first source/g)?.length, 1);
  const reused = await call("apply", { ...batch, ops: [{ op: "append_log", text: "different" }] });
  assert.ok(reused.isError && /already used/.test(reused.text));

  const broken = await call("apply", { board: "thesis", key: "apply-test-0002", ops: [{ op: "append_log", text: "must not land" }, { op: "place", id: `src_${rid}`, group: "No such group" }] });
  assert.ok(broken.isError && /Nothing was written/.test(broken.text));
  assert.doesNotMatch(await ok("get_context", { id: "thesis/log" }), /must not land/);
  assert.match(await ok("get_context", { id: "thesis/plan" }), /\*\*RQ2\*\*\n {2}- src_/);
  assert.match(await ok("get_context", { id: "thesis/questions", filter: { state: "open" } }), /recall dip/);
  assert.ok((await call("apply", { board: "thesis", key: "apply-test-0003", ops: [{ op: "delete_board" }] })).isError, "there is no op that deletes");
});

test("journey: an agent replaces a section's cards with its own, then sets the deck aside, and the reader can put it back", async () => {
  const up = await server.api(`/api/boards/${board}/resources`, { method: "POST", body: JSON.stringify({ filename: "decks.md", base64: Buffer.from(MD).toString("base64"), pair: true }) });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const src = `src_${up.body.id}`;
  const tree = { title: "Recall", question: "What does a DV01-neutral hedge leave exposed?",
    glossary: [{ term: "DV01", kernel: "The price change for a one basis point move in yield." }],
    nodes: [{ label: "A DV01-neutral hedge covers small parallel shifts and fails on convexity", kind: "synthesis", at: "A DV01-neutral hedge protects only against small",
      questions: ["Where in a long context does recall dip?"],
      children: [{ label: "Convexity is where the hedge fails", kind: "boundary", at: "Convexity is the failure mode", questions: ["What does the U-shape mean?"] }] }] };
  const term = { front: "What is DV01?", back: "The price change for one basis point.", at: "DV01-neutral hedge protects only", node: "n1", introduces: "DV01" };
  const dipCard = { front: "Where in a long context does recall dip?", back: "In the middle.", at: "A DV01-neutral hedge protects only against small", node: "n1", asks: ["n1#1"] };
  const shape = { front: "What does the U-shape mean?", back: "Start and end are recalled best.", at: "Convexity is the failure mode", node: "n1.1", asks: ["n1.1#1"], uses: ["DV01"] };
  const add = (key: string, body: object) => call("apply", { board: "thesis", key, ops: [{ op: "add_deck", section: src, ...body }] });
  const bare = await add("deck-add-000a", { cards: [dipCard, shape, term] });
  assert.ok(bare.isError && /has no concept tree yet, so send one with the deck as tree/.test(bare.text), bare.text);
  const rootless = await add("deck-add-000b", { tree: { ...tree, nodes: [{ ...tree.nodes[0], kind: "concept" }] }, cards: [dipCard, shape, term] });
  assert.ok(rootless.isError && /does not fit its tree:\ntree: it has exactly one top-level node, of kind synthesis/.test(rootless.text), rootless.text);
  const thin = await add("deck-add-000c", { tree, cards: [dipCard, { ...shape, node: "n9", asks: ["n1#1"] }] });
  assert.ok(thin.isError && /cards\[1\]: n9 is not a node of the tree/.test(thin.text) && /cards\[1\]: n1#1 is not a question of the tree, or another card already answers it/.test(thin.text)
    && /no card answers n1\.1#1/.test(thin.text) && /no card introduces DV01/.test(thin.text), thin.text);
  const adrift = await add("deck-add-000d", { tree: { ...tree, nodes: [{ ...tree.nodes[0], at: "a hedge protects against everything" }] }, cards: [dipCard, term] });
  assert.ok(adrift.isError && /tree node n1: the quote .* is not in the source verbatim/.test(adrift.text), adrift.text);
  const unplaced = await add("deck-add-0000", { tree, cards: [{ ...dipCard, at: "a hedge protects against everything" }, shape, term] });
  assert.ok(unplaced.isError && /did not compile:\ncards\[0\]: the quote .* is not in the source verbatim/.test(unplaced.text), unplaced.text);
  const made = await ok("apply", { board: "thesis", key: "deck-add-0001", ops: [{ op: "add_deck", section: src, tree, cards: [dipCard, shape, term] }] });
  const deck = /(deck_[a-z0-9-]+)/.exec(made)?.[1];
  assert.ok(deck, made);
  const slug = deck.replace(/^deck_/, "");
  const cards = (await server.api(`/api/decks/${slug}`)).body.cards as { id: string; front: string; node: string; asks: string[]; introduces: string }[];
  assert.deepEqual(cards.map((c) => c.front), ["What is DV01?", "Where in a long context does recall dip?", "What does the U-shape mean?"], "the definition card leads, as in a generated deck");
  assert.deepEqual(cards.map((c) => [c.node, c.asks, c.introduces]), [["n1", [], "DV01"], ["n1", ["n1#1"], ""], ["n1.1", ["n1.1#1"], ""]]);
  const stored = (await server.api(`/api/boards/${board}/resources/${up.body.id}/tree`)).body;
  assert.equal(stored.tree.nodes[0].children[0].anchor, 'quote: "Convexity is the failure mode"');
  assert.match(await ok("get_context", { id: src }), /## Concept tree[\s\S]*vocabulary \(1\)[\s\S]*└─ Convexity is where the hedge fails/);
  assert.match(await ok("get_context", { id: deck }), /recall dip[\s\S]*at "A DV01-neutral hedge protects only against small" · compiles/);
  const dip = cards[1].id;
  await server.api(`/api/decks/${slug}/keeps`, { method: "POST", body: JSON.stringify({ add: [dip] }) });

  await ok("apply", { board: "thesis", key: "deck-add-0002", ops: [{ op: "add_deck", section: src, cards: [
    { ...dipCard, back: "In the middle, worst near the centre." },
    { front: "Why does position matter at all?", back: "Attention favours the ends.", at: "small, parallel shifts. Convexity is", node: "n1.1", asks: ["n1.1#1"] },
    term,
  ] }] });
  const again = (await server.api(`/api/decks/${slug}`)).body.cards as { id: string; front: string; back: string }[];
  assert.deepEqual(again.map((c) => c.front), ["What is DV01?", "Where in a long context does recall dip?", "Why does position matter at all?"], "the new deck replaces the old, on the tree the section already has");
  assert.equal(again[1].id, dip, "an unchanged front is the same card");
  assert.match(again[1].back, /worst near the centre/);
  assert.ok(((await server.api(`/api/decks/${slug}/keeps`)).body.ids as string[]).includes(dip), "and keeps its keep");

  // a card moves to other words and is rewritten in place: same card, same keep; a quote that doesn't compile writes nothing
  const bad = await call("apply", { board: "thesis", key: "card-edit-0001", ops: [{ op: "edit_cards", cards: [
    { id: `card_${dip}`, at: "Convexity is the failure mode" }, { id: `card_${again[2].id}`, at: "parallel shifts" },
  ] }] });
  assert.ok(bad.isError && /1 of 2 cards did not compile:\ncards\[1\]: .* is 2 words/.test(bad.text) && /Nothing was written/.test(bad.text), bad.text);
  assert.match(await ok("get_context", { id: `card_${dip}` }), /at: "A DV01-neutral hedge protects only against small" · compiles/, "a failed batch moved nothing");
  await ok("apply", { board: "thesis", key: "card-edit-0002", ops: [{ op: "edit_cards", cards: [
    { id: `card_${dip}`, at: "Convexity is the failure mode", back: "In the middle, worst at the centre." },
  ] }] });
  const moved = (await server.api(`/api/decks/${slug}`)).body.cards as { id: string; back: string; source: string }[];
  assert.equal(moved[1].id, dip, "the same card");
  assert.equal(moved[1].source, 'quote: "Convexity is the failure mode"');
  assert.match(moved[1].back, /worst at the centre/);
  assert.ok(((await server.api(`/api/decks/${slug}/keeps`)).body.ids as string[]).includes(dip), "still kept");
  const stranger = await call("apply", { board: "thesis", key: "card-edit-0003", ops: [{ op: "edit_cards", cards: [{ id: "card_nope/flashcard/x", at: "Convexity is the failure mode" }] }] });
  assert.ok(stranger.isError && /is not a card on thesis/.test(stranger.text), stranger.text);

  const wrong = await call("apply", { board: "thesis", key: "deck-add-0003", ops: [{ op: "add_deck", section: "src_nope", cards: [{ front: "a", back: "b", at: "Convexity is the failure mode", node: "n1" }] }] });
  assert.ok(wrong.isError && /not a section or source/.test(wrong.text), wrong.text);

  assert.match(await ok("apply", { board: "thesis", key: "deck-del-0001", ops: [{ op: "delete_deck", id: deck }] }), /set aside 3 cards/);
  assert.deepEqual((await server.api(`/api/decks/${slug}`)).body.cards, []);
  const back = await server.api(`/api/decks/${slug}/restore`, { method: "POST", body: "{}" });
  assert.equal(back.body.cards, 3, "the reader puts it back");
  assert.ok(((await server.api(`/api/decks/${slug}/keeps`)).body.ids as string[]).includes(dip), "keep and all");
  const notOurs = await call("apply", { board: "thesis", key: "deck-del-0002", ops: [{ op: "delete_deck", id: "deck_csharp-nope" }] });
  assert.ok(notOurs.isError && /not a deck on/.test(notOurs.text), notOurs.text);
});

test("journey: upload an HTML page, and it opens live", async () => {
  const bytes = Buffer.from(`<!DOCTYPE html><html><head><title>Chapter 3</title></head><body><h1>Instrumental variables</h1>
<p>An instrument moves the treatment and nothing else.</p><canvas id="c"></canvas><script>document.getElementById("c").width = 200;</script></body></html>`);
  const file = { name: "chapter-3.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const asked = await ok("request_upload", { board: "thesis", key: "upload-html-1", files: [file] });
  const url = new URL(/upload_url: (\S+)/.exec(asked)![1]);
  const imp = /import (imp_\S+)/.exec(asked)![1];
  assert.equal((await server.fetch(`${url.pathname}${url.search}`, { method: "PUT", body: new Uint8Array(bytes) })).status, 200);
  await until(async () => /imported/.test(await ok("get_import", { id: imp })));
  const src = /source: src_(\S+)/.exec(await ok("get_import", { id: imp }))![1];
  assert.match(await ok("get_context", { id: `src_${src}` }), /^# chapter-3\n.* · html · /m);
  assert.match(await ok("get_text", { id: `src_${src}` }), /An instrument moves the treatment/);
  const live = await server.fetch(`/api/boards/${board}/resources/${src}/live`);
  assert.equal(live.status, 200);
  assert.match(live.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
  const refused = await call("request_upload", { board: "thesis", key: "upload-html-2", files: [{ ...file, name: "chapter-3.docx" }] });
  assert.ok(refused.isError && /\.html or \.htm/.test(refused.text));
});

test("journey: the reader's chats with the model, cleared turns included", async () => {
  const chatLine = async () => /thesis\/chat — (\d+) messages? with the board's model(?: \((\d+) cleared\))?/.exec(await ok("get_outline", { board: "thesis" }))!;
  const before = await chatLine();
  const say = (message: string) => server.api(`/api/boards/${board}/chat`, { method: "POST", body: JSON.stringify({ message }) });
  assert.equal((await say("Why does recall dip in the middle of a long context?")).status, 200);
  assert.equal((await server.api(`/api/boards/${board}/messages`, { method: "DELETE" })).status, 200);
  assert.equal((await say("What is re-ranking for?")).status, 200);
  const card = ((await server.api(`/api/decks/${DECKS[2]}`)).body.cards as { id: string }[])[0].id;
  const asked = await server.fetch("/api/review/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ course: DECKS[2], card, message: "Explain this card simply" }) });
  assert.equal(asked.status, 200);
  await asked.text();

  const after = await chatLine();
  assert.equal(Number(after[1]), Number(before[1]) + 6, "two board turns and one card turn, two messages each");
  assert.equal(Number(after[2]), Number(before[1]) + 2, "the clear archived everything before it");
  const chat = await ok("get_context", { id: "thesis/chat" });
  assert.match(chat, /\*\*you\*\* · on card_\S+\n {2}Explain this card simply/, "a card's thread is part of the board's chat");
  assert.match(chat, /\*\*you\*\* · board chat\n {2}What is re-ranking for\?/);
  assert.match(chat, /\*\*you\*\* · board chat · cleared\n {2}Why does recall dip/, "a cleared turn is still there, marked");
  assert.ok(chat.indexOf("Explain this card") < chat.indexOf("re-ranking for") && chat.indexOf("re-ranking for") < chat.indexOf("recall dip"), "newest first");
  assert.match(await ok("get_context", { id: "thesis/chat", filter: { since: "2999-01-01" } }), /No chat matches/);
  const found = await ok("search", { board: "thesis", queries: [{ kind: "chat", query: "re-ranking" }] });
  assert.match(found, /1 match\n- \d{4}-\d\d-\d\d · you: What is re-ranking for\? · board chat · thesis\/chat/);
});

test("apply's schema names every op's fields, so no guide read is needed first", async () => {
  const tools = (await rpc("tools/list")).body.result.tools as { name: string; inputSchema: { properties: { ops: { items: { anyOf: { properties: Record<string, unknown>; required: string[] }[] } } } } }[];
  const shapes = tools.find((t) => t.name === "apply")!.inputSchema.properties.ops.items.anyOf;
  const of = (op: string) => shapes.find((s) => (s.properties.op as { enum: string[] }).enum[0] === op)!;
  assert.deepEqual(shapes.map((s) => (s.properties.op as { enum: string[] }).enum[0]),
    ["add_question", "append_log", "set_purpose", "set_handle", "add_group", "set_project", "set_group", "add_milestone", "set_milestone", "reply_note", "add_deck", "edit_cards", "delete_deck", "set_primer", "place"]);
  assert.deepEqual(Object.keys(of("place").properties), ["op", "id", "group", "milestone", "pinned"]);
  assert.deepEqual(of("place").required, ["op", "id"]);
  assert.deepEqual(of("add_question").required, ["op", "front"]);
  assert.match(await ok("get_guide", { topic: "apply" }), /- `place` \(id, group\?, milestone\?, pinned\?\): Puts a source/);
  const routine = await ok("get_guide", { topic: "routine" });
  assert.match(routine, /Readers scan before they read/, "the routine guide carries the attention principles");
  assert.doesNotMatch(routine, /exemplar/i, "no page to copy the layout of");
  for (const tool of ["dashboard_board", "dashboard_open", "dashboard_post", "dashboard_add_items", "dashboard_read"]) assert.ok(routine.includes(tool), `the routine guide names ${tool}`);
  for (const kind of ["proposal", "built"]) {
    assert.ok(routine.includes(`topic: "${kind}"`), `the routine guide points at the ${kind} topic`);
    assert.doesNotMatch(await ok("get_guide", { topic: kind }), /<!doctype html>/i, `${kind} says what a page holds, not a template to copy`);
  }
});
