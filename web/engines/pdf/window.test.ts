import { test } from "node:test";
import assert from "node:assert/strict";
import { pageWindow } from "./window.ts";
test("a long reader searches a bounded page window, including gaps and unequal heights",()=>{
  let reads=0;
  const pages=Array.from({length:1000},(_,i)=>({id:i,get offsetTop(){reads++;return i*900;},get offsetHeight(){reads++;return i%2?800:850;}}));
  assert.deepEqual(pageWindow(pages,450100,451700).map(p=>p.id),[500,501]);
  assert.ok(reads<40,`read ${reads} offsets`);
  assert.deepEqual(pageWindow(pages,851,899),[]);
  assert.deepEqual(pageWindow([],0,100),[]);
});
