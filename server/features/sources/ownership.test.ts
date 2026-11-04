import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSource, sourceOwnershipIssues } from "./ownership.ts";
import { sourceFence } from "./fence.ts";

const dir = mkdtempSync(join(tmpdir(), "strata-source-"));
process.env.STRATA_DB = join(dir, "room.db");
process.env.GEMINI_API_KEY = "test-key-never-sent";
process.env.STRATA_FAKE_MODEL = "1";
const { db } = await import("../../platform/db/db.ts");
const { tx } = await import("../../platform/db/tx.ts");
const { q } = await import("../repo.ts");
const { deps } = await import("../../platform/config.ts");
const { distilSection } = await import("../distil/queue.ts");
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function fixture(id: string) {
  for (const board of ["old", "new"]) if (!q.board.get(board)) q.insBoard.run(board, board, "blank", 1, 1);
  db.prepare("INSERT INTO resources (id,board_id,filename,mime,text,tokens,included,created_at,kind) VALUES (?,'old','Book','text/plain','# Claim\nPractice matters for recall.',10,1,1,'text')").run(id);
  for (let i = 0; i < 2; i++) {
    q.insSection.run(`${id}-s${i}`, id, "old", i, `Chapter ${i}`, 1, 0, 1, 10);
    q.insPair.run(`${id}-p${i}`, "old", `Chapter ${i}`, id, null, i, `${id}-s${i}`);
    q.upsertTree.run(`${id}-s${i}`, id, "old", "Chapter", "Why?", "{}", "tree", "ready", null, 0, 1);
  }
  q.upsertSourceTree.run(id, "old", "Book", "Why?", "{}", "tree", "ready", null, 1);
  q.insMsg.run("old", id, "user", "Remember this", null, "[]", 0, 1);
  db.prepare("INSERT INTO marks (id,board_id,resource_id,start_off,end_off,quote,created_at,updated_at) VALUES (?,'old',?,0,3,'Why',1,1)").run(`${id}-mark`, id);
  q.insMarkReply.run(`${id}-reply`, "old", `${id}-mark`, id, "agent", "Because it holds.", 1, 1);
  q.insMinted.run(`${id}-mint`, "old", `${id}-p1`, "bare", "closed", "Question", "Answer", "Book", "{}", 0, 1, 1);
}
const move = (rid: string, board: string) => tx(() => fileSource(db, rid, board));

test("filing carries chapters, trees, archived conversations, marks and authored-card provenance", () => {
  fixture("book");
  db.prepare("UPDATE messages SET archived = 1 WHERE resource_id = 'book'").run();
  q.insMsg.run("new", null, "user", "Destination conversation", null, "[]", 0, 1);
  q.upsertCourse.run("personal", "Cards", "{}", 1);
  q.insCard.run("personal/card", "personal", "personal/yours", "flashcard", '{"board":"old","front":"Question"}', 0);
  q.setMintedCard.run("personal/card", 1, "old", "book-mint");
  move("book", "new");
  assert.deepEqual(sourceOwnershipIssues(db), []);
  assert.equal(q.sectionsOf.all("book").length, 2);
  assert.deepEqual(q.repliesOf.all("new").map((r) => r.text), ["Because it holds."], "a note's replies move with it");
  assert.equal(q.pairsOf.all("new").filter(p => p.resource_id === "book").length, 2);
  assert.equal(q.minted.get("new", "book-mint")?.pair_id, "book-p1");
  assert.equal(JSON.parse(q.cardAny.get("personal/card")!.payload).board, "new");
  const message = db.prepare("SELECT board_id,idx,archived FROM messages WHERE resource_id='book'").get()!;
  assert.deepEqual({ ...message }, { board_id: "new", idx: 1, archived: 1 });
});

test("a destination key collision rolls the entire source back", () => {
  fixture("collision");
  q.insPair.run("collision-p1", "new", "Unrelated", null, null, 99, null);
  assert.throws(() => move("collision", "new"), /UNIQUE/);
  assert.ok(q.resource.get("old", "collision"));
  assert.ok(q.pair.get("old", "collision-p0"));
  assert.ok(q.minted.get("old", "collision-mint"));
});

test("the ownership audit finds and reunites a historical partial move without deleting content", () => {
  fixture("split");
  db.prepare("UPDATE resources SET board_id='new' WHERE id='split'").run();
  assert.ok(sourceOwnershipIssues(db).some(r => r.resource === "split"));
  move("split", "new");
  assert.ok(!sourceOwnershipIssues(db).some(r => r.resource === "split"));
  assert.equal(q.minted.get("new", "split-mint")?.back, "Answer");
});

