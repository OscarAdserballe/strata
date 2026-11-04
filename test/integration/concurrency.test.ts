import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer, type TestServer } from "../support/server.ts";
import { newBoard, addMarkdown, MD } from "./seed.ts";

const DECK = "csharp-async";
const OTHER = "aio-lecture-4";
const hedge = (n: number) => ({
  tree: { title: "Hedging", question: "What does a hedge leave open?", nodes: [{ label: `convexity, take ${n}`, kind: "concept", anchor: "#duration-hedging" }] },
  cards: [{ node: "n1", type: "flashcard", source: "#duration-hedging", front: `What is left open, take ${n}?`, back: "Convexity." }],
});

let board = "", source = "", section = "", treeDeck = "", mint = "", card = "", dropped = "", edited = "", due = "";
const server: TestServer = useServer({
  async seed(s) {
    board = await newBoard(s, { title: "concurrency: two devices, one board" });
    source = await addMarkdown(s, board, "hedging.md", MD);
    section = (await s.api(`/api/boards/${board}`)).body.sections[0].id;
    const put = await s.api(`/api/boards/${board}/resources/${source}/tree?section=${section}`, { method: "PUT", body: JSON.stringify(hedge(0)) });
    if (put.status !== 200) throw new Error(`seeding a tree failed: ${put.status} ${JSON.stringify(put.body)}`);
    treeDeck = (await s.api(`/api/boards/${board}/resources/${source}/tree?section=${section}`)).body.deck;
    const made = await s.api(`/api/boards/${board}/minted`, { method: "POST", body: JSON.stringify({ front: "What does a DV01 hedge leave open?", variant: "bare", state: "open" }) });
    if (made.status !== 201) throw new Error(`seeding a question failed: ${made.status} ${JSON.stringify(made.body)}`);
    mint = made.body.id;
    const cards = (await s.api(`/api/decks/${DECK}`)).body.cards as { id: string }[];
    [card, dropped] = [cards[0].id, cards[1].id];
    const others = (await s.api(`/api/decks/${OTHER}`)).body.cards as { id: string }[];
    [edited, due] = [others[0].id, others[1].id];
  },
});

function read<T>(sql: string, ...args: (string | number)[]): T | undefined {
  const db = new DatabaseSync(server.db, { readOnly: true, timeout: 5000 });
  try { return db.prepare(sql).get(...args) as T | undefined; } finally { db.close(); }
}
const receipts = (key: string): number => read<{ n: number }>("SELECT count(*) AS n FROM request_receipts WHERE key = ?", key)!.n;

let keys = 0;
const newKey = (): string => `concurrency-${process.pid}-${++keys}-${Date.now().toString(36)}`;

