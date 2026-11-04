import { test } from "node:test";
import assert from "node:assert/strict";
import { PendingReads, WarmReads } from "./pending-reads.ts";

test("concurrent readers share work but a later visit fetches current data",async ()=>{
  const reads = new PendingReads();
  let calls = 0;
  const fetch = async ()=>++calls;
  const a = reads.run("board",fetch), b = reads.run("board",fetch);
  assert.equal(a,b);
  assert.deepEqual(await Promise.all([a,b]),[1,1]);
  assert.equal(await reads.run("board",fetch),2);
});
test("a failed shared request can be retried",async ()=>{
  const reads = new PendingReads();
  const pending = reads.run("board",()=>Promise.reject(new Error("disconnected")));
  await assert.rejects(pending,/disconnected/);
  assert.equal(await reads.run("board",async ()=>"back online"),"back online");
});
test("a write invalidates pending reads; an old response cannot evict the new request",async ()=>{
  const reads = new PendingReads();
  let finishOld!: (value:string)=>void, finishNew!: (value:string)=>void;
  const old = reads.run("board",()=>new Promise<string>(resolve=>{finishOld=resolve;}));
  reads.invalidate();
  const fresh = reads.run("board",()=>new Promise<string>(resolve=>{finishNew=resolve;}));
  finishOld("before edit"); await old;
  assert.equal(reads.run("board",async ()=>"unexpected duplicate"),fresh);
  finishNew("after edit");
  assert.equal(await fresh,"after edit");
});

test("a warmed read is handed to the next read of its path, once",async ()=>{
  const warm = new WarmReads(30_000);
  let calls = 0;
  const read = async ()=>++calls;
  const early = warm.start("board",read);
  assert.equal(warm.start("board",read),early,"warming twice asks once");
  assert.equal(warm.take("board"),early);
  assert.equal(warm.take("board"),undefined,"the next read asks for itself");
  assert.equal(await early,1);
  assert.equal(calls,1);
});
test("a warmed read too old to trust is not handed over",async ()=>{
  let t = 0;
  const warm = new WarmReads(30_000,()=>t);
  const early = warm.start("board",async ()=>"stale");
  await early;
  t = 30_001;
  assert.equal(warm.take("board"),undefined);
});
test("a write discards every warmed read, and a failed one is forgotten",async ()=>{
  const warm = new WarmReads(30_000);
  warm.start("board",async ()=>"before the write");
  warm.clear();
  assert.equal(warm.take("board"),undefined);
  const failed = warm.start("deck",()=>Promise.reject(new Error("wire down")));
  await assert.rejects(failed,/wire down/);
  assert.equal(warm.take("deck"),undefined,"the real read asks again");
});
