import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { useServer } from "../support/server.ts";
import { newBoard } from "./seed.ts";

let boardId = "";

const server = useServer({ seed: async (s) => { boardId = await newBoard(s, { title: "Duration hedging" }); } });
const api = (path: string, init?: RequestInit) => server.api(path, init);

test("a create sent again under its key is ONE card; the same words under a new key are a new card", async () => {
  const card = JSON.stringify({ front: "why is the sky blue?", variant: "bare", state: "closed", back: "scattering", meta: {} });
  const mk = (key: string) => api(`/api/boards/${boardId}/minted`, { method: "POST", body: card, headers: { "Content-Type": "application/json", "Idempotency-Key": key } });
  const a = await mk("press-one-0000");
  assert.equal(a.status, 201);
  const b = await mk("press-one-0000");
  assert.equal(b.status, 201);
  assert.equal(b.body.id, a.body.id);
  const dups = (b.body.state.minted as { front: string }[]).filter((m) => m.front === "why is the sky blue?");
  assert.equal(dups.length, 1);
  // the same words under a new key are a deliberate second create
  const c = await mk("press-two-0000");
  assert.equal(c.status, 201);
  assert.notEqual(c.body.id, a.body.id);
});

test("tidy validates before it spends: junk faces are a 400, and offline it says what is missing", async () => {
  const junk = await api("/api/cards/tidy", { method: "POST", body: JSON.stringify({ type: "flashcard", faces: { nonsense: "x", back: 7 } }) });
  const empty = await api("/api/cards/tidy", { method: "POST", body: JSON.stringify({}) });
  if (server.live) {
    assert.equal(junk.status, 400);
    assert.equal(empty.status, 400);
    return;
  }
  assert.equal(junk.status, 503);
  assert.match(String(junk.body.error), /draft is still here/);
  assert.equal(empty.status, 503);
});

test("pasted cards match their source and explicit source corrections survive materialization", async () => {
  const board = (await api('/api/boards', { method: 'POST', body: JSON.stringify({title:'Pasted attribution'}) })).body.board.id;
  const passage = 'Diversification reduces the risk of individual investments.';
  const r = (await api(`/api/boards/${board}/resources`, {method:'POST',body:JSON.stringify({filename:'Article',text:'# Portfolios\n\n'+passage,pair:true})})).body;
  const pair = r.state.pairs.find((p: {resourceId:string}) => p.resourceId===r.id).id;
  await api(`/api/boards/${board}/pairs/${pair}`,{method:'PATCH',body:JSON.stringify({deck:'aio-lecture-1'})});
  const result = await api(`/api/boards/${board}/minted`,{method:'POST',body:JSON.stringify({variant:'bare',front:'What does diversification do?',back:passage,pairId:pair,state:'closed',source:'asked at Article'})});
  const mint=result.body.state.minted.find((m:{id:string})=>m.id===result.body.id);
  assert.match(mint.source,/quote:/);
  assert.ok(mint.cardId);
  await api(`/api/boards/${board}/minted/${mint.id}`,{method:'PATCH',body:JSON.stringify({source:'#portfolios'})});
  const check=new DatabaseSync(server.db,{readOnly:true});
  try { assert.equal(JSON.parse((check.prepare('SELECT payload FROM cards WHERE id=?').get(mint.cardId) as {payload:string}).payload).source,'#portfolios'); }
  finally {check.close();}
  await api(`/api/boards/${board}`,{method:'DELETE'});
});

test("a card made on the words of a source read without a deck gives that source a deck, and lands in it", async () => {
  const board = (await api("/api/boards", { method: "POST", body: JSON.stringify({ title: "No deck yet" }) })).body.board.id;
  const r = (await api(`/api/boards/${board}/resources`, { method: "POST", body: JSON.stringify({ filename: "Notes", text: "# Notes\n\nA ladder shows where each kept card sits.", pair: true, study: false }) })).body;
  const pair = r.state.pairs.find((p: { resourceId: string }) => p.resourceId === r.id);
  assert.equal(pair.deck ?? null, null);
  const made = await api(`/api/boards/${board}/minted`, { method: "POST", body: JSON.stringify({ variant: "bare", front: "What does the ladder show?", back: "Where each kept card sits.", pairId: pair.id, state: "closed", source: 'quote: "where each kept card sits"', meta: { anchorExplicit: true } }) });
  const mint = made.body.state.minted.find((m: { id: string }) => m.id === made.body.id);
  const now = made.body.state.pairs.find((p: { id: string }) => p.id === pair.id);
  assert.ok(now.deck, "the pair has a deck");
  assert.ok(String(mint.cardId).startsWith(now.deck + "/"), JSON.stringify({ mint, now }));
  await api(`/api/boards/${board}`, { method: "DELETE" });
});