interface Answer { status: number; body: any; replay: boolean }
async function send(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const r = await server.fetch(path, { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json(), replay: r.headers.get("Idempotent-Replay") === "true" };
}
const ifMatch = (rev: number | string): Record<string, string> => ({ "If-Match": typeof rev === "number" ? `"${rev}"` : rev });

interface Doc {
  name: string;
  method: string;
  path(): string;
  base(): Promise<{ rev: number; value: unknown }>;
  stored(): number;
  content(): unknown;
  body(n: number): unknown;
}

async function holdsItsPromises(doc: Doc): Promise<void> {
  let n = 0;
  const write = (headers: Record<string, string> = {}) => send(doc.method, doc.path(), doc.body(++n), headers);

  const b0 = await doc.base();
  assert.equal(b0.rev, doc.stored(), `${doc.name}: the base the client reads is the stored stamp`);
  const fresh = await write(ifMatch(b0.rev));
  assert.equal(fresh.status, 200, `${doc.name}: a fresh If-Match writes (${JSON.stringify(fresh.body).slice(0, 200)})`);
  const r1 = doc.stored();
  assert.ok(r1 > b0.rev, `${doc.name}: and the document's rev moves (${b0.rev} → ${r1})`);

  const held = doc.content();
  const stale = await write(ifMatch(b0.rev));
  assert.equal(stale.status, 409, `${doc.name}: a stale If-Match is refused`);
  assert.equal(stale.body.error, "changed elsewhere");
  const now = await doc.base();
  assert.deepEqual(stale.body.conflict, { rev: r1, value: now.value }, `${doc.name}: the 409 carries the current document, as the client reads it, and its rev`);
  assert.equal(now.rev, r1);
  assert.equal(doc.stored(), r1, `${doc.name}: the refusal moved no rev`);
  assert.deepEqual(doc.content(), held, `${doc.name}: and wrote nothing`);

  const bare = await write(ifMatch(String(r1)));
  assert.equal(bare.status, 200, `${doc.name}: If-Match: ${r1} (unquoted) is taken`);
  const r2 = doc.stored();
  assert.ok(r2 > r1);

  // stale under a key stores no receipt, so the retry over the new rev is judged afresh
  const key = newKey();
  const keyed = await write({ ...ifMatch(r1), "Idempotency-Key": key });
  assert.equal(keyed.status, 409, `${doc.name}: stale under a key is refused the same way`);
  assert.equal(keyed.body.conflict.rev, r2);
  assert.equal(receipts(key), 0, `${doc.name}: and stores no receipt`);
  assert.equal(doc.stored(), r2);
  const again = newKey();
  const retried = await send(doc.method, doc.path(), doc.body(n), { ...ifMatch(r2), "Idempotency-Key": again });
  assert.equal(retried.status, 200, `${doc.name}: the retry over the fresh rev, under a new key, writes`);
  assert.equal(receipts(again), 1, `${doc.name}: and is receipted`);
  const r3 = doc.stored();
  assert.ok(r3 > r2);
  const lost = await send(doc.method, doc.path(), doc.body(n), { ...ifMatch(r2), "Idempotency-Key": again });
  assert.deepEqual([lost.status, lost.replay], [200, true], `${doc.name}: a retry under the same key is replayed`);
  assert.deepEqual(lost.body, retried.body);
  assert.equal(doc.stored(), r3, `${doc.name}: and writes nothing`);
  const same = await send(doc.method, doc.path(), doc.body(++n), { ...ifMatch(r3), "Idempotency-Key": key });
  assert.equal(same.status, 200, `${doc.name}: and so would one under the refused key: it holds nothing`);
  const r4 = doc.stored();
  assert.ok(r4 > r3);

  const blind = await write();
  assert.equal(blind.status, 200, `${doc.name}: without If-Match the write is today's`);
  const r5 = doc.stored();
  assert.ok(r5 > r4);

  const before = doc.content();
  const bad = await write(ifMatch("W/\"3\""));
  assert.equal(bad.status, 400, `${doc.name}: an If-Match that is no revision is a 400`);
  assert.match(bad.body.error, /If-Match/);
  assert.equal(doc.stored(), r5);
  assert.deepEqual(doc.content(), before);
}

const boardRead = async () => (await server.api(`/api/boards/${board}`)).body;

const notes: Doc = {
  name: "W4 board notes",
  method: "PUT",
  path: () => `/api/boards/${board}/notes`,
  base: async () => { const s = await boardRead(); return { rev: s.notesRev, value: { text: s.notes } }; },
  stored: () => read<{ rev: number }>("SELECT rev FROM board_notes WHERE board_id = ?", board)?.rev ?? 0,
  content: () => read<{ text: string }>("SELECT text FROM board_notes WHERE board_id = ?", board)?.text ?? null,
  body: (n) => ({ text: `# the running log, save ${n}` }),
};

const planDoc = { method: "PUT", stored: () => read<{ plan_rev: number }>("SELECT plan_rev FROM boards WHERE id = ?", board)!.plan_rev };
const planBase = async () => { const s = await boardRead(); return { rev: s.plan.rev, value: s.plan }; };
const planContent = () => ({
  purpose: read<{ purpose: string | null }>("SELECT purpose FROM boards WHERE id = ?", board)!.purpose,
  places: read<{ p: string | null }>("SELECT group_concat(item || ':' || coalesce(group_id, '-') || ':' || ord, ',') AS p FROM (SELECT * FROM board_places WHERE board_id = ? ORDER BY item)", board)!.p,
});

const purpose: Doc = {
  ...planDoc, name: "W38 plan purpose",
  path: () => `/api/boards/${board}/plan/purpose`,
  base: planBase, content: planContent,
  body: (n) => ({ purpose: `pass the exam, attempt ${n}` }),
};

const order: Doc = {
  ...planDoc, name: "W45 plan order",
  path: () => `/api/boards/${board}/plan/order`,
  base: planBase, content: planContent,
  // two items, in an order that alternates, so every write is a change
  body: (n) => ({ group: null, items: n % 2 ? [source, "pair-placeholder"] : ["pair-placeholder", source] }),
};

const treePath = () => `/api/boards/${board}/resources/${source}/tree?section=${section}`;
const tree: Doc = {
  name: "W10 a section's tree",
  method: "PUT",
  path: treePath,
  base: async () => { const t = (await server.api(treePath())).body; return { rev: t.rev, value: t }; },
  stored: () => read<{ rev: number }>("SELECT rev FROM trees WHERE section_id = ?", section)?.rev ?? 0,
  content: () => ({
    tree: read<{ json: string }>("SELECT json FROM trees WHERE section_id = ?", section)?.json,
    deck: read<{ p: string | null }>("SELECT group_concat(payload, '|') AS p FROM (SELECT payload FROM cards WHERE course = ? ORDER BY ord)", treeDeck)!.p,
  }),
  body: hedge,
};

const cardDoc: Doc = {
  name: "W11 a card's faces",
  method: "PATCH",
  path: () => `/api/decks/${DECK}/cards/${card}`,
  base: async () => {
    const c = ((await server.api(`/api/decks/${DECK}`)).body.cards as { id: string; rev: number }[]).find((x) => x.id === card)!;
    return { rev: c.rev, value: c };
  },
  stored: () => read<{ rev: number }>("SELECT rev FROM cards WHERE course = ? AND id = ?", DECK, card)!.rev,
  content: () => read<{ payload: string }>("SELECT payload FROM cards WHERE course = ? AND id = ?", DECK, card)!.payload,
  body: (n) => ({ front: `What is the first async fixture, take ${n}?` }),
};

const mintedRow = async () => ((await boardRead()).minted as { id: string; rev: number }[]).find((m) => m.id === mint)!;
const minted: Doc = {
  name: "W30 your card's text",
  method: "PATCH",
  path: () => `/api/boards/${board}/minted/${mint}`,
  base: async () => { const m = await mintedRow(); return { rev: m.rev, value: m }; },
  stored: () => read<{ rev: number }>("SELECT rev FROM minted WHERE id = ?", mint)!.rev,
  content: () => read<{ front: string; back: string | null; state: string }>("SELECT front, back, state FROM minted WHERE id = ?", mint),
  body: (n) => ({ front: `What does a DV01 hedge leave open, take ${n}?` }),
};

test("board notes: a stale base is refused with the log as it stands", () => holdsItsPromises(notes));
test("the plan's purpose: a stale base is refused with the whole plan", () => holdsItsPromises(purpose));
test("a group's order: a stale base is refused with the whole plan", () => holdsItsPromises(order));
test("a section's tree: a stale base is refused with the tree as GET answers it", () => holdsItsPromises(tree));
test("a card's faces: a stale base is refused with the card as the deck read gives it", () => holdsItsPromises(cardDoc));
test("your card's text: a stale base is refused with the row as the board state draws it", () => holdsItsPromises(minted));

test("a tree put answers the new tree's rev beside the board; a section not yet distilled is a document too", async () => {
  const put = await send("PUT", treePath(), hedge(100), ifMatch((await tree.base()).rev));
  assert.equal(put.status, 200);
  assert.equal(put.body.treeRev, tree.stored(), "treeRev: the stamp the next put is based on");
  assert.equal(put.body.state.rev, read<{ rev: number }>("SELECT rev FROM boards WHERE id = ?", board)!.rev, "and the board state its board's, as ever");

  const other = await addMarkdown(server, board, "second.md", "# Second\n\nAnother chapter, never distilled.\n");
  const sid = ((await boardRead()).sections as { id: string; resourceId: string }[]).find((x) => x.resourceId === other)!.id;
  const path = `/api/boards/${board}/resources/${other}/tree?section=${sid}`;
  const placeholder = (await server.api(path)).body;
  assert.equal(placeholder.tree, null);
  const stale = await send("PUT", path, hedge(1), ifMatch(placeholder.rev - 1));
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.conflict, { rev: placeholder.rev, value: placeholder }, "refused with the placeholder as GET answers it");
  assert.equal(read<{ json: string | null }>("SELECT json FROM trees WHERE section_id = ?", sid)!.json, null, "and nothing was written");
  const first = await send("PUT", path, hedge(1), ifMatch(placeholder.rev));
  assert.equal(first.status, 200);
  assert.ok(first.body.treeRev > placeholder.rev);
});

