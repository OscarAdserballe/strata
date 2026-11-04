import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { gunzipSync } from "node:zlib";
import { acceptsGzip } from "./encoding.ts";
import { sendJson, sendRanged, serveStatic } from "./http.ts";

const payload = {message:"A reading room with many sources. ".repeat(1000)};
const bytes = Buffer.from("0123456789".repeat(300));
const server = createServer((req,res)=>{
  if (req.url === "/json") sendJson(res,200,payload);
  else if (req.url === "/raw") sendRanged(req,res,{len:bytes.length,tag:'"raw"',type:"text/plain",read:(start,len)=>bytes.subarray(start,start+len)});
  else void serveStatic(req,res,req.url!,"test-nonce");
});
let port: number;
before(async ()=>{
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  port = (server.address() as {port:number}).port;
});
after(async ()=>{ await new Promise<void>(resolve=>server.close(()=>resolve())); });
const get = (path: string, headers: Record<string,string> = {}, method="GET") => new Promise<{status:number;headers:IncomingHttpHeaders;body:Buffer}>((resolve,reject)=>{
  const req = request({hostname:"127.0.0.1",port,path,headers,method},res=>{
    const chunks: Buffer[] = [];
    res.on("data",chunk=>chunks.push(chunk));
    res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks)}));
    res.on("error",reject);
  });
  req.on("error",reject); req.end();
});

test("gzip negotiation honours disabled encodings and wildcard preferences",()=>{
  assert.equal(acceptsGzip(),false);
  for (const value of ["gzip","br, gzip;q=0.5","*;q=0.5","GZIP"]) assert.equal(acceptsGzip(value),true,value);
  for (const value of ["br","gzip;q=0","gzip;q=0, *;q=1","*;q=1, gzip;q=0","gzip ; q=0, *;q=1","*;q=0"]) assert.equal(acceptsGzip(value),false,value);
});
test("large API JSON is smaller on the wire and decodes identically",async ()=>{
  const zipped = await get("/json",{"Accept-Encoding":"gzip"});
  assert.equal(zipped.status,200);
  assert.equal(zipped.headers["content-encoding"],"gzip");
  assert.equal(zipped.headers.vary,"Accept-Encoding");
  assert.deepEqual(JSON.parse(gunzipSync(zipped.body).toString()),payload);
  const plain = await get("/json",{"Accept-Encoding":"gzip;q=0"});
  assert.equal(plain.headers["content-encoding"],undefined);
  assert.deepEqual(JSON.parse(plain.body.toString()),payload);
  assert.ok(zipped.body.length < plain.body.length/4);
});
test("compressed static assets revalidate, HTML retains its nonce, and HEAD has no body",async ()=>{
  const asset = await get("/dist/main.js",{"Accept-Encoding":"gzip"});
  assert.equal(asset.status,200);
  assert.equal(asset.headers["content-encoding"],"gzip");
  assert.ok(gunzipSync(asset.body).length > asset.body.length*2);
  const cached = await get("/dist/main.js",{"Accept-Encoding":"gzip","If-None-Match":String(asset.headers.etag)});
  assert.equal(cached.status,304);
  assert.equal(cached.headers.vary,"Accept-Encoding");
  assert.equal(cached.body.length,0);
  const html = await get("/",{"Accept-Encoding":"gzip"});
  // the page is under the 1 KB gzip threshold, so it may go out plain
  const page = html.headers["content-encoding"] === "gzip" ? gunzipSync(html.body) : html.body;
  assert.match(page.toString(),/nonce="test-nonce"/);
  const head = await get("/dist/main.js",{"Accept-Encoding":"gzip"},"HEAD");
  assert.equal(head.status,200);
  assert.equal(head.body.length,0);
});
test("raw file ranges retain byte offsets and are not compressed",async ()=>{
  const partial = await get("/raw",{"Accept-Encoding":"gzip",Range:"bytes=100-199"});
  assert.equal(partial.status,206);
  assert.equal(partial.headers["content-range"],"bytes 100-199/3000");
  assert.equal(partial.headers["content-encoding"],undefined);
  assert.deepEqual(partial.body,bytes.subarray(100,200));
});
