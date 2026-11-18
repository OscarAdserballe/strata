#!/usr/bin/env node
// node tools/primer-stub.mjs [http://127.0.0.1:8804]: plays the routine for a preview room, which never wakes the real one: each primer asked for gets a sample page, linked with set_primer.
const BASE = (process.argv[2] ?? "http://127.0.0.1:8804").replace(/\/$/, "");
let k = 0, rpc = 0;
const key = () => `primer-stub-${Date.now().toString(36)}-${++k}`;

async function api(path, method = "GET", body) {
  const r = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "Idempotency-Key": key() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(out)}`);
  return out;
}
const { token } = await api("/api/agent/tokens", "POST", { name: "primer stub", write: true });
async function tool(name, args) {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  if (res.isError) throw new Error(`${name}: ${res.content[0].text}`);
  return res.content[0].text;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const page = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>Primer · ${esc(title)}</title>
<style>body{margin:0;background:#fcfbf7;color:#22201c;font:15px/1.5 system-ui,sans-serif}main{max-width:720px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 6px}.k{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#958e84}
.strands{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:16px}
.s{background:#fff;border:1px solid #e6e1d7;border-left:4px solid var(--c);border-radius:8px;padding:10px 12px}</style></head>
<body><main><p class="k">Primer · sample from tools/primer-stub.mjs</p>
<h1 data-strata-id="answer">${esc(title)}: what to follow before page 1</h1>
<p>The real routine reads the source and draws this page its own way. This stub only shows where the page lands and how the two doors work.</p>
<div class="strands"><div class="s" data-strata-id="s1" style="--c:#3d5f91"><b>Strand 1</b><br>The question the source asks.</div>
<div class="s" data-strata-id="s2" style="--c:#2f7a4f"><b>Strand 2</b><br>The move that answers it.</div>
<div class="s" data-strata-id="s3" style="--c:#a65b12"><b>Strand 3</b><br>Where it breaks.</div></div></main></body></html>`;

const { boards } = await api("/api/boards");
let drawn = 0;
for (const b of boards) {
  const { resources } = await api(`/api/boards/${b.id}`);
  for (const r of resources.filter((x) => x.primer?.askedAt)) {
    const title = (r.filename ?? r.title ?? "source").replace(/\.[a-z0-9]+$/i, "");
    let pid = r.primer.id;
    if (!pid) {
      const html = page(title);
      pid = (await api(`/api/boards/${b.id}/resources`, "POST", { filename: `Primer · ${title}.html`, base64: Buffer.from(html).toString("base64") })).id;
    }
    await tool("apply", { board: b.id, key: key(), ops: [{ op: "set_primer", source: `src_${r.id}`, primer: `src_${pid}` }] });
    console.log(`· drew a primer for "${title}" on ${b.title ?? b.id}`);
    drawn++;
  }
}
console.log(drawn ? `${drawn} primer(s) linked. Reload the source: its bar shows "primer".` : "No primers asked for. Press \"make a primer\" in a source's bar first.");