test("a card set aside is a new revision: an edit made over the live card is refused with the tombstone", async () => {
  const live = ((await server.api(`/api/decks/${DECK}`)).body.cards as { id: string; rev: number }[]).find((c) => c.id === dropped)!;
  assert.equal((await server.api(`/api/decks/${DECK}/cards/${dropped}`, { method: "DELETE" })).status, 200);
  const stale = await send("PATCH", `/api/decks/${DECK}/cards/${dropped}`, { back: "over the live card" }, ifMatch(live.rev));
  assert.equal(stale.status, 409);
  const tomb = ((await server.api(`/api/decks/${DECK}/ignored`)).body.cards as { id: string; rev: number }[]).find((c) => c.id === dropped)!;
  assert.deepEqual(stale.body.conflict, { rev: tomb.rev, value: tomb }, "the card as the ignored pile reads it");
  const fresh = await send("PATCH", `/api/decks/${DECK}/cards/${dropped}`, { back: "over the tombstone" }, ifMatch(tomb.rev));
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.card.back, "over the tombstone");
  assert.equal(fresh.body.card.rev, read<{ rev: number }>("SELECT rev FROM card_drops WHERE id = ?", dropped)!.rev);
});

test("your card states a base only for its text: meta alone is never refused, a closing back is", async () => {
  const { rev } = await minted.base();
  const touched = await send("PATCH", minted.path(), { front: "What does a hedge leave open, finally?" });
  assert.equal(touched.status, 200);
  const meta = await send("PATCH", minted.path(), { meta: { wager: 3 } }, ifMatch(rev));
  assert.equal(meta.status, 200, "a meta patch carries no text, so the stale If-Match is not a precondition on it");
  const before = minted.content();
  const close = await send("PATCH", minted.path(), { back: "Convexity.", state: "closed" }, ifMatch(rev));
  assert.equal(close.status, 409, "closing on a back is text, and was written over an old front");
  assert.deepEqual(minted.content(), before);
  assert.equal(close.body.conflict.value.front, "What does a hedge leave open, finally?");
  const closed = await send("PATCH", minted.path(), { back: "Convexity.", state: "closed" }, ifMatch(close.body.conflict.rev));
  assert.equal(closed.status, 200);
  assert.equal((await mintedRow() as unknown as { state: string }).state, "closed");
});