test("a source fence detects moving away and back, changing sections and deletion", () => {
  fixture("fence");
  const current = sourceFence(db, "fence", "old", "fence-s0");
  assert.equal(current(), true);
  move("fence", "new"); move("fence", "old");
  assert.equal(current(), false);
  const range = sourceFence(db, "fence", "old", "fence-s0");
  db.prepare("UPDATE sections SET last_page=3 WHERE id='fence-s0'").run();
  assert.equal(range(), false);
  const deletion = sourceFence(db, "fence", "old");
  q.delResource.run("old", "fence");
  assert.equal(deletion(), false);
});

test("a delayed model reply cannot recreate a deleted source's tree or cards", async () => {
  fixture("deleted");
  let release!: (value: unknown) => void;
  const before = deps.callGeminiJson;
  deps.geminiAvailable = true;
  deps.callGeminiJson = () => new Promise(resolve => { release = resolve; });
  try {
    q.setTreeStatus.run("queued", null, 1, "deleted-s0");   // a run claims only a waiting section
    const job = distilSection("old", "deleted-s0", null);
    assert.ok(release, "the model call began");
    q.delResource.run("old", "deleted"); q.delSectionsOf.run("deleted"); q.delTreesOfResource.run("deleted");
    release({ title: "Book", question: "Why practice?", nodes: [{ kind: "synthesis", label: "Practice improves recall", anchor: "#claim", questions: ["Why practice?"], children: [] }] });
    await job;
    assert.equal(q.tree.get("deleted-s0"), undefined);
    assert.equal(q.cardsOf.all("src-deleted-s0").length, 0);
  } finally { deps.callGeminiJson = before; deps.geminiAvailable = false; }
});

test("retrying card generation reuses the persisted tree checkpoint", async () => {
  fixture("checkpoint");
  const tree={title:"Saved tree",question:"Why practice?",nodes:[{id:"1",kind:"synthesis",label:"Practice improves recall",anchor:"#claim",questions:["Why practice?"],children:[]}]};
  db.prepare("UPDATE trees SET json=?,status='queued' WHERE section_id='checkpoint-s0'").run(JSON.stringify(tree));
  const before=deps.callGeminiJson;const calls:string[]=[];
  deps.geminiAvailable=true;
  deps.callGeminiJson=async opts=>{calls.push(opts.user);return {cards:[{type:"flashcard",front:"Why practice?",back:"To improve recall.",node:"1",quote:"Practice matters for recall"}]};};
  try {
    await distilSection("old","checkpoint-s0",null);
    assert.equal(calls.length,1);
    assert.match(calls[0],/CONCEPT TREE \(already extracted/);
    assert.equal(q.tree.get("checkpoint-s0")?.status,"ready");
    assert.equal(q.tree.get("checkpoint-s0")?.cards,1);
    assert.equal(JSON.parse(q.tree.get("checkpoint-s0")!.json!).title,"Saved tree");
  } finally {deps.callGeminiJson=before;deps.geminiAvailable=false;}
});


test("retrying a failed chapter preserves completed chapters and rebuilds the book overview", async () => {
  const {retryImport,imports}=await import('../imports/pump.ts');
  fixture('retry-book');
  const tree={title:'Book',question:'Why?',nodes:[{id:'1',kind:'synthesis',label:'Practice improves recall',anchor:'#claim',questions:['Why practice?'],children:[]}]};
  db.prepare("UPDATE trees SET json=? WHERE resource_id='retry-book'").run(JSON.stringify(tree));
  q.setTreeStatus.run('error','Interrupted cards',1,'retry-book-s1');
  db.prepare("INSERT INTO imports(id,board_id,filename,size,received,stage,resource_id,created_at,updated_at) VALUES('retry-receipt','old','Book',1,1,'imported','retry-book',1,1)").run();
  const before=deps.callGeminiJson;const calls:string[]=[];
  deps.geminiAvailable=true;
  deps.callGeminiJson=async opts=>{calls.push(opts.user);return {...tree,cards:[{type:'flashcard',front:'Why practice?',back:'To improve recall.',node:'1',quote:'Practice matters for recall'}]};};
  try {
    retryImport(imports.get('retry-receipt')!);
    assert.equal(q.tree.get('retry-book-s0')?.status,'ready');
    assert.equal(q.sourceTree.get('retry-book'),undefined,'the partial overview was invalidated');
    for(let i=0;i<100&&q.sourceTree.get('retry-book')?.status!=='ready';i++) await new Promise(resolve=>setImmediate(resolve));
    assert.equal(q.tree.get('retry-book-s1')?.status,'ready');
    assert.equal(q.sourceTree.get('retry-book')?.status,'ready');
    assert.equal(calls.length,2,'only failed cards and their downstream overview are regenerated');
    assert.match(calls[0],/CONCEPT TREE \(already extracted/);
    assert.match(calls[1],/It has 2 sections/);
  } finally {deps.callGeminiJson=before;deps.geminiAvailable=false;}
});
