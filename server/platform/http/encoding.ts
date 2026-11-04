import type { ServerResponse } from "node:http";
import { gzip, constants } from "node:zlib";

export function acceptsGzip(header = ""): boolean {
  let wildcard = false;
  for (const item of header.toLowerCase().split(",")) {
    const [name,...params] = item.trim().split(";");
    const q = params.map(p=>p.trim()).find(p=>p.startsWith("q="));
    const enabled = q === undefined || Number(q.slice(2)) > 0;
    if (name.trim() === "gzip") return enabled;
    if (name.trim() === "*") wildcard = enabled;
  }
  return wildcard;
}

/** Compress large text off the event loop; binary/range responses keep their own path. */
export function sendEncoded(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string,string>): void {
  const text = /^(text\/|application\/(json|javascript)|image\/svg)/.test(headers["Content-Type"] ?? "");
  if (text) headers.Vary = "Accept-Encoding";
  const send = (data: string | Buffer) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status,headers);
    res.end(res.req?.method === "HEAD" ? undefined : data);
  };
  if (!text || Buffer.byteLength(body)<1024 || !acceptsGzip(res.req?.headers["accept-encoding"])) { send(body); return; }
  gzip(body,{level:constants.Z_BEST_SPEED},(error,compressed)=>{
    if (error) { send(body); return; }
    headers["Content-Encoding"] = "gzip";
    send(compressed);
  });
}
