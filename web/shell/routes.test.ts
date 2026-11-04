import { test } from "node:test";
import assert from "node:assert/strict";
import { Navigation,keepsFrames,keepsRoute,readRoute,routeBoard,routeSearch, type RoomRoute } from "./routes.ts";
import { ROUTES } from "../surfaces.ts";
test("routes round-trip every screen without a remembered resource changing board home",()=>{
  for(const route of [{kind:"library"},{kind:"review"},{kind:"board",board:"b"},{kind:"board",board:"b",resource:"r",pair:"p"},
    {kind:"cram",board:"b"},{kind:"keeps"},{kind:"keeps",board:"b"},{kind:"keeps",board:"b",deck:"src-s7b2ad33e"},
    {kind:"keeps",board:"b",from:"library"},{kind:"keeps",board:"b",deck:"d",from:"library"}] as RoomRoute[]) {
    assert.equal(routeSearch(readRoute(routeSearch(route))),routeSearch(route));
    assert.deepEqual(readRoute(routeSearch(route)).kind,route.kind);
  }
  assert.equal(readRoute("?board=b").kind,"board");
  assert.equal(routeSearch(readRoute("?board=../../private")),"");
});
test("every screen in the table is a route kind, so Back and a reload restore each of them",()=>{
  const reachable = new Set(["library","review","board","cram","keeps"].map((k)=>readRoute(routeSearch(
    k==="board"||k==="cram"?{kind:k,board:"b"} as RoomRoute:{kind:k} as RoomRoute)).kind));
  for (const screen of ROUTES) assert.ok(reachable.has(screen==="reader"?"board":screen), `${screen} has a route`);
  assert.equal(readRoute("?board=b&pair=p").kind,"board","the reader is a board with a pair");
});
test("every URL that worked before still lands where it did",()=>{
  assert.deepEqual(readRoute(""),{kind:"library"});
  assert.deepEqual(readRoute("?view=review"),{kind:"review"});
  assert.deepEqual(readRoute("?board=b&view=review"),{kind:"review"},"the review wins, as it always did");
  assert.deepEqual(readRoute("?board=b&resource=r&pair=p"),{kind:"board",board:"b",resource:"r",pair:"p"});
  assert.deepEqual(readRoute("?view=cram"),{kind:"library"},"a cram needs its board");
  assert.deepEqual(readRoute("?view=keeps&deck=d"),{kind:"keeps"},"a deck's keeps needs its board");
  assert.equal(routeSearch(readRoute("?board=b&view=keeps&deck=../x")),"?board=b&view=keeps");
});
test("a cram and the keeps stand on their board: its own answers land behind them, another's never do",()=>{
  const nav=new Navigation();
  nav.begin({kind:"board",board:"a"});
  nav.begin({kind:"cram",board:"a"});
  assert.equal(routeBoard(nav.route),"a");
  assert.equal(nav.accepts("a","a"),true); assert.equal(nav.accepts("b","a"),false);
  nav.begin({kind:"keeps",board:"a",deck:"d"});
  assert.equal(nav.accepts("a","a"),true); assert.equal(nav.accepts("b","a"),false);
  assert.equal(routeBoard({kind:"keeps"}),undefined);
  const fresh=new Navigation();
  fresh.begin({kind:"cram",board:"a"});
  assert.equal(fresh.accepts("a",null),true,"the cram's own board lands");
  assert.equal(fresh.accepts("b",null),false);
});
test("the keeps stack's top frame names the route",()=>{
  assert.deepEqual(keepsRoute([{library:true}],"a"),{kind:"keeps"});
  assert.deepEqual(keepsRoute([{board:true}],"a"),{kind:"keeps",board:"a"});
  assert.deepEqual(keepsRoute([{library:true},{board:true,boardId:"b"}],"a"),{kind:"keeps",board:"b",from:"library"});
  assert.deepEqual(keepsRoute([{library:true},{board:true,boardId:"b"},{slug:"d/x",boardId:"b"}],"a"),{kind:"keeps",board:"b",deck:"d",from:"library"});
  assert.deepEqual(keepsRoute([{board:true},{slug:"src-1/x",boardId:"a"}],"a"),{kind:"keeps",board:"a",deck:"src-1"});
  assert.deepEqual(keepsRoute([{slug:"d"}],null),{kind:"keeps"},"no board, no deck");
});
test("a delayed selection cannot override a newer selection, including A to B to A",()=>{
  const nav=new Navigation();
  const a=nav.begin({kind:"board",board:"a"});
  nav.begin({kind:"board",board:"b"}); nav.begin({kind:"board",board:"a"});
  assert.equal(nav.current(a),false); assert.equal(nav.owns("b"),false);
  nav.begin({kind:"library"}); assert.equal(nav.owns("a"),false);
});
test("the library's keeps stay over the library, at every depth and through a reload",()=>{
  const deep:RoomRoute={kind:"keeps",board:"b",deck:"d",from:"library"};
  assert.deepEqual(readRoute(routeSearch(deep)),deep);
  assert.equal(routeBoard(deep),undefined);
  assert.deepEqual(keepsFrames(deep),[{library:true},{board:true,boardId:"b"},{slug:"d",boardId:"b"}]);
  assert.deepEqual(keepsRoute(keepsFrames(deep),"a"),deep,"the frames round-trip to the route");
  assert.deepEqual(keepsFrames({kind:"keeps"}),[{library:true}]);
  assert.deepEqual(keepsFrames({kind:"keeps",board:"a"}),[{board:true}]);
  assert.deepEqual(readRoute("?view=keeps&from=library"),{kind:"keeps"},"from needs a board");
});
test("opening or closing a screen over the board in hand keeps that board's requests current",()=>{
  const nav=new Navigation();
  const v=nav.begin({kind:"board",board:"a",pair:"p"});
  assert.equal(nav.shift({kind:"cram",board:"a"}),v); assert.equal(nav.current(v),true);
  assert.equal(nav.shift({kind:"board",board:"a",pair:"p"}),v);
  assert.equal(nav.shift({kind:"keeps",board:"a"}),v);
  assert.equal(nav.shift({kind:"keeps",board:"a",deck:"d"}),v);
  assert.equal(nav.route.kind,"keeps");
  nav.shift({kind:"board",board:"a"});
  assert.notEqual(nav.shift({kind:"board",board:"a",pair:"q"}),v);
  const w=nav.version;
  assert.notEqual(nav.shift({kind:"cram",board:"b"}),w);
  assert.notEqual(nav.shift({kind:"library"}),nav.version-1);
});