test("the plan's rev is one document: a write to any part of it makes a purpose based on the old plan stale", async () => {
  const { rev } = await planBase();
  const added = await send("POST", `/api/boards/${board}/plan/groups`, { name: "week 1" });
  assert.equal(added.status, 201);
  const stale = await send("PUT", `/api/boards/${board}/plan/purpose`, { purpose: "over the old plan" }, ifMatch(rev));
  assert.equal(stale.status, 409);
  assert.ok(stale.body.conflict.value.groups.some((g: { name: string }) => g.name === "week 1"), "the conflict hands back the plan with the new group in it");
  assert.equal(stale.body.conflict.rev, added.body.plan.rev, "at the rev the group's answer carried");
});

test("If-Match: * is no precondition, and a board that was never written to is at notes rev 0", async () => {
  const fresh = await newBoard(server, { title: "concurrency: an empty log" });
  const s = (await server.api(`/api/boards/${fresh}`)).body;
  assert.deepEqual([s.notesRev, s.notes], [0, ""]);
  const stale = await send("PUT", `/api/boards/${fresh}/notes`, { text: "over a log that never was" }, ifMatch(5));
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body.conflict, { rev: 0, value: { text: "" } });
  const first = await send("PUT", `/api/boards/${fresh}/notes`, { text: "the first line" }, ifMatch(0));
  assert.equal(first.status, 200);
  assert.ok(first.body.notesRev > 0);
  const any = await send("PUT", `/api/boards/${fresh}/notes`, { text: "whatever is there" }, ifMatch("*"));
  assert.equal(any.status, 200);
});

