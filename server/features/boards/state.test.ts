import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(),"strata-board-loading-"));
process.env.STRATA_DB = join(dir,"room.db");
process.env.GEMINI_API_KEY = "";
const { db } = await import("../../platform/db/db.ts");
const { q } = await import("../repo.ts");
const { boardState, budgetFor } = await import("./state.ts");
const { resourceMeta } = await import("../sources/meta.ts");
const { sourceOfResource } = await import("../sources/blobs.ts");
after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});

test("large sources stay available to readers while summaries preserve budgets without returning source text",()=>{
  q.insBoard.run("large","Large sources","blank",1,1);
  const text = "A source worth keeping. ".repeat(50000);
  q.insResource.run("stored","large","Book.txt","text/plain",text,54321,1,"text",null,null);
  const legacy = "💡 Older source without a token count.";
  q.insResource.run("legacy","large","Legacy.txt","text/plain",legacy,null,2,"text",null,null);
  q.insResource.run("excluded","large","Excluded.txt","text/plain",text,20000,3,"text",null,null);
  q.setResourceIncluded.run(0,"large","excluded");
  const summaries = q.resourceSummariesOf.all("large");
  assert.equal(summaries.find(r=>r.id==="stored")!.text,null);
  assert.equal(q.allResources.all().every(r=>r.text===null),true);
  assert.equal(sourceOfResource(q.resource.get("large","stored")!).text,text);
  const board = boardState("large")!;
  assert.deepEqual(board.resources,resourceMeta("large"));
  assert.deepEqual(board.budget,budgetFor("large"));
  assert.equal(board.budget.usedTokens,54321+Math.ceil(legacy.length/4));
  assert.ok(JSON.stringify(board).length < 5000);
});

test("cover previews are bounded, board-scoped, and support old byte-stored text",()=>{
  const preview = q.resourcePreview.get("large","stored")!;
  assert.equal(preview.text!.length,2048);
  assert.equal(q.resourcePreview.get("different-board","stored"),undefined);
  q.insResource.run("bytes","large","Old.txt","text/plain",null,100,4,"text",null,10000);
  q.insBlob.run("bytes",Buffer.from("Old words. ".repeat(1000)),null);
  assert.equal(q.resourcePreview.get("large","bytes")!.text!.length,2048);
  q.insResource.run("pdf","large","Book.pdf","application/pdf",null,100,5,"pdf",null,10000);
  q.insBlob.run("pdf",Buffer.from("not text"),null);
  assert.equal(q.resourcePreview.get("large","pdf")!.text,null);
});