// A deck rebuild re-applies card edits; it must not move the rev of a card it leaves unchanged.
test("an edited card's base outlives a rebuild of another deck", async () => {
  const path = `/api/decks/${OTHER}/cards/${edited}`;
  const first = await send("PATCH", path, { front: "An edit, made once?" });
  assert.equal(first.status, 200);
  const base = first.body.card.rev as number;
  const deckRev = () => read<{ rev: number }>("SELECT rev FROM courses WHERE slug = ?", OTHER)!.rev;
  const deckBefore = deckRev();
  const put = await send("PUT", treePath(), hedge(300));
  assert.equal(put.status, 200);
  assert.equal(read<{ rev: number }>("SELECT rev FROM cards WHERE id = ?", edited)!.rev, base, "the edited card in another deck was not rewritten");
  assert.equal(deckRev(), deckBefore, "nor was its deck's rev moved");
  const again = await send("PATCH", path, { back: "And edited again." }, ifMatch(base));
  assert.equal(again.status, 200, `the base the first edit answered is still the card's (${JSON.stringify(again.body).slice(0, 200)})`);
  assert.equal(again.body.card.front, "An edit, made once?");
});

test("a due card in the review carries its rev, and it is the base an edit from the review states", async () => {
  // a keep a month old: its first rung has passed, so the card is owed today
  const db = new DatabaseSync(server.db, { timeout: 5000 });
  try {
    db.prepare("INSERT OR IGNORE INTO card_keeps (id,course,deck,created_at) VALUES (?,?,?,?)")
      .run(due, OTHER, read<{ deck: string }>("SELECT deck FROM cards WHERE id = ?", due)!.deck, Date.now() - 30 * 864e5);
  } finally { db.close(); }
  const owed = ((await server.api("/api/review")).body.cards as { id: string; rev: number }[]).find((c) => c.id === due);
  assert.ok(owed, "the month-old keep is due");
  assert.equal(owed.rev, read<{ rev: number }>("SELECT rev FROM cards WHERE id = ?", due)!.rev, "with the card's own stamp");
  const edit = await send("PATCH", `/api/decks/${OTHER}/cards/${due}`, { back: "Rewritten from the review." }, ifMatch(owed.rev));
  assert.equal(edit.status, 200);
  const stale = await send("PATCH", `/api/decks/${OTHER}/cards/${due}`, { back: "From a second device, over the old face." }, ifMatch(owed.rev));
  assert.equal(stale.status, 409, "and an edit over the review's old copy is refused");
  assert.equal(stale.body.conflict.value.back, "Rewritten from the review.");
});

// A stale base is answered first (409 with the plan), not as a missing group (400), so the client can rebase.
test("an order into a group deleted elsewhere is a stale plan, refused with the plan without it", async () => {
  const made = await send("POST", `/api/boards/${board}/plan/groups`, { name: "doomed" });
  assert.equal(made.status, 201);
  const gid = made.body.id as string;
  const base = made.body.plan.rev as number;
  assert.equal((await send("DELETE", `/api/boards/${board}/plan/groups/${gid}`, {})).status, 200);
  const held = planContent();
  const key = newKey();
  const stale = await send("PUT", `/api/boards/${board}/plan/order`, { group: gid, items: [source] }, { ...ifMatch(base), "Idempotency-Key": key });
  assert.equal(stale.status, 409, `a stale order is a conflict first (${JSON.stringify(stale.body).slice(0, 200)})`);
  assert.ok(!stale.body.conflict.value.groups.some((g: { id: string }) => g.id === gid), "and the plan it hands back has no such group");
  assert.equal(stale.body.conflict.rev, planDoc.stored());
  assert.equal(receipts(key), 0);
  const fresh = await send("PUT", `/api/boards/${board}/plan/order`, { group: gid, items: [source] }, { ...ifMatch(stale.body.conflict.rev), "Idempotency-Key": newKey() });
  assert.equal(fresh.status, 400, "over the current plan, the missing group is the caller's mistake");
  assert.equal(fresh.body.error, "no such group on this board");
  assert.deepEqual(planContent(), held, "and neither wrote anything");
  assert.equal(planDoc.stored(), stale.body.conflict.rev);
});
